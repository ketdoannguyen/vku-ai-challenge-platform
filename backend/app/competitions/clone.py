"""Create an independent competition draft from verified source files and configuration."""

import csv
import io
import logging
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from bson import ObjectId
from pymongo import ReturnDocument
from pydantic import ValidationError

from app.ai_review import settings as ai_settings
from app.ai_review import url_policy
from app.competitions import service as competitions
from app.content import service as contents
from app.content import storage as files
from app.core.config import get_settings
from app.core.errors import api_error
from app.scoring import csv_validation, models, normalization, revisions
from app.scoring import service as scoring_service
from app.scoring import storage as scoring_files
from app.scoring.errors import ScoringValidationError

logger = logging.getLogger(__name__)


@dataclass
class SourceSnapshot:
    scoring: dict | None
    evaluator_source: str | None
    ground_truth: bytes | None
    ground_truth_metadata: dict | None
    ground_truth_sha256: str | None
    pages: list[tuple[dict, bytes | None]]
    assets: list[tuple[str, bytes]]
    ai_config: dict | None
    normalization: normalization.NormalizationRequest


def _invalid() -> Exception:
    return api_error(409, "CLONE_SOURCE_INVALID", "Dữ liệu cuộc thi nguồn bị thiếu hoặc hỏng; không thể clone đầy đủ.")


async def snapshot(db, source: dict, *, admin_id: ObjectId) -> SourceSnapshot:
    """Read and validate everything before allocating a clone slug or writing any data."""
    settings = get_settings()
    root = files.competition_root(settings.data_dir, str(source["_id"])).resolve()
    data_root = Path(settings.data_dir).resolve()
    scoring = source.get("scoring_config")
    evaluator_source = None
    ground_truth = None
    ground_truth_metadata = None
    ground_truth_sha256 = None
    try:
        if scoring is not None and not isinstance(scoring, dict):
            raise ValueError("Scoring configuration invalid")
        if models.is_v2(source):
            config = models.stored_config(source)
            evaluator = config.evaluator
            if bool(evaluator.source_path) != bool(evaluator.source_sha256):
                raise ValueError("Evaluator metadata incomplete")
            if evaluator.source_path:
                expected = root / "private" / "evaluator" / f"{evaluator.source_sha256}.py"
                if scoring_files.stored_path(evaluator.source_path) != expected:
                    raise ValueError("Evaluator path belongs to another competition")
                raw = scoring_files.read_evaluator_source(evaluator)
                if revisions.sha256_bytes(raw) != evaluator.source_sha256:
                    raise ValueError("Evaluator hash mismatch")
                evaluator_source = raw.decode("utf-8")
            scoring = {
                **config.model_dump(mode="json"),
                "revision": 0,
                "evaluator": {**evaluator.model_dump(mode="json"), "runtime_id": None},
                "verification": None,
            }
        elif scoring is not None:
            parsed = scoring_service.ScoringConfig(**scoring)
            scoring_service.validate_config(parsed)
            scoring = parsed.model_dump()

        if source.get("ground_truth") is not None:
            metadata = source["ground_truth"]
            if not isinstance(metadata, dict):
                raise ValueError("Ground truth metadata invalid")
            path = scoring_files.ground_truth_path(source)
            if path.parent != root / "private" or (
                path.name != "ground_truth.csv"
                and not (
                    models.is_v2(source)
                    and metadata.get("sha256")
                    and path.name == f"ground_truth-{metadata['sha256'][:16]}.csv"
                )
            ):
                raise ValueError("Ground truth path belongs to another competition")
            ground_truth = scoring_files.read_ground_truth(source)
            sha = revisions.sha256_bytes(ground_truth)
            if metadata.get("sha256") and metadata["sha256"] != sha:
                raise ValueError("Ground truth hash mismatch")
            if models.is_v2(source):
                result = csv_validation.load_ground_truth(
                    ground_truth, config.input_schema.ground_truth
                )
            else:
                if scoring is None:
                    raise ValueError("Ground truth has no scoring schema")
                result = scoring_service.load_ground_truth(
                    ground_truth, scoring_service.ScoringConfig(**scoring)
                )
                columns = list(result.columns)
            if metadata.get("row_count") != result.row_count:
                raise ValueError("Ground truth metadata mismatch")
            if models.is_v2(source):
                columns = next(csv.reader(io.StringIO(ground_truth.decode("utf-8-sig"))))
                stored_columns = metadata.get("columns")
                if (
                    not isinstance(stored_columns, list)
                    or not stored_columns
                    or any(not isinstance(column, str) for column in stored_columns)
                    or not set(stored_columns).issubset(columns)
                    or len(stored_columns) != len(set(stored_columns))
                ):
                    raise ValueError("Ground truth metadata mismatch")
            elif metadata.get("columns") != columns:
                raise ValueError("Ground truth metadata mismatch")
            ground_truth_metadata = dict(metadata)
            ground_truth_sha256 = sha

        pages = []
        for page in await contents.list_contents(db, source["_id"]):
            markdown = None
            if page.get("size_bytes") is not None:
                expected_relative = f"competitions/{source['_id']}/content/{page['_id']}.md"
                if page["markdown_path"] != expected_relative:
                    raise ValueError("Markdown path belongs to another competition")
                markdown = files.read_markdown(data_root, page["markdown_path"]).encode("utf-8")
                if len(markdown) != page["size_bytes"]:
                    raise ValueError("Markdown size mismatch")
            pages.append((page, markdown))

        assets = []
        assets_root = files.assets_dir(data_root, str(source["_id"]))
        if assets_root.exists():
            if not assets_root.is_dir() or assets_root.is_symlink():
                raise ValueError("Assets directory invalid")
            for path in sorted(assets_root.iterdir()):
                if path.suffix.lower() not in files.ASSET_TYPES:
                    continue  # Only image assets are served; ignore unrelated temp files.
                if path.is_symlink() or not path.is_file():
                    raise ValueError("Asset invalid")
                raw = files.read_bytes(files.ensure_within(assets_root, path))
                files.validate_asset(path.name, raw)
                assets.append((path.name, raw))

        ai_config = None
        if source.get(ai_settings.CONFIG_FIELD):
            policy = url_policy.policy_from_settings(settings)
            ai_config = ai_settings.snapshot_config(
                source, updated_by=admin_id, now=datetime.now(timezone.utc), policy=policy
            )
        # Clone giữ nguyên luật chuẩn hóa; bản ghi hỏng bị chặn ngay ở preflight.
        normalization_request = normalization.request_of(source)
    except (
        KeyError, OSError, ValueError, TypeError, UnicodeDecodeError, ValidationError,
        ScoringValidationError, ai_settings.SettingsError, url_policy.UrlPolicyError,
        files.ContentFileMissing,
    ) as exc:
        # No source paths, ciphertext or plaintext in response or logs.
        logger.warning("Competition clone preflight rejected source=%s error_type=%s", source["_id"], type(exc).__name__)
        raise _invalid() from None

    return SourceSnapshot(
        scoring, evaluator_source, ground_truth, ground_truth_metadata,
        ground_truth_sha256, pages, assets, ai_config, normalization_request,
    )


