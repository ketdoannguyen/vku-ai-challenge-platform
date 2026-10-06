"""Cấu hình chấm điểm và ground truth riêng tư của admin.

Cùng một endpoint `/scoring` nhận hai đời cấu hình: body v1 (cột cố định, không có `version`) và body
v2 (`version: 2`, có `expected_revision`). Mọi thao tác của v2 phải nói rõ nó dựa trên bản nháp nào,
và backend đối chiếu revision cả trước khi xử lý lẫn lúc ghi, nên hai admin sửa cùng lúc không thể
ghi đè lên nhau.
"""

import logging
from pathlib import Path

from fastapi import APIRouter, File, Form, Request, UploadFile

from app.auth.dependencies import AdminAccount
from app.competitions import service as competitions_service
from app.competitions import tracks as competition_tracks
from app.competitions.admin_router import _get_competition_or_404
from app.content import storage
from app.core.config import get_settings
from app.core.datetimes import iso_z
from app.core.errors import api_error
from app.scoring import (
    contracts,
    csv_validation,
    evaluator_client,
    evaluator_source,
    execution,
    models,
    normalization,
    revisions,
    service,
)
from app.scoring import storage as scoring_storage
from app.scoring.errors import EvaluatorError, ScoringValidationError
from app.scoring.readiness import (
    blocked_reason,
    check_readiness,
    stored_verification,
    verified,
)
from app.submissions.service import has_completed_submission

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/competitions")

REVISION_CONFLICT = "SCORING_REVISION_CONFLICT"
# Lỗi của bộ chấm là lỗi hệ thống chấm; chỉ khi runner không sẵn sàng mới là 503.
UNAVAILABLE_STATUS = 503


