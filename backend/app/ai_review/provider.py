"""Adapter OpenAI-compatible duy nhất: giao thức `/chat/completions`, không có biến thể Anthropic.

Hai thứ được thực thi ở tầng này chứ không tin caller:

- chính sách mạng được kiểm LẠI ngay trước mỗi request (DNS rebinding không đổi được đích sau lúc lưu);
- redirect không bao giờ được đi theo, và body bị cắt theo số byte thực đọc được chứ không theo header.

`ProviderError.retryable` là nguồn duy nhất quyết định retry: lỗi cấu hình, xác thực, redirect và
output hỏng đều terminal, chỉ lỗi mạng/tải nhất thời mới được thử lại.
"""

import json
import time
from dataclasses import dataclass
from uuid import uuid4

import httpx

from app.ai_review import constants, url_policy
from app.ai_review.url_policy import EndpointPolicy, NormalizedEndpoint

# Prompt thử kết nối: cố định, vô hại, không chứa notebook hay policy của bất kỳ cuộc thi nào.
TEST_SYSTEM_PROMPT = (
    "Bạn là endpoint kiểm tra kết nối. Chỉ trả về một JSON object, không kèm văn bản nào khác."
)
TEST_USER_PROMPT = 'Trả về đúng JSON object sau: {"ok": true}'

# Định danh client gửi kèm MỌI request. Một số gateway OpenAI-compatible đòi client tự giới thiệu và
# có session id mới định tuyến được (opencode.ai trả 400 `MissingSessionID` nếu thiếu), nên hai header
# này đi cùng mọi endpoint thay vì rẽ nhánh theo hostname - rẽ nhánh sẽ dựng lại đúng thứ ADR-037 đã bỏ.
# Giá trị session là định danh MỜ: không bao giờ chứa dữ liệu cuộc thi, thí sinh hay API key.
PROVIDER_USER_AGENT = "vku-ai-challenge/1.0"
PROVIDER_SESSION_HEADER = "x-opencode-session"

# Chỉ ba chỉ số này của `usage` được giữ lại; phần còn lại của body provider không bao giờ được lưu.
_USAGE_FIELDS = ("prompt_tokens", "completion_tokens", "total_tokens")


class ProviderError(Exception):
    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True)
class ChatResult:
    text: str
    latency_ms: int
    usage: dict | None


async def chat_completions(
    client: httpx.AsyncClient,
    *,
    endpoint: NormalizedEndpoint,
    policy: EndpointPolicy,
    api_key: str,
    model: str,
    messages: list[dict],
    max_tokens: int,
    session_id: str,
    settings,
) -> ChatResult:
    """Gọi provider và trả nội dung message đầu tiên; mọi thất bại là `ProviderError`.

    `session_id` phải là định danh mờ, ổn định trong một lượt review: nó đi thẳng vào header nên
    cũng là thứ bên thứ ba nhìn thấy.
    """
    try:
        url_policy.assert_network_allowed(endpoint, policy)
    except url_policy.UrlPolicyError as exc:
        raise ProviderError(exc.code, exc.message, retryable=False)

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0,
        "max_tokens": max_tokens,
        "stream": False,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": PROVIDER_USER_AGENT,
        PROVIDER_SESSION_HEADER: session_id,
    }
    timeout = httpx.Timeout(
        settings.ai_review_request_timeout_seconds,
        connect=settings.ai_review_connect_timeout_seconds,
    )

    started = time.monotonic()
    try:
        async with client.stream(
            "POST",
            endpoint.chat_completions_url,
            json=payload,
            headers=headers,
            timeout=timeout,
            follow_redirects=False,
        ) as response:
            if response.is_redirect:
                # Mọi 3xx là terminal: đi theo là tự nguyện gửi dữ liệu tới một host chưa qua network policy.
                raise ProviderError(
                    constants.AI_PROVIDER_REDIRECT_REJECTED,
                    "Provider trả về redirect.",
                    retryable=False,
                )
            if response.status_code != 200:
                raise _status_error(response.status_code)
            body = await _read_capped(response, settings.ai_review_max_response_bytes)
    except httpx.TimeoutException as exc:
        raise ProviderError(
            constants.AI_CONNECTION_FAILED, "Hết thời gian chờ provider.", retryable=True
        ) from exc
    except httpx.TransportError as exc:
        raise ProviderError(
            constants.AI_CONNECTION_FAILED, "Không kết nối được tới provider.", retryable=True
        ) from exc

    elapsed_ms = int((time.monotonic() - started) * 1000)
    text, usage = _extract(body, max_tokens)
    return ChatResult(text=text, latency_ms=elapsed_ms, usage=usage)


