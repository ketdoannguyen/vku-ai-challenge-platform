"""Trạng thái sẵn sàng chấm điểm - một nguồn sự thật cho publish và cho UI admin.

Publish, banner ở trang admin và endpoint scoring đều đi qua đây. Readiness phải đọc và
parse lại ground truth thật (không chỉ `is_file()`), vì một file hỏng vẫn làm mọi bài
nộp 422 sau khi cuộc thi đã publish. Với bộ chấm v2, cùng lý do đó, readiness còn phải đối chiếu
source trên đĩa với hash đã lưu và đòi một lượt chạy thử còn hiệu lực.
"""

from dataclasses import dataclass

from app.competitions import tracks as competition_tracks
from app.scoring import csv_validation, models, normalization, revisions
from app.scoring import service as scoring_service
from app.scoring import storage as scoring_storage
from app.scoring.errors import ScoringValidationError

_TRACK_LABELS = {competition_tracks.PUBLIC: "Public", competition_tracks.PRIVATE: "Private"}


@dataclass(frozen=True)
class Readiness:
    ready: bool
    code: str | None = None
    message: str | None = None


def check_readiness(competition: dict, track: str | None = None) -> Readiness:
    """Trả lý do chặn đầu tiên theo thứ tự: chuẩn hóa → cấu hình → bộ chấm → ground truth → lượt chạy thử.

    Dual không có một trạng thái sẵn sàng chung: `track` chọn đúng nhánh đang hỏi (thẻ GT trong
    trang quản trị, nộp bài). Bỏ trống `track` trên cuộc thi dual là cổng publish: cả hai nhánh
    phải qua, và lý do chặn nói rõ nhánh nào.
    """
    if not competition_tracks.is_dual(competition):
        return _check_one(competition, None)
    for candidate in ([track] if track is not None else competition_tracks.TRACKS):
        readiness = _check_one(competition, candidate)
        if not readiness.ready:
            label = _TRACK_LABELS.get(candidate, candidate)
            return Readiness(False, readiness.code, f"Nhánh {label}: {readiness.message}")
    return Readiness(True)


def blocked_reason(readiness: Readiness) -> dict | None:
    """Dạng lỗi cho UI: `{"code", "message"}`, hoặc None khi đã sẵn sàng."""
    if readiness.ready:
        return None
    return {"code": readiness.code, "message": readiness.message}


def _check_one(competition: dict, track: str | None) -> Readiness:
    try:
        # Chuẩn hóa hỏng chặn trước tiên: publish xong mới phát hiện thì bảng xếp hạng không dựng
        # được nguồn điểm, còn admin vẫn tưởng cuộc thi đang chạy bình thường.
        normalization.ensure_usable(competition)
    except normalization.NormalizationError as exc:
        return Readiness(False, "NORMALIZATION_CONFIG_INVALID", str(exc))
    try:
        config = models.stored_config(competition)
    except Exception:
        return Readiness(False, "SCORING_CONFIG_INVALID", "Cấu hình chấm điểm không đọc được.")
    if config is not None:
        return _check_v2(competition, config, track)
    return _check_v1(competition, track)


def _check_v1(competition: dict, track: str | None) -> Readiness:
    try:
        config = scoring_service.config_from_competition(competition)
    except Exception:
        config = None
    if config is None:
        return Readiness(
            False, "SCORING_CONFIG_REQUIRED", "Cần cấu hình chấm điểm trước khi xuất bản cuộc thi."
        )
    try:
        scoring_service.validate_config(config)
    except ScoringValidationError as exc:
        return Readiness(False, exc.code, exc.message)

    data = _read_ground_truth(competition, track)
    if isinstance(data, Readiness):
        return data
    try:
        scoring_service.load_ground_truth(data, config)
    except ScoringValidationError as exc:
        return Readiness(False, exc.code, exc.message)
    return Readiness(True)


