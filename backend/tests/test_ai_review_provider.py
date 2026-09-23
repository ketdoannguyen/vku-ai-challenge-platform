"""Provider OpenAI-compatible: payload, ánh xạ lỗi, trần body, và redirect không bao giờ được đi theo."""

import json

import httpx
import pytest

from app.ai_review import constants, provider, url_policy
from app.ai_review.url_policy import EndpointPolicy
from app.core.config import get_settings

ENDPOINT_URL = "https://api.example.com/v1/chat/completions"
SESSION_ID = "run-abc123"

POLICY = EndpointPolicy(
    allowed_private_hosts=frozenset(),
    allowed_http_hosts=frozenset(),
    allowed_ports=frozenset({443}),
    is_production=True,
)

MESSAGES = [{"role": "system", "content": "system"}, {"role": "user", "content": "user"}]


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    monkeypatch.setattr(url_policy, "resolve_host", lambda host: ["93.184.216.34"])


@pytest.fixture()
def endpoint():
    return url_policy.normalize_endpoint("https://api.example.com/v1", POLICY)


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def _call(client, endpoint, **overrides):
    options = {
        "endpoint": endpoint,
        "policy": POLICY,
        "api_key": "sk-test",
        "model": "gpt-oss-120b",
        "messages": MESSAGES,
        "max_tokens": 64,
        "session_id": SESSION_ID,
        "settings": get_settings(),
    }
    options.update(overrides)
    return await provider.chat_completions(client, **options)


def _ok(text: str = '{"verdict": "CLEAR"}') -> httpx.Response:
    return httpx.Response(
        200,
        json={"choices": [{"message": {"content": text}, "finish_reason": "stop"}]},
    )


async def test_successful_call_returns_content_and_sends_a_deterministic_payload(endpoint):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["user_agent"] = request.headers["user-agent"]
        seen["session"] = request.headers[provider.PROVIDER_SESSION_HEADER]
        seen["body"] = json.loads(request.content)
        return _ok("nội dung model")

    async with _client(handler) as client:
        result = await _call(client, endpoint)

    assert result.text == "nội dung model"
    assert result.latency_ms >= 0
    assert seen["url"] == ENDPOINT_URL
    assert seen["auth"] == "Bearer sk-test"
    # Gateway OpenAI-compatible có thể đòi định danh client; gửi cho mọi host thay vì special-case.
    assert seen["user_agent"] == provider.PROVIDER_USER_AGENT
    assert seen["session"] == SESSION_ID
    assert seen["body"] == {
        "model": "gpt-oss-120b",
        "messages": MESSAGES,
        "temperature": 0,
        "max_tokens": 64,
        "stream": False,
    }


@pytest.mark.parametrize(
    ("status", "code", "retryable"),
    [
        (301, constants.AI_PROVIDER_REDIRECT_REJECTED, False),
        (302, constants.AI_PROVIDER_REDIRECT_REJECTED, False),
        (401, constants.AI_PROVIDER_UNAUTHORIZED, False),
        (403, constants.AI_PROVIDER_UNAUTHORIZED, False),
        (400, constants.AI_PROVIDER_REQUEST_REJECTED, False),
        (404, constants.AI_PROVIDER_REQUEST_REJECTED, False),
        (422, constants.AI_PROVIDER_REQUEST_REJECTED, False),
        (429, constants.AI_PROVIDER_RATE_LIMITED, True),
        (500, constants.AI_PROVIDER_UNAVAILABLE, True),
        (503, constants.AI_PROVIDER_UNAVAILABLE, True),
        (418, constants.AI_PROVIDER_UNAVAILABLE, False),
    ],
)
async def test_status_codes_map_to_stable_codes_with_the_right_retry_flag(
    endpoint, status, code, retryable
):
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(status, headers={"location": "https://elsewhere.test/"})

    async with _client(handler) as client:
        with pytest.raises(provider.ProviderError) as exc:
            await _call(client, endpoint)

    assert exc.value.code == code
    assert exc.value.retryable is retryable
    # Redirect không bao giờ được đi theo: đúng một request tới đúng host đã được duyệt.
    assert calls["n"] == 1