async def test_connection(
    client: httpx.AsyncClient,
    *,
    endpoint: NormalizedEndpoint,
    policy: EndpointPolicy,
    api_key: str,
    model: str,
    settings,
) -> dict:
    """Kiểm tra credentials/model bằng một prompt cố định; không gửi dữ liệu cuộc thi nào."""
    messages = [
        {"role": "system", "content": TEST_SYSTEM_PROMPT},
        {"role": "user", "content": TEST_USER_PROMPT},
    ]
    result = await chat_completions(
        client,
        endpoint=endpoint,
        policy=policy,
        api_key=api_key,
        model=model,
        messages=messages,
        max_tokens=64,
        # Probe là một request đơn độc nên không có run nào để mượn: dùng một UUID mờ mới. Không lấy
        # ID của quản trị viên hay cuộc thi - chúng không cần thiết và không nên rời khỏi hệ thống.
        session_id=uuid4().hex,
        settings=settings,
    )
    _require_json_object(result.text)
    return {
        "ok": True,
        "host": endpoint.host,
        "model": model,
        "latency_ms": result.latency_ms,
    }


def _status_error(status_code: int) -> ProviderError:
    if status_code in (401, 403):
        return ProviderError(
            constants.AI_PROVIDER_UNAUTHORIZED, "Provider từ chối API key.", retryable=False
        )
    if status_code in (400, 404, 422):
        # Provider từ chối chính request - điều đó KHÔNG chứng minh model sai. Vụ thật: gateway trả
        # 400 vì thiếu session header. Suy ra "model sai" từ status code là đoán bừa và đẩy admin đi
        # sửa nhầm chỗ, nên thông báo chỉ nói đúng thứ đã biết (mã HTTP) và nơi cần kiểm.
        return ProviderError(
            constants.AI_PROVIDER_REQUEST_REJECTED,
            f"Provider từ chối yêu cầu (HTTP {status_code}). "
            "Kiểm tra Base URL, model và giao thức /chat/completions.",
            retryable=False,
        )
    if status_code == 429:
        return ProviderError(
            constants.AI_PROVIDER_RATE_LIMITED, "Provider giới hạn tần suất.", retryable=True
        )
    if status_code >= 500:
        return ProviderError(
            constants.AI_PROVIDER_UNAVAILABLE, "Provider đang lỗi.", retryable=True
        )
    return ProviderError(
        constants.AI_PROVIDER_UNAVAILABLE,
        f"Provider trả về mã {status_code}.",
        retryable=False,
    )


async def _read_capped(response: httpx.Response, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > max_bytes:
            raise ProviderError(
                constants.AI_PROVIDER_RESPONSE_TOO_LARGE,
                "Provider trả về body vượt giới hạn.",
                retryable=False,
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _extract(body: bytes, max_tokens: int) -> tuple[str, dict | None]:
    try:
        payload = json.loads(body)
        choice = payload["choices"][0]
        content = choice["message"]["content"]
        # Thiếu `finish_reason` không phải lỗi: nhiều gateway không trả field này.
        finish_reason = choice.get("finish_reason")
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise ProviderError(
            constants.AI_RESPONSE_INVALID,
            "Provider trả về body không đúng hợp đồng.",
            retryable=False,
        ) from exc
    # Kiểm trước `content`: khi hết token, provider có thể trả content rỗng/null, và lúc đó "hết
    # ngân sách" mới là điều cần nói - không phải "body sai hợp đồng".
    if finish_reason == "length":
        raise ProviderError(
            constants.AI_OUTPUT_TRUNCATED,
            f"Model bị cắt vì hết trần output token ({max_tokens}). "
            "Tăng AI_REVIEW_MAX_OUTPUT_TOKENS nếu model cần nhiều hơn.",
            retryable=False,
        )
    if not isinstance(content, str):
        raise ProviderError(
            constants.AI_RESPONSE_INVALID,
            "Provider trả về nội dung không phải chuỗi.",
            retryable=False,
        )
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return content, None
    # Chỉ giữ số token: không lưu bất cứ thứ gì khác provider gắn thêm vào body.
    return content, {
        key: usage[key] for key in _USAGE_FIELDS if isinstance(usage.get(key), int)
    }


def _require_json_object(text: str) -> None:
    """Chỉ xác nhận model trả JSON object; nội dung không được đọc tới nên không trả về."""
    try:
        payload = json.loads(text)
    except ValueError as exc:
        raise ProviderError(
            constants.AI_RESPONSE_INVALID,
            "Model không trả về JSON hợp lệ.",
            retryable=False,
        ) from exc
    if not isinstance(payload, dict):
        raise ProviderError(
            constants.AI_RESPONSE_INVALID,
            "Model không trả về JSON object.",
            retryable=False,
        )