def _check_v2(competition: dict, config: models.ScoringConfigV2, track: str | None) -> Readiness:
    try:
        models.validate_input_schema(config.input_schema)
        models.validate_evaluator_config(config.evaluator)
        contract = config.output_contract
        # Hợp đồng chưa chọn metric chính vẫn là bản nháp: chấm được nhưng không xếp hạng được, nên
        # publish phải chặn - nếu không, mọi bài nộp sau đó hỏng ở bước lấy điểm chính.
        if contract is None or contract.primary_metric is None:
            return Readiness(
                False, "SCORING_CONFIG_REQUIRED", "Cần khai báo metric và chọn metric chính."
            )
        models.validate_output_contract(contract)
    except ScoringValidationError as exc:
        return Readiness(False, exc.code, exc.message)

    reason = _check_evaluator(config.evaluator)
    if reason is not None:
        return reason

    data = _read_ground_truth(competition, track)
    if isinstance(data, Readiness):
        return data
    try:
        csv_validation.load_ground_truth(data, config.input_schema.ground_truth)
    except ScoringValidationError as exc:
        return Readiness(False, exc.code, exc.message)
    metadata = competition_tracks.track_ground_truth(competition, track) or {}
    stored_sha = metadata.get("sha256")
    if stored_sha and stored_sha != revisions.sha256_bytes(data):
        return Readiness(
            False, "GROUND_TRUTH_INVALID", "Ground truth trên đĩa không khớp bản đã lưu."
        )

    if not verified(competition, config, track=track):
        return Readiness(
            False,
            "SCORING_TEST_REQUIRED",
            "Cần chạy thử bộ chấm với cấu hình hiện tại trước khi xuất bản cuộc thi.",
        )
    return Readiness(True)


def _check_evaluator(evaluator: models.EvaluatorConfig) -> Readiness | None:
    if not evaluator.source_path or not evaluator.source_sha256:
        return Readiness(False, "EVALUATOR_REQUIRED", "Cần lưu source bộ chấm trước khi xuất bản.")
    try:
        source = scoring_storage.read_evaluator_source(evaluator)
    except (KeyError, OSError, ValueError):
        return Readiness(False, "EVALUATOR_REQUIRED", "Source bộ chấm hiện tại không đọc được.")
    if revisions.sha256_bytes(source) != evaluator.source_sha256:
        return Readiness(
            False, "EVALUATOR_REQUIRED", "Source bộ chấm trên đĩa không khớp bản đã lưu."
        )
    return None


def _read_ground_truth(competition: dict, track: str | None) -> bytes | Readiness:
    if not competition_tracks.track_ground_truth(competition, track):
        return Readiness(
            False, "GROUND_TRUTH_REQUIRED", "Cần tải lên ground truth trước khi xuất bản cuộc thi."
        )
    try:
        return scoring_storage.read_ground_truth(competition, track)
    except (KeyError, OSError, ValueError):
        return Readiness(False, "GROUND_TRUTH_INVALID", "Ground truth hiện tại không đọc được.")


def verified(competition: dict, config: models.ScoringConfigV2, track: str | None = None) -> bool:
    """Lượt chạy thử đã lưu còn hiệu lực cho đúng cấu hình đang có hay không.

    Publish gate và banner admin phải trả lời cùng một câu, nên cả hai gọi hàm này. Dual lưu bằng
    chứng theo từng nhánh vì GT của nhánh là một phần dấu vân tay: test Public không xác nhận
    readiness Private.
    """
    return revisions.verification_matches(
        stored_verification(competition, config, track),
        execution=execution_fingerprint(competition, config, track=track),
        contract=config.output_contract,
    )


def stored_verification(
    competition: dict, config: models.ScoringConfigV2 | None, track: str | None
) -> models.Verification | None:
    """Bằng chứng đã lưu của đúng nhánh đang hỏi, đọc an toàn từ document.

    Single đọc trong config; dual đọc `tracks.<t>.verification` - bản đã dump JSON nên phải qua
    model để timestamp trở lại datetime trước khi ai đó định dạng nó. Bản ghi méo trả None thay vì
    làm vỡ endpoint đang đọc.
    """
    if track is None:
        return config.verification if config else None
    raw = (competition_tracks.track_config(competition, track) or {}).get("verification")
    if raw is None:
        return None
    try:
        return models.Verification.model_validate(raw)
    except Exception:
        return None


def execution_fingerprint(competition: dict, config: models.ScoringConfigV2, track: str | None = None) -> str:
    """Vân tay của đúng những đầu vào mà một lượt chấm sẽ dùng."""
    metadata = competition_tracks.track_ground_truth(competition, track) or {}
    return revisions.execution_fingerprint(
        input_schema=config.input_schema,
        source_sha256=config.evaluator.source_sha256,
        ground_truth_sha256=metadata.get("sha256"),
        runtime_id=config.evaluator.runtime_id,
    )