async def test_a_rejected_request_is_not_reported_as_an_invalid_model(endpoint):
    """400 `MissingSessionID` của opencode.ai từng bị gán thành "model sai" - chẩn đoán ngược lại
    nguyên nhân, nên admin đi sửa đúng cái không hỏng."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "type": "error",
                "error": {
                    "type": "MissingSessionID",
                    "message": "Request is missing x-opencode-session and cannot be routed.",
                },
            },
        )

    async with _client(handler) as client:
        with pytest.raises(provider.ProviderError) as exc:
            await _call(client, endpoint)

    assert exc.value.code == constants.AI_PROVIDER_REQUEST_REJECTED
    assert exc.value.retryable is False
    # Body upstream không bao giờ được đọc tới, nên nó không thể lọt vào message hay audit row.
    assert "MissingSessionID" not in exc.value.message
    assert "x-opencode-session" not in exc.value.message


async def test_response_body_larger_than_the_cap_is_refused(endpoint, monkeypatch):
    monkeypatch.setattr(get_settings(), "ai_review_max_response_bytes", 16)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 64)

    async with _client(handler) as client:
        with pytest.raises(provider.ProviderError) as exc:
            await _call(client, endpoint)
    assert exc.value.code == constants.AI_PROVIDER_RESPONSE_TOO_LARGE
    assert exc.value.retryable is False


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b'{"choices": []}',
        b'{"choices": [{"message": {}}]}',
        b'{"choices": [{"message": {"content": 42}}]}',
    ],
)
async def test_malformed_provider_bodies_are_invalid_responses(endpoint, body):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body)

    async with _client(handler) as client:
        with pytest.raises(provider.ProviderError) as exc:
            await _call(client, endpoint)
    assert exc.value.code == constants.AI_RESPONSE_INVALID
    assert exc.value.retryable is False


async def test_an_output_cut_off_by_the_token_cap_is_its_own_error(endpoint):
    """Vụ thật: deepseek-v4.1-flash cần 3412 token cho một notebook nhỏ, trần đang là 2500, nên JSON
    đứt giữa chuỗi. Lượt đó bị báo thành `AI_RESPONSE_INVALID` - đúng loại lỗi nhưng giấu mất nguyên
    nhân, và giấu luôn việc thử lại y nguyên request sẽ hỏng y nguyên."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {"content": '{"verdict": "FLAGGED", "summary": "Notebook vi phạm'},
                        "finish_reason": "length",
                    }
                ]
            },
        )

    async with _client(handler) as client:
        with pytest.raises(provider.ProviderError) as exc:
            await _call(client, endpoint, max_tokens=2_500)

    assert exc.value.code == constants.AI_OUTPUT_TRUNCATED
    assert exc.value.retryable is False
    # Thông báo phải chỉ được vào chỗ sửa (trần token), không chở theo nội dung model đã sinh.
    assert "2500" in exc.value.message
    assert "AI_REVIEW_MAX_OUTPUT_TOKENS" in exc.value.message
    assert "Notebook vi phạm" not in exc.value.message


async def test_transport_failures_are_retryable_connection_errors(endpoint):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    async with _client(handler) as client:
        with pytest.raises(provider.ProviderError) as exc:
            await _call(client, endpoint)
    assert exc.value.code == constants.AI_CONNECTION_FAILED
    assert exc.value.retryable is True


async def test_endpoint_resolving_to_a_private_address_never_reaches_the_network(
    endpoint, monkeypatch
):
    monkeypatch.setattr(url_policy, "resolve_host", lambda host: ["127.0.0.1"])
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return _ok()

    async with _client(handler) as client:
        with pytest.raises(provider.ProviderError) as exc:
            await _call(client, endpoint)
    assert exc.value.code == constants.AI_PRIVATE_HOST_NOT_ALLOWED
    assert exc.value.retryable is False
    assert calls["n"] == 0


async def test_connection_test_returns_redacted_metadata(endpoint):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        seen["user_agent"] = request.headers["user-agent"]
        seen["session"] = request.headers[provider.PROVIDER_SESSION_HEADER]
        return _ok('{"ok": true}')

    async with _client(handler) as client:
        result = await provider.test_connection(
            client,
            endpoint=endpoint,
            policy=POLICY,
            api_key="sk-test",
            model="gpt-oss-120b",
            settings=get_settings(),
        )

    assert result == {
        "ok": True,
        "host": "api.example.com",
        "model": "gpt-oss-120b",
        "latency_ms": result["latency_ms"],
    }
    # Prompt thử kết nối là cố định và không chứa dữ liệu cuộc thi nào.
    assert "sk-test" not in json.dumps(seen["body"])
    assert seen["body"]["messages"][1]["content"] == provider.TEST_USER_PROMPT
    # Probe cũng phải tự giới thiệu (opencode.ai từ chối request không có session), nhưng định danh
    # chỉ là một UUID mờ: không mang competition/account/key nào.
    assert seen["user_agent"] == provider.PROVIDER_USER_AGENT
    assert seen["session"] != ""
    assert "sk-test" not in seen["session"]


async def test_connection_test_rejects_a_model_that_does_not_answer_json(endpoint):
    def handler(request: httpx.Request) -> httpx.Response:
        return _ok("Xin chào, tôi là một trợ lý.")

    async with _client(handler) as client:
        with pytest.raises(provider.ProviderError) as exc:
            await provider.test_connection(
                client,
                endpoint=endpoint,
                policy=POLICY,
                api_key="sk-test",
                model="gpt-oss-120b",
                settings=get_settings(),
            )
    assert exc.value.code == constants.AI_RESPONSE_INVALID
