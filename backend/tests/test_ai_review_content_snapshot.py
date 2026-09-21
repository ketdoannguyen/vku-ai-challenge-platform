"""Revision nội dung: bất biến, dedupe theo hash, và không bao giờ lưu một ảnh chụp lai."""

from datetime import datetime, timezone

import pytest
from bson import ObjectId

from app.ai_review import constants, content_snapshot
from app.content.storage import content_file_path
from app.core.config import get_settings

COMPETITION = ObjectId()


async def _seed(
    db,
    tmp_path,
    *,
    title="Đề bài",
    slug="problem",
    order=10,
    visibility="public",
    markdown="Nội dung thể lệ.",
    size_bytes=None,
    content_id=None,
):
    content_id = content_id or ObjectId()
    relative = f"competitions/{COMPETITION}/content/{content_id}.md"
    if markdown is None:
        stored_size = size_bytes
    else:
        path = content_file_path(tmp_path, str(COMPETITION), str(content_id))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(markdown, encoding="utf-8")
        stored_size = len(markdown.encode()) if size_bytes is None else size_bytes
    document = {
        "_id": content_id,
        "competition_id": COMPETITION,
        "title": title,
        "slug": slug,
        "order": order,
        "visibility": visibility,
        "markdown_path": relative,
        "size_bytes": stored_size,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    await db[content_snapshot.CONTENTS_COLLECTION].insert_one(document)
    return content_id


async def _capture(db, tmp_path):
    return await content_snapshot.capture_revision(db, COMPETITION, settings=get_settings())


async def test_pages_follow_display_order_then_id(mock_db, tmp_path):
    last = await _seed(mock_db, tmp_path, slug="c", order=20)
    first = await _seed(mock_db, tmp_path, slug="a", order=5)
    tie_large = await _seed(
        mock_db, tmp_path, slug="b", order=10, content_id=ObjectId("f" * 24)
    )
    tie_small = await _seed(
        mock_db, tmp_path, slug="b0", order=10, content_id=ObjectId("0" * 24)
    )
    revision = await _capture(mock_db, tmp_path)
    assert [page.content_id for page in revision.pages] == [first, tie_small, tie_large, last]


async def test_public_and_members_pages_are_both_part_of_the_policy(mock_db, tmp_path):
    await _seed(mock_db, tmp_path, slug="problem", visibility="public")
    await _seed(mock_db, tmp_path, slug="rules", visibility="members")
    revision = await _capture(mock_db, tmp_path)
    assert revision.page_count == 2
    assert {page.visibility for page in revision.pages} == {"public", "members"}


async def test_page_without_markdown_is_excluded_and_reported(mock_db, tmp_path):
    await _seed(mock_db, tmp_path, slug="problem")
    await _seed(mock_db, tmp_path, title="Nháp", slug="draft", markdown=None)
    revision = await _capture(mock_db, tmp_path)
    assert revision.page_count == 1
    assert [item["slug"] for item in revision.excluded] == ["draft"]
    assert revision.excluded[0]["reason"] == "NO_MARKDOWN"


async def test_metadata_claiming_a_missing_file_fails_the_whole_snapshot(mock_db, tmp_path):
    await _seed(mock_db, tmp_path, slug="problem")
    orphan = await _seed(mock_db, tmp_path, slug="lost")
    content_file_path(tmp_path, str(COMPETITION), str(orphan)).unlink()
    with pytest.raises(content_snapshot.SnapshotError) as exc:
        await _capture(mock_db, tmp_path)
    assert exc.value.code == constants.SNAPSHOT_CONTENT_UNREADABLE


async def test_markdown_that_is_not_utf8_fails_the_snapshot(mock_db, tmp_path):
    await _seed(mock_db, tmp_path, slug="problem")
    broken = await _seed(mock_db, tmp_path, slug="broken")
    content_file_path(tmp_path, str(COMPETITION), str(broken)).write_bytes(b"\xff\xfe\x00bad")
    with pytest.raises(content_snapshot.SnapshotError) as exc:
        await _capture(mock_db, tmp_path)
    assert exc.value.code == constants.SNAPSHOT_CONTENT_UNREADABLE


async def test_competition_without_any_readable_markdown_is_empty(mock_db, tmp_path):
    await _seed(mock_db, tmp_path, slug="draft", markdown=None)
    with pytest.raises(content_snapshot.SnapshotError) as exc:
        await _capture(mock_db, tmp_path)
    assert exc.value.code == constants.SNAPSHOT_CONTENT_EMPTY


async def test_snapshot_over_the_byte_cap_is_refused_not_truncated(
    mock_db, tmp_path, monkeypatch
):
    await _seed(mock_db, tmp_path, slug="a", markdown="x" * 100)
    await _seed(mock_db, tmp_path, slug="b", markdown="y" * 100)
    monkeypatch.setattr(get_settings(), "ai_review_max_snapshot_bytes", 150)
    with pytest.raises(content_snapshot.SnapshotError) as exc:
        await _capture(mock_db, tmp_path)
    assert exc.value.code == constants.SNAPSHOT_CONTENT_TOO_LARGE


async def test_metadata_changing_mid_capture_is_retried_from_scratch(
    mock_db, tmp_path, monkeypatch
):
    await _seed(mock_db, tmp_path, slug="problem")
    real = content_snapshot.read_content_metadata
    calls = {"n": 0}

    async def flaky(db, competition_id):
        calls["n"] += 1
        contents = await real(db, competition_id)
        if calls["n"] == 2:
            return [dict(content, title="Đổi giữa chừng") for content in contents]
        return contents

    monkeypatch.setattr(content_snapshot, "read_content_metadata", flaky)
    revision = await content_snapshot.capture_revision(
        mock_db, COMPETITION, settings=get_settings()
    )
    assert calls["n"] == 4
    assert revision.pages[0].title == "Đề bài"


async def test_content_that_never_settles_fails_after_three_attempts(
    mock_db, tmp_path, monkeypatch
):
    await _seed(mock_db, tmp_path, slug="problem")
    real = content_snapshot.read_content_metadata
    calls = {"n": 0}

    async def always_flaky(db, competition_id):
        calls["n"] += 1
        contents = await real(db, competition_id)
        if calls["n"] % 2 == 0:
            return [dict(content, order=content["order"] + 1) for content in contents]
        return contents

    monkeypatch.setattr(content_snapshot, "read_content_metadata", always_flaky)
    with pytest.raises(content_snapshot.SnapshotError) as exc:
        await content_snapshot.capture_revision(
            mock_db, COMPETITION, settings=get_settings()
        )
    assert exc.value.code == constants.SNAPSHOT_CONTENT_CHANGED
    assert calls["n"] == content_snapshot.MAX_CAPTURE_ATTEMPTS * 2


async def test_identical_content_reuses_the_same_revision(mock_db, tmp_path):
    await _seed(mock_db, tmp_path, slug="problem")
    first = await _capture(mock_db, tmp_path)
    second = await _capture(mock_db, tmp_path)
    assert second.revision_id == first.revision_id
    assert second.content_hash == first.content_hash
    assert first.reused is False
    assert second.reused is True
    assert await mock_db[content_snapshot.REVISIONS_COLLECTION].count_documents({}) == 1


async def test_rename_reorder_and_edit_each_produce_a_new_hash(mock_db, tmp_path):
    content_id = await _seed(mock_db, tmp_path, slug="problem")
    baseline = await _capture(mock_db, tmp_path)

    await mock_db[content_snapshot.CONTENTS_COLLECTION].update_one(
        {"_id": content_id}, {"$set": {"title": "Đề bài mới"}}
    )
    renamed = await _capture(mock_db, tmp_path)

    await mock_db[content_snapshot.CONTENTS_COLLECTION].update_one(
        {"_id": content_id}, {"$set": {"order": 99}}
    )
    reordered = await _capture(mock_db, tmp_path)

    content_file_path(tmp_path, str(COMPETITION), str(content_id)).write_text(
        "Nội dung thể lệ đã sửa.", encoding="utf-8"
    )
    edited = await _capture(mock_db, tmp_path)

    hashes = {
        baseline.content_hash,
        renamed.content_hash,
        reordered.content_hash,
        edited.content_hash,
    }
    assert len(hashes) == 4
    assert await mock_db[content_snapshot.REVISIONS_COLLECTION].count_documents({}) == 4


async def test_editing_content_after_capture_cannot_mutate_the_old_revision(
    mock_db, tmp_path
):
    content_id = await _seed(mock_db, tmp_path, slug="problem")
    captured = await _capture(mock_db, tmp_path)

    content_file_path(tmp_path, str(COMPETITION), str(content_id)).write_text(
        "Nội dung mới.", encoding="utf-8"
    )
    await mock_db[content_snapshot.CONTENTS_COLLECTION].update_one(
        {"_id": content_id},
        {"$set": {"size_bytes": len("Nội dung mới.".encode()), "updated_at": datetime.now(timezone.utc)}},
    )
    fresh = await _capture(mock_db, tmp_path)

    assert fresh.content_hash != captured.content_hash
    stored = await content_snapshot.get_revision(mock_db, COMPETITION, captured.revision_id)
    assert stored["pages"][0]["markdown"] == "Nội dung thể lệ."


async def test_revision_lookup_is_scoped_to_its_competition(mock_db, tmp_path):
    await _seed(mock_db, tmp_path, slug="problem")
    revision = await _capture(mock_db, tmp_path)
    assert await content_snapshot.get_revision(mock_db, COMPETITION, revision.revision_id)
    assert await content_snapshot.get_revision(mock_db, ObjectId(), revision.revision_id) is None


async def test_deleting_a_competition_drops_its_revisions(mock_db, tmp_path):
    await _seed(mock_db, tmp_path, slug="problem")
    await _capture(mock_db, tmp_path)
    await content_snapshot.delete_revisions(mock_db, COMPETITION)
    assert await mock_db[content_snapshot.REVISIONS_COLLECTION].count_documents({}) == 0