@router.get("/{competition_id}/scoring")
async def get_scoring_status(
    competition_id: str, request: Request, admin: AdminAccount
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    return await _scoring_view(db, competition)


@router.put("/{competition_id}/scoring")
async def configure_scoring(
    competition_id: str,
    body: service.ScoringConfig | models.ScoringConfigRequest,
    request: Request,
    admin: AdminAccount,
) -> dict:
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    await _ensure_unlocked(db, competition)
    if isinstance(body, models.ScoringConfigRequest):
        return await _save_v2(db, competition, body, admin)
    return await _save_v1(db, competition, body, admin)


@router.put("/{competition_id}/scoring/result-display")
async def update_result_display(
    competition_id: str,
    body: models.ResultDisplayRequest,
    request: Request,
    admin: AdminAccount,
) -> dict:
    """Sửa cách hiển thị hợp đồng kết quả của cuộc thi đang publish, kể cả sau khi đã có điểm.

    Chỉ tên hiển thị, số thập phân và quyền xem đổi được: khóa metric, metric chính và chiều xếp
    hạng bám theo bộ chấm và điểm đã chấm nên không được diễn giải lại. Đây là đường duy nhất còn
    mở sau khi khóa, nên nó tự kiểm tra trạng thái thay vì đi qua `_ensure_unlocked`.
    """
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    if competition["status"] != "published":
        raise api_error(
            422,
            "SCORING_LOCKED",
            "Chỉ sửa được cách hiển thị metric khi cuộc thi đang publish.",
        )
    config = models.stored_config_or_none(competition)
    contract = config.output_contract if config else None
    if contract is None:
        raise api_error(
            422,
            "SCORING_CONFIG_REQUIRED",
            "Cần khai báo metric trước khi sửa cách hiển thị.",
        )
    _require_revision(config.revision, body.expected_revision)
    if [metric.key for metric in body.metrics] != [metric.key for metric in contract.metrics]:
        raise api_error(
            422,
            "SCORING_LOCKED",
            "Khóa metric do bộ chấm quyết định; chỉ sửa được tên hiển thị, số thập phân và quyền xem.",
        )
    updated_contract = models.OutputContract(
        metrics=body.metrics,
        primary_metric=contract.primary_metric,
        higher_is_better=contract.higher_is_better,
        visible_metrics=body.visible_metrics,
    )
    try:
        models.validate_output_contract(updated_contract)
    except ScoringValidationError as exc:
        raise api_error(422, exc.code, exc.message)

    updated = config.model_copy(
        update={
            "revision": config.revision + 1,
            # Giữ vết xác minh: tập khóa không đổi nên bằng chứng chạy thử còn hiệu lực.
            "output_contract": updated_contract,
        }
    )
    await _update_published_display(
        db,
        competition,
        expected_revision=body.expected_revision,
        sets={"scoring_config": updated.model_dump(mode="json")},
    )
    logger.info(
        "Admin %s edited result display competition=%s", admin["email"], competition["_id"]
    )
    return await _scoring_view(db, await _reload(db, competition))


@router.put("/{competition_id}/ground-truth")
async def upload_ground_truth(
    competition_id: str,
    request: Request,
    admin: AdminAccount,
    file: UploadFile = File(...),
    expected_revision: int | None = Form(None),
    track: str | None = Form(None),
) -> dict:
    if Path(file.filename or "").suffix.lower() != ".csv":
        raise api_error(422, "INVALID_FILE_TYPE", "Chỉ chấp nhận ground truth có đuôi .csv.")
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    track = _resolve_track(competition, track)
    await _ensure_unlocked(db, competition)
    data = await _read_limited(file)
    config_v2 = models.stored_config_or_none(competition)
    if config_v2 is not None:
        _require_revision(config_v2.revision, expected_revision)
        await _store_v2_ground_truth(db, competition, config_v2, data, expected_revision, track, admin)
    else:
        await _store_v1_ground_truth(db, competition, data, track, admin)
    logger.info(
        "Admin %s uploaded ground truth competition=%s track=%s",
        admin["email"],
        competition["_id"],
        track or "single",
    )
    return await _scoring_view(db, await _reload(db, competition))


@router.post("/{competition_id}/scoring/test")
async def test_scoring(
    competition_id: str,
    request: Request,
    admin: AdminAccount,
    file: UploadFile = File(...),
    expected_revision: int | None = Form(None),
    track: str | None = Form(None),
) -> dict:
    """Chạy bộ chấm với ground truth thật và một bài nộp thử của admin.

    Chỉ khi chạy được trọn vẹn và (nếu đã khai báo metric) khớp đúng hợp đồng thì lượt chạy này mới
    được ghi lại làm bằng chứng xác minh - đó là điều kiện publish. Dual ghi bằng chứng theo từng
    nhánh: test Public chỉ xác nhận readiness Public.
    """
    if Path(file.filename or "").suffix.lower() != ".csv":
        raise api_error(422, "INVALID_FILE_TYPE", "Chỉ chấp nhận file submission thử có đuôi .csv.")
    db = request.app.state.mongo.db
    competition = await _get_competition_or_404(db, competition_id)
    track = _resolve_track(competition, track)
    await _ensure_unlocked(db, competition)
    config = models.stored_config_or_none(competition)
    if config is None:
        raise api_error(422, "EVALUATOR_REQUIRED", "Cần lưu cấu hình bộ chấm v2 trước khi chạy thử.")
    _require_revision(config.revision, expected_revision)

    if not config.evaluator.source_path or not config.evaluator.source_sha256:
        # Bản nháp mới có schema chưa có source; nói đúng việc cần làm thay vì lỗi đọc file.
        raise api_error(422, "EVALUATOR_REQUIRED", "Cần lưu source bộ chấm trước khi chạy thử.")
    source = _read_source(config)
    ground_truth_data = _read_ground_truth(competition, track)
    submission_data = await _read_limited(file)
    evaluation = await _run_evaluator(
        competition,
        config,
        source=source,
        ground_truth_data=ground_truth_data,
        submission_data=submission_data,
    )
    observed = sorted(evaluation.metrics)
    await _store_verification(
        db,
        competition,
        config,
        evaluation,
        expected_revision=expected_revision,
        tested_submission_sha256=revisions.sha256_bytes(submission_data),
        ground_truth_data=ground_truth_data,
        track=track,
        admin=admin,
    )
    logger.info(
        "Admin %s test-ran evaluator competition=%s track=%s metrics=%s",
        admin["email"],
        competition["_id"],
        track or "single",
        observed,
    )
    updated = await _reload(db, competition)
    return {
        **await _scoring_view(db, updated),
        "test": {
            "observed_keys": observed,
            "metrics": evaluation.metrics,
            "duration_ms": evaluation.duration_ms,
            "matches_contract": config.output_contract is not None,
        },
    }


def _resolve_track(competition: dict, track: str | None) -> str | None:
    try:
        return competition_tracks.resolve_track(competition, track)
    except competition_tracks.TrackError as exc:
        raise api_error(422, exc.code, exc.message)


async def _save_v1(db, competition: dict, body: service.ScoringConfig, admin: AdminAccount) -> dict:
    # Body v1 trên cuộc thi đã có cấu hình v2 hợp lệ sẽ xoá cấu hình đó và đổi cách chấm của mọi bài
    # nộp sau (bài cũ vẫn giữ metric v2), nên đổi đời cấu hình phải là việc làm có chủ ý, không phải
    # hệ quả của một lượt lưu nhầm shape. Bản v2 hỏng thì vẫn đi được đường này để còn cứu cuộc thi.
    if models.stored_config_or_none(competition) is not None:
        raise api_error(
            422,
            "SCORING_CONFIG_INVALID",
            "Cuộc thi đang dùng bộ chấm Python; không lưu được cấu hình cột cố định của v1.",
        )
    try:
        service.validate_config(body)
        # GT hiện có phải còn đọc được dưới cấu hình mới - kiểm từng bản GT đang có mặt.
        candidates = (
            list(competition_tracks.TRACKS)
            if competition_tracks.is_dual(competition)
            else [None]
        )
        for candidate in candidates:
            if not competition_tracks.track_ground_truth(competition, candidate):
                continue
            try:
                data = scoring_storage.read_ground_truth(competition, candidate)
            except (KeyError, OSError, ValueError):
                raise ScoringValidationError(
                    "GROUND_TRUTH_INVALID", "Ground truth hiện tại không đọc được."
                )
            service.load_ground_truth(data, body)
    except ScoringValidationError as exc:
        raise api_error(422, exc.code, exc.message)

    # Ghi thẳng theo _id (không lọc revision): đây là đường lùi khỏi một cấu hình v2 hỏng, nên
    # không được đòi hỏi gì về bản ghi đang có - chỉ ghim trạng thái đã đọc để một lượt publish
    # xen giữa làm lượt ghi trượt thay vì lặng lẽ đổi cách chấm của cuộc thi đã publish.
    result = await db[competitions_service.COMPETITIONS_COLLECTION].update_one(
        {"_id": competition["_id"], "status": competition["status"]},
        {"$set": {"scoring_config": body.model_dump(), "updated_at": revisions.utc_now()}},
    )
    if result.matched_count == 0:
        raise api_error(
            409,
            REVISION_CONFLICT,
            "Cấu hình đã được thay đổi ở nơi khác, tải lại trang rồi thử lại.",
        )
    logger.info("Admin %s configured scoring competition=%s", admin["email"], competition["_id"])
    return await _scoring_view(db, await _reload(db, competition))


async def _save_v2(
    db,
    competition: dict,
    body: models.ScoringConfigRequest,
    admin: AdminAccount,
) -> dict:
    current = models.stored_config_or_none(competition)
    current_revision = current.revision if current else revisions.INITIAL_REVISION
    _require_revision(current_revision, body.expected_revision)
    try:
        rule = normalization.active_rule(competition)
    except normalization.NormalizationError as exc:
        # Cấu hình norm hỏng thì lượt lưu này không biết mình đang ràng buộc với nguồn nào.
        raise api_error(422, "SCORING_CONFIG_INVALID", str(exc))
    if rule is not None:
        _ensure_source_kept(competition, rule, body.output_contract)
    # Bản nháp lưu được từng bước: schema trước, tên bộ chấm / source / metric sau. Ba thứ đó chỉ là
    # điều kiện publish (readiness giữ), không phải điều kiện của một lượt lưu - nếu không thì
    # "khai định dạng rồi lưu trước khi viết bộ chấm" là bất khả thi.
    try:
        models.validate_input_schema(body.input_schema)
        if body.output_contract is not None:
            models.validate_output_contract(body.output_contract)
    except ScoringValidationError as exc:
        raise api_error(422, exc.code, exc.message)

    source_path = current.evaluator.source_path if current else None
    source_sha256 = current.evaluator.source_sha256 if current else None
    if body.evaluator.source_code is not None:
        try:
            evaluator_source.check_source(body.evaluator.source_code)
        except ScoringValidationError as exc:
            raise api_error(422, exc.code, exc.message)
        source_sha256 = revisions.sha256_bytes(body.evaluator.source_code.encode("utf-8"))
        try:
            source_path = scoring_storage.write_evaluator_source(
                competition, body.evaluator.source_code, sha256=source_sha256
            )
        except OSError:
            logger.exception("Không ghi được source bộ chấm competition=%s", competition["_id"])
            raise api_error(500, "FILE_WRITE_FAILED", "Không thể lưu source bộ chấm.")

    config = models.ScoringConfigV2(
        revision=current_revision + 1,
        input_schema=body.input_schema,
        evaluator=models.EvaluatorConfig(
            name=body.evaluator.name,
            source_path=source_path,
            source_sha256=source_sha256,
            # Môi trường chấm không đổi khi sửa source; lượt chạy thử gần nhất đã ghi lại nó.
            runtime_id=current.evaluator.runtime_id if current else None,
        ),
        output_contract=body.output_contract,
        # Giữ vết xác minh cũ: nó tự hết hiệu lực qua dấu vân tay, và vẫn là dấu vết để đối chiếu.
        verification=current.verification if current else None,
    )
    await _update(
        db,
        competition,
        expected_revision=body.expected_revision,
        sets={"scoring_config": config.model_dump(mode="json")},
        # Cấu hình norm là một phần của luật đang kiểm tra dù đang bật hay tắt: bật nó giữa chừng
        # cũng phải làm lượt ghi trượt, không để draft kẹt ở trạng thái bật norm mà thiếu nguồn điểm.
        guard=normalization.config_guard(competition),
    )
    logger.info("Admin %s configured scoring v2 competition=%s", admin["email"], competition["_id"])
    return await _scoring_view(db, await _reload(db, competition))


def _ensure_source_kept(
    competition: dict, rule: normalization.Rule, contract: models.OutputContract | None
) -> None:
    """Cuộc thi đang bật chuẩn hóa thì metric nguồn và chiều xếp hạng không được rời đi.

    Bản nháp chỉ cần còn metric chính (đổi nguồn tự do vì chưa có điểm nào); cuộc thi đã publish
    thì khóa cả hai - bảng xếp hạng đang chạy trên đúng nguồn đó, kể cả trước bài nộp đầu tiên.
    """
    if contract is None or contract.primary_metric is None:
        raise api_error(
            422,
            "SCORING_CONFIG_REQUIRED",
            "Cuộc thi đang bật chuẩn hóa nên vẫn cần khai báo metric chính.",
        )
    if competition["status"] != "draft" and (
        contract.primary_metric,
        contract.higher_is_better,
    ) != (rule.source_metric, rule.higher_is_better):
        raise api_error(
            422,
            "SCORING_LOCKED",
            "Cuộc thi đang bật chuẩn hóa; không đổi được metric nguồn hoặc chiều xếp hạng sau khi publish.",
        )


def _ground_truth_sets(track: str | None, metadata: dict) -> dict:
    """Metadata GT đi vào đúng chỗ của nhánh; dual không ghi vào field cấp cuộc thi.

    Đổi GT của một nhánh xoá luôn bằng chứng chạy thử của nhánh đó: bằng chứng cũ không còn nói
    về cấu hình đang có, và để nó nằm lại chỉ gây hiểu nhầm trên thẻ GT.
    """
    if track is None:
        return {"ground_truth": metadata}
    return {f"tracks.{track}.ground_truth": metadata, f"tracks.{track}.verification": None}


async def _store_v1_ground_truth(
    db, competition: dict, data: bytes, track: str | None, admin: AdminAccount
) -> None:
    config = service.config_from_competition(competition)
    if config is None:
        raise api_error(
            422,
            "SCORING_CONFIG_REQUIRED",
            "Cần lưu cấu hình chấm điểm trước khi upload ground truth.",
        )
    try:
        ground_truth = service.load_ground_truth(data, config)
    except ScoringValidationError as exc:
        raise api_error(422, exc.code, exc.message)

    if track is None:
        try:
            path = scoring_storage.ground_truth_path(competition)
        except (KeyError, ValueError):
            raise api_error(422, "GROUND_TRUTH_INVALID", "Đường dẫn ground truth không hợp lệ.")
        _write_file(path, data, competition)
        path_value = path.relative_to(Path(get_settings().data_dir).resolve()).as_posix()
        sha256 = None
    else:
        # Nhánh của cuộc thi dual: tên file gắn track + hash, hai bản GT không thể đè nhau.
        sha256 = revisions.sha256_bytes(data)
        try:
            path_value = scoring_storage.write_ground_truth(
                competition, data, sha256=sha256, track=track
            )
        except OSError:
            logger.exception("Không ghi được ground truth competition=%s", competition["_id"])
            raise api_error(500, "FILE_WRITE_FAILED", "Không thể lưu ground truth.")
    metadata = {
        "path": path_value,
        "row_count": ground_truth.row_count,
        "columns": list(ground_truth.columns),
        "uploaded_at": revisions.utc_now(),
        **({"sha256": sha256} if sha256 else {}),
    }
    await db[competitions_service.COMPETITIONS_COLLECTION].update_one(
        {"_id": competition["_id"]},
        {"$set": {**_ground_truth_sets(track, metadata), "updated_at": revisions.utc_now()}},
    )


async def _store_v2_ground_truth(
    db,
    competition: dict,
    config: models.ScoringConfigV2,
    data: bytes,
    expected_revision: int | None,
    track: str | None,
    admin: AdminAccount,
) -> None:
    try:
        ground_truth = csv_validation.load_ground_truth(data, config.input_schema.ground_truth)
    except ScoringValidationError as exc:
        raise api_error(422, exc.code, exc.message)

    sha256 = revisions.sha256_bytes(data)
    try:
        path = scoring_storage.write_ground_truth(competition, data, sha256=sha256, track=track)
    except OSError:
        logger.exception("Không ghi được ground truth competition=%s", competition["_id"])
        raise api_error(500, "FILE_WRITE_FAILED", "Không thể lưu ground truth.")
    metadata = {
        "path": path,
        "row_count": ground_truth.row_count,
        "columns": [column.name for column in config.input_schema.ground_truth.columns],
        "sha256": sha256,
        "uploaded_at": revisions.utc_now(),
    }
    # Ground truth là một phần của dấu vân tay nên lượt chạy thử cũ tự hết hiệu lực.
    updated = config.model_copy(update={"revision": config.revision + 1})
    await _update(
        db,
        competition,
        expected_revision=expected_revision,
        sets={"scoring_config": updated.model_dump(mode="json"), **_ground_truth_sets(track, metadata)},
    )
    logger.info(
        "Admin %s uploaded ground truth v2 competition=%s track=%s",
        admin["email"],
        competition["_id"],
        track or "single",
    )


async def _store_verification(
    db,
    competition: dict,
    config: models.ScoringConfigV2,
    evaluation: execution.Evaluation,
    *,
    expected_revision: int | None,
    tested_submission_sha256: str,
    ground_truth_data: bytes,
    track: str | None,
    admin: AdminAccount,
) -> None:
    metadata = competition_tracks.track_ground_truth(competition, track) or {}
    sets: dict = {}
    if not metadata.get("sha256"):
        # Ground truth tải lên từ đời cấu hình trước: ghim hash ngay tại đây để dấu vân tay đủ đầu vào.
        sets.update(
            _ground_truth_sets(track, {**metadata, "sha256": revisions.sha256_bytes(ground_truth_data)})
        )
    verification = models.Verification(
        state="passed",
        execution_fingerprint=evaluation.execution_fingerprint,
        config_fingerprint=evaluation.config_fingerprint,
        observed_keys=sorted(evaluation.metrics),
        tested_submission_sha256=tested_submission_sha256,
        tested_at=revisions.utc_now(),
        tested_by=admin["email"],
    )
    stored = config.model_copy(
        update={
            # Môi trường đã chạy thật được ghim vào cấu hình; lượt chấm sau so với đúng nó.
            "evaluator": config.evaluator.model_copy(
                update={"runtime_id": evaluation.runtime_id}
            ),
            # Single giữ bằng chứng trong config như cũ; dual lưu theo nhánh vì GT là phần của
            # dấu vân tay nhánh đó.
            "verification": verification if track is None else config.verification,
        }
    )
    sets["scoring_config"] = stored.model_dump(mode="json")
    if track is not None:
        sets[f"tracks.{track}.verification"] = verification.model_dump(mode="json")
    await _update(db, competition, expected_revision=expected_revision, sets=sets)


async def _run_evaluator(
    competition: dict,
    config: models.ScoringConfigV2,
    *,
    source: str,
    ground_truth_data: bytes,
    submission_data: bytes,
) -> execution.Evaluation:
    """Chạy bộ chấm, dịch lỗi sang HTTP; lỗi CSV của bài nộp giữ nguyên mã để admin thấy."""
    try:
        return await execution.evaluate(
            config,
            source=source,
            ground_truth_data=ground_truth_data,
            submission_data=submission_data,
        )
    except ScoringValidationError as exc:
        raise api_error(422, exc.code, exc.message)
    except EvaluatorError as exc:
        logger.info(
            "Bộ chấm lỗi competition=%s code=%s detail=%s",
            competition["_id"],
            exc.code,
            exc.detail,
        )
        status = UNAVAILABLE_STATUS if exc.code == evaluator_client.UNAVAILABLE else 422
        raise api_error(status, exc.code, exc.message, detail=exc.detail)


async def _update(
    db,
    competition: dict,
    *,
    expected_revision: int | None,
    sets: dict,
    guard: dict | None = None,
) -> None:
    """Ghi cấu hình với revision, trạng thái đã đọc và guard thêm (nếu có) ghim tại thời điểm ghi.

    Đọc và ghi không nằm trong một transaction, nên một lượt publish xen giữa phải làm lượt ghi
    trượt (409) thay vì âm thầm áp cấu hình đã được kiểm tra dưới luật cũ.
    """
    result = await db[competitions_service.COMPETITIONS_COLLECTION].update_one(
        {
            **_revision_filter(competition["_id"], expected_revision),
            "status": competition["status"],
            **(guard or {}),
        },
        {"$set": {**sets, "updated_at": revisions.utc_now()}},
    )
    if result.matched_count == 0:
        raise api_error(
            409,
            REVISION_CONFLICT,
            "Cấu hình đã được thay đổi ở nơi khác, tải lại trang rồi thử lại.",
        )


async def _update_published_display(
    db, competition: dict, *, expected_revision: int, sets: dict
) -> None:
    """Ghi cách hiển thị với điều kiện cuộc thi vẫn publish ngay tại thời điểm ghi.

    Đọc và ghi không nằm trong một transaction (Mongo standalone), nên cuộc thi vừa bị đóng giữa
    chừng phải làm lượt ghi trượt thay vì âm thầm sửa một cuộc thi đã đóng.
    """
    result = await db[competitions_service.COMPETITIONS_COLLECTION].update_one(
        {**_revision_filter(competition["_id"], expected_revision), "status": "published"},
        {"$set": {**sets, "updated_at": revisions.utc_now()}},
    )
    if result.matched_count == 0:
        current = await _reload(db, competition)
        if current is None or current["status"] != "published":
            raise api_error(
                422,
                "SCORING_LOCKED",
                "Cuộc thi đã đóng trong lúc lưu; cách hiển thị chỉ sửa được khi đang publish.",
            )
        raise api_error(
            409,
            REVISION_CONFLICT,
            "Cấu hình đã được thay đổi ở nơi khác, tải lại trang rồi thử lại.",
        )


def _revision_filter(competition_id, expected_revision: int | None) -> dict:
    """Điều kiện ghi theo revision; lần lưu đầu tiên nhận cả cuộc thi đang dùng bộ chấm v1."""
    if expected_revision != revisions.INITIAL_REVISION:
        return {"_id": competition_id, "scoring_config.revision": expected_revision}
    return {
        "_id": competition_id,
        "$or": [
            {"scoring_config.revision": revisions.INITIAL_REVISION},
            {"scoring_config": None},
            {"scoring_config.version": {"$ne": 2}},
        ],
    }


def _require_revision(current_revision: int, expected_revision: int | None) -> None:
    if expected_revision is None or expected_revision != current_revision:
        raise api_error(
            409,
            REVISION_CONFLICT,
            "Cấu hình đã được thay đổi ở nơi khác, tải lại trang rồi thử lại.",
        )


async def _scoring_view(db, competition: dict) -> dict:
    config = models.stored_config_or_none(competition)
    # Dùng chung check_readiness với publish gate để UI và backend không lệch nhau.
    readiness = check_readiness(competition)
    ranking = contracts.ranking(competition)
    view = {
        "ready": readiness.ready,
        "not_ready_reason": blocked_reason(readiness),
        "locked": await _is_locked(db, competition),
        "version": 2 if config is not None else 1,
        "config": None if config is not None else _legacy_config(competition),
        "scoring": None if config is None else _v2_view(competition, config),
        "ground_truth": _ground_truth_metadata(competition.get("ground_truth")),
        "primary_metric": ranking[0] if ranking else None,
        "higher_is_better": ranking[1] if ranking else None,
        "result_contract": contracts.contract_payload(competition),
        "quota_per_day": competition.get("quota_per_day"),
        "max_upload_mb": get_settings().max_upload_mb,
        "source_limit_kb": models.MAX_SOURCE_BYTES // 1024,
    }
    if competition_tracks.is_dual(competition):
        # Bộ chấm là của chung; GT, bằng chứng và readiness tách theo nhánh.
        view["mode"] = competition_tracks.MODE_DUAL
        view["tracks"] = {
            track: _track_scoring_view(competition, config, track)
            for track in competition_tracks.TRACKS
        }
    return view


def _track_scoring_view(competition: dict, config: models.ScoringConfigV2 | None, track: str) -> dict:
    readiness = check_readiness(competition, track=track)
    return {
        "ground_truth": _ground_truth_metadata(
            competition_tracks.track_ground_truth(competition, track)
        ),
        "ready": readiness.ready,
        "not_ready_reason": blocked_reason(readiness),
        "verified": bool(config is not None and verified(competition, config, track=track)),
        "verification": _verification_payload(stored_verification(competition, config, track)),
    }


def _v2_view(competition: dict, config: models.ScoringConfigV2) -> dict:
    if competition_tracks.is_dual(competition):
        # Bằng chứng của dual nằm theo từng nhánh (xem `tracks`); ở cấp chung chỉ trả trạng thái tổng.
        return {
            "revision": config.revision,
            "input_schema": config.input_schema.model_dump(mode="json"),
            "evaluator": _evaluator_view(config),
            "output_contract": (
                config.output_contract.model_dump(mode="json") if config.output_contract else None
            ),
            "verified": all(
                verified(competition, config, track=track)
                for track in competition_tracks.TRACKS
            ),
            "verification": None,
        }
    return {
        "revision": config.revision,
        "input_schema": config.input_schema.model_dump(mode="json"),
        "evaluator": _evaluator_view(config),
        "output_contract": (
            config.output_contract.model_dump(mode="json") if config.output_contract else None
        ),
        "verified": verified(competition, config),
        "verification": _verification_payload(config.verification),
    }


def _evaluator_view(config: models.ScoringConfigV2) -> dict:
    return {
        "name": config.evaluator.name,
        "source_sha256": config.evaluator.source_sha256,
        "runtime_id": config.evaluator.runtime_id,
        "source_code": _read_source(config, required=False),
    }


def _verification_payload(verification: models.Verification | None) -> dict | None:
    """Bằng chứng chạy thử ở dạng API; model đã qua `stored_verification` nên timestamp là datetime."""
    if verification is None:
        return None
    return {
        "tested_at": iso_z(verification.tested_at) if verification.tested_at else None,
        "tested_by": verification.tested_by,
        "observed_keys": verification.observed_keys,
        "execution_fingerprint": verification.execution_fingerprint,
        "config_fingerprint": verification.config_fingerprint,
    }


def _read_source(config: models.ScoringConfigV2, *, required: bool = True) -> str:
    try:
        return scoring_storage.read_evaluator_source(config.evaluator).decode("utf-8")
    except (KeyError, OSError, ValueError, UnicodeDecodeError):
        if required:
            raise api_error(422, "EVALUATOR_REQUIRED", "Source bộ chấm hiện tại không đọc được.")
        return ""


def _read_ground_truth(competition: dict, track: str | None) -> bytes:
    try:
        return scoring_storage.read_ground_truth(competition, track)
    except (KeyError, OSError, ValueError):
        raise api_error(
            422, "GROUND_TRUTH_REQUIRED", "Cần tải lên ground truth trước khi chạy thử."
        )


def _write_file(path: Path, data: bytes, competition: dict) -> None:
    try:
        storage.write_atomic(path, data)
    except OSError:
        logger.exception("Không ghi được ground truth competition=%s", competition["_id"])
        raise api_error(500, "FILE_WRITE_FAILED", "Không thể lưu ground truth.")


async def _reload(db, competition: dict) -> dict:
    return await db[competitions_service.COMPETITIONS_COLLECTION].find_one(
        {"_id": competition["_id"]}
    )


def _legacy_config(competition: dict) -> dict | None:
    try:
        config = service.config_from_competition(competition)
    except Exception:
        return None
    return config.model_dump() if config else None


async def _ensure_unlocked(db, competition: dict) -> None:
    if await _is_locked(db, competition):
        raise api_error(
            422,
            "SCORING_LOCKED",
            "Không thể đổi cấu hình hoặc ground truth sau khi cuộc thi đã đóng hoặc có điểm.",
        )


async def _is_locked(db, competition: dict) -> bool:
    if competition_tracks.is_dual(competition):
        # Dual khóa cấu hình chấm và cả hai GT ngay tại lượt publish; mở lại không gỡ khóa.
        # Không cho chạy Public trước rồi nạp GT Private khi cuộc thi đã chạy.
        return competition.get("scoring_locked_at") is not None
    return competition["status"] == "closed" or await has_completed_submission(
        db, competition["_id"]
    )


async def _read_limited(file: UploadFile) -> bytes:
    limit_mb = get_settings().max_upload_mb
    data = await file.read(limit_mb * 1024 * 1024 + 1)
    if len(data) > limit_mb * 1024 * 1024:
        raise api_error(413, "FILE_TOO_LARGE", f"File vượt quá giới hạn {limit_mb} MiB.")
    return data


def _ground_truth_metadata(metadata: dict | None) -> dict | None:
    if metadata is None:
        return None
    return {
        "row_count": metadata["row_count"],
        "columns": metadata["columns"],
        "uploaded_at": iso_z(metadata["uploaded_at"]),
    }
