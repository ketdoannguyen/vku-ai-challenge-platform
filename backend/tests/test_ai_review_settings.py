"""Cấu hình AI theo cuộc thi qua API admin: base URL, xác nhận chuyển dữ liệu, và che secret."""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from bson import ObjectId
from cryptography.fernet import Fernet

from app.ai_review import constants
from app.competitions.service import COMPETITIONS_COLLECTION
from app.core.config import get_settings
from tests.helpers import ADMIN_CREDENTIALS, PARTICIPANT_CREDENTIALS, configure_scoring, login

API_KEY = "sk-live-do-not-leak-me"
HOST = "api.example.com"

VALID_CONFIG = {
    "enabled": True,
    "base_url": f"https://{HOST}/v1",
    "model": "gpt-oss-120b",
    "api_key": API_KEY,
    "acknowledge_transfer": True,
}


@pytest.fixture()
def ai_env(monkeypatch):
    monkeypatch.setenv("LLM_CONFIG_ENCRYPTION_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.setenv("AI_REVIEW_ALLOWED_PORTS", "443")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _competition(client, slug="ai-cup") -> dict:
    now = datetime.now(timezone.utc)
    login(client)
    created = client.post(
        "/api/admin/competitions",
        json={
            "slug": slug,
            "name": slug,
            "start_at": (now - timedelta(days=1)).isoformat(),
            "end_at": (now + timedelta(days=1)).isoformat(),
        },
    )
    assert created.status_code == 201
    return created.json()


def _url(client, competition_id: str) -> str:
    return f"/api/admin/competitions/{competition_id}/ai-review"


def _stored_config(client, competition_id: str) -> dict:
    async def load():
        document = await client.app.state.mongo.db[COMPETITIONS_COLLECTION].find_one(
            {"_id": ObjectId(competition_id)}
        )
        return document.get("ai_review_config") or {}

    return asyncio.run(load())


def test_ai_review_settings_require_an_admin_session(client, ai_env):
    assert client.get(_url(client, "000000000000000000000000")).status_code == 401
    competition = _competition(client)
    login(client, *PARTICIPANT_CREDENTIALS)
    assert client.get(_url(client, competition["id"])).status_code == 403


def test_get_reports_disabled_defaults_and_runtime_flags(client, ai_env):
    competition = _competition(client)
    body = client.get(_url(client, competition["id"])).json()
    assert body["config"] == {
        "enabled": False,
        "auto_review": True,
        "participant_visible": True,
        "provider": "openai_compatible",
        "base_url": "",
        "model": "",
        "api_key_configured": False,
        "acknowledged_host": None,
        "updated_at": None,
    }
    assert body["runtime"] == {"encryption_available": True}
    assert body["content_source"] == {
        "included_count": 0,
        "excluded_count": 0,
        "total_bytes": 0,
        "pages": [],
    }


def test_content_source_lists_included_and_excluded_pages(client, ai_env):
    competition = _competition(client)
    cid = competition["id"]
    problem = client.post(
        f"/api/admin/competitions/{cid}/contents",
        json={"title": "Đề bài", "slug": "problem", "visibility": "public"},
    ).json()["id"]
    client.post(
        f"/api/admin/competitions/{cid}/contents",
        json={"title": "Chưa viết", "slug": "draft", "visibility": "members"},
    )
    uploaded = client.put(
        f"/api/admin/competitions/{cid}/contents/{problem}/file",
        files={"file": ("problem.md", "Thể lệ cuộc thi.".encode(), "text/markdown")},
    )
    assert uploaded.status_code == 200, uploaded.text
    source = client.get(_url(client, cid)).json()["content_source"]
    assert source["included_count"] == 1
    assert source["excluded_count"] == 1
    assert source["total_bytes"] == len("Thể lệ cuộc thi.".encode())
    reasons = {page["slug"]: page["reason"] for page in source["pages"]}
    assert reasons == {"problem": "OK", "draft": "NO_MARKDOWN"}


def test_draft_url_and_model_can_be_saved_while_disabled(client, ai_env):
    competition = _competition(client)
    response = client.put(
        _url(client, competition["id"]),
        json={"base_url": f"https://{HOST}/v1/", "model": "gpt-oss-120b"},
    )
    assert response.status_code == 200, response.text
    config = response.json()["config"]
    assert config["enabled"] is False
    assert config["base_url"] == f"https://{HOST}/v1"
    assert config["model"] == "gpt-oss-120b"


def test_any_public_provider_host_can_be_saved_without_an_allowlist(client, ai_env):
    # Không còn allowlist host: opencode.ai hay bất kỳ provider OpenAI-compatible nào đều lưu được.
    competition = _competition(client)
    response = client.put(
        _url(client, competition["id"]), json={"base_url": "https://opencode.ai/zen/v1"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["config"]["base_url"] == "https://opencode.ai/zen/v1"


def test_url_that_is_not_a_url_is_rejected(client, ai_env):
    competition = _competition(client)
    response = client.put(_url(client, competition["id"]), json={"base_url": "not a url"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == constants.AI_ENDPOINT_INVALID


def test_enabling_without_an_api_key_is_rejected(client, ai_env):
    competition = _competition(client)
    body = {key: value for key, value in VALID_CONFIG.items() if key != "api_key"}
    response = client.put(_url(client, competition["id"]), json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == constants.AI_API_KEY_MISSING


def test_enabling_without_acknowledging_the_transfer_is_rejected(client, ai_env):
    competition = _competition(client)
    body = {key: value for key, value in VALID_CONFIG.items() if key != "acknowledge_transfer"}
    response = client.put(_url(client, competition["id"]), json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == constants.AI_TRANSFER_NOT_ACKNOWLEDGED


def test_missing_master_key_blocks_enabling_but_not_saving_a_draft(
    client, ai_env, monkeypatch
):
    competition = _competition(client)
    monkeypatch.setenv("LLM_CONFIG_ENCRYPTION_KEY", "")
    get_settings.cache_clear()

    assert client.get(_url(client, competition["id"])).json()["runtime"] == {
        "encryption_available": False,
    }
    draft = client.put(
        _url(client, competition["id"]),
        json={"base_url": f"https://{HOST}/v1", "model": "gpt-oss-120b"},
    )
    assert draft.status_code == 200

    enabled = client.put(_url(client, competition["id"]), json=VALID_CONFIG)
    assert enabled.status_code == 422
    assert enabled.json()["error"]["code"] == constants.AI_ENCRYPTION_KEY_MISSING


def test_enabling_with_a_complete_config_stores_only_ciphertext(client, ai_env):
    competition = _competition(client)
    response = client.put(_url(client, competition["id"]), json=VALID_CONFIG)
    assert response.status_code == 200, response.text
    config = response.json()["config"]
    assert config["enabled"] is True
    assert config["api_key_configured"] is True
    assert config["acknowledged_host"] == HOST
    assert "api_key" not in config
    assert API_KEY not in response.text

    stored = _stored_config(client, competition["id"])
    assert stored["api_key_ciphertext"] not in ("", API_KEY)
    assert API_KEY not in str(stored)
    assert stored["transfer_acknowledgement"]["host"] == HOST
    assert stored["transfer_acknowledgement"]["acknowledged_by"] is not None


def test_changing_the_host_invalidates_the_previous_acknowledgement(client, ai_env):
    # Mọi host công khai đều lưu được, nhưng lời xác nhận chuyển dữ liệu chỉ có giá trị cho host đã
    # xác nhận - đây mới là kiểm soát giữ dữ liệu notebook ở đúng chỗ.
    competition = _competition(client)
    assert client.put(_url(client, competition["id"]), json=VALID_CONFIG).status_code == 200

    moved = client.put(
        _url(client, competition["id"]), json={"base_url": "https://api.other.test/v1"}
    )
    assert moved.status_code == 422
    assert moved.json()["error"]["code"] == constants.AI_TRANSFER_NOT_ACKNOWLEDGED

    reacknowledged = client.put(
        _url(client, competition["id"]),
        json={"base_url": "https://api.other.test/v1", "acknowledge_transfer": True},
    )
    assert reacknowledged.status_code == 200
    assert reacknowledged.json()["config"]["acknowledged_host"] == "api.other.test"


def test_empty_api_key_keeps_the_existing_one(client, ai_env):
    competition = _competition(client)
    client.put(_url(client, competition["id"]), json=VALID_CONFIG)
    first = _stored_config(client, competition["id"])["api_key_ciphertext"]

    response = client.put(_url(client, competition["id"]), json={"api_key": ""})
    assert response.status_code == 200
    assert response.json()["config"]["api_key_configured"] is True
    assert _stored_config(client, competition["id"])["api_key_ciphertext"] == first


def test_replacing_the_api_key_rewrites_the_ciphertext(client, ai_env):
    competition = _competition(client)
    client.put(_url(client, competition["id"]), json=VALID_CONFIG)
    first = _stored_config(client, competition["id"])["api_key_ciphertext"]

    response = client.put(_url(client, competition["id"]), json={"api_key": "sk-rotated-value"})
    assert response.status_code == 200
    assert _stored_config(client, competition["id"])["api_key_ciphertext"] != first
    assert "sk-rotated-value" not in response.text


def test_deleting_the_api_key_unsets_it(client, ai_env):
    competition = _competition(client)
    client.put(_url(client, competition["id"]), json=VALID_CONFIG)
    response = client.delete(f"{_url(client, competition['id'])}/api-key")
    assert response.status_code == 200
    assert response.json()["config"]["api_key_configured"] is False
    assert "api_key_ciphertext" not in _stored_config(client, competition["id"])


def test_test_connection_requires_an_admin_session(client, ai_env):
    competition = _competition(client)
    login(client, *PARTICIPANT_CREDENTIALS)
    assert client.post(f"{_url(client, competition['id'])}/test", json={}).status_code == 403


def test_test_connection_without_a_url_is_a_stable_error(client, ai_env):
    competition = _competition(client)
    login(client, *ADMIN_CREDENTIALS)
    response = client.post(f"{_url(client, competition['id'])}/test", json={})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == constants.AI_CONFIG_INCOMPLETE


def test_ai_configuration_never_gates_publishing_or_scoring(client, ai_env):
    """AI là tuỳ chọn: bật AI (thậm chí ở trạng thái chưa sẵn sàng) không được chặn publish."""
    competition = _competition(client)
    assert client.put(_url(client, competition["id"]), json=VALID_CONFIG).status_code == 200
    configure_scoring(client, competition["id"])
    assert client.post(f"/api/admin/competitions/{competition['id']}/publish").status_code == 200