async def populate(db, clone: dict, data: SourceSnapshot) -> dict:
    """Write a new clone; on failure remove only the newly allocated document and files."""
    settings = get_settings()
    data_root = Path(settings.data_dir).resolve()
    cid = str(clone["_id"])
    try:
        updates = {}
        if data.scoring is not None:
            scoring = dict(data.scoring)
            if data.evaluator_source is not None:
                scoring["evaluator"] = {
                    **scoring["evaluator"],
                    "source_path": scoring_files.write_evaluator_source(
                        clone, data.evaluator_source, sha256=scoring["evaluator"]["source_sha256"]
                    ),
                }
            updates["scoring_config"] = scoring
        if data.ground_truth is not None:
            if data.scoring and data.scoring.get("version") == 2:
                path = scoring_files.write_ground_truth(
                    clone, data.ground_truth, sha256=data.ground_truth_sha256
                )
            else:
                path_obj = scoring_files.ground_truth_path(clone)
                files.write_atomic(path_obj, data.ground_truth)
                path = path_obj.relative_to(data_root).as_posix()
            updates["ground_truth"] = {**data.ground_truth_metadata, "path": path}
            if data.scoring and data.scoring.get("version") == 2:
                updates["ground_truth"]["sha256"] = data.ground_truth_sha256
        if data.ai_config is not None:
            updates[ai_settings.CONFIG_FIELD] = data.ai_config

        for page, markdown in data.pages:
            copied = await contents.insert_content(
                db, clone["_id"],
                contents.ContentCreate(
                    title=page["title"], slug=page["slug"], order=page["order"],
                ),
            )
            if markdown is not None:
                path = files.content_file_path(data_root, cid, str(copied["_id"]))
                files.write_atomic(path, markdown)
                await db[contents.CONTENTS_COLLECTION].update_one(
                    {"_id": copied["_id"]}, {"$set": {"size_bytes": len(markdown)}}
                )
        for name, raw in data.assets:
            files.write_atomic(files.assets_dir(data_root, cid) / name, raw)

        if updates:
            clone = await db[competitions.COMPETITIONS_COLLECTION].find_one_and_update(
                {"_id": clone["_id"]}, {"$set": updates}, return_document=ReturnDocument.AFTER,
            )
        return clone
    except Exception:
        logger.exception("Competition clone write failed clone=%s", cid)
        # Delete only data allocated for this clone. If cleanup itself fails, log it for operators.
        try:
            await db[contents.CONTENTS_COLLECTION].delete_many({"competition_id": clone["_id"]})
            await db[competitions.COMPETITIONS_COLLECTION].delete_one({"_id": clone["_id"]})
        except Exception:
            logger.exception("Competition clone database cleanup failed clone=%s", cid)
        try:
            shutil.rmtree(files.competition_root(data_root, cid))
        except FileNotFoundError:
            pass
        except OSError:
            logger.exception("Competition clone files cleanup failed clone=%s", cid)
        raise api_error(500, "CLONE_WRITE_FAILED", "Không thể hoàn tất bản sao cuộc thi.") from None
