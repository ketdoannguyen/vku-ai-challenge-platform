"""Chính sách URL/network cho endpoint LLM - biên SSRF của tính năng AI.

Ba lớp, áp dụng ở cả lúc lưu cấu hình, lúc test connection và NGAY TRƯỚC mỗi lần worker gọi provider:

1. Cú pháp: chỉ http/https, không credential/query/fragment, port nằm trong danh sách cho phép.
2. Đích đến: host phải khớp CHÍNH XÁC một entry allowlist do vận hành kiểm soát. Không wildcard,
   không khớp subdomain - mỗi đích nhận dữ liệu notebook phải được một người phê duyệt tường minh.
3. Địa chỉ thật: mọi IP mà DNS phân giải ra phải là địa chỉ công khai, trừ khi host nằm rõ trong
   danh sách private exception.

Không có bước nào tự bỏ qua khi allowlist rỗng: allowlist rỗng chỉ đơn giản là không host nào khớp,
nên AI không bật được trong khi phần còn lại của hệ thống chạy bình thường.
"""

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

from app.ai_review import constants

CHAT_COMPLETIONS_PATH = "chat/completions"
_DEFAULT_PORTS = {"https": 443, "http": 80}
# Dải địa chỉ chia sẻ 100.64.0.0/10: không `is_private` theo stdlib nhưng cũng không công khai.
_SHARED_ADDRESS_SPACE = ipaddress.ip_network("100.64.0.0/10")


class UrlPolicyError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class EndpointPolicy:
    """Ảnh chụp allowlist của vận hành tại thời điểm kiểm tra."""

    allowed_hosts: frozenset[str]
    allowed_private_hosts: frozenset[str]
    allowed_http_hosts: frozenset[str]
    allowed_ports: frozenset[int]
    is_production: bool


@dataclass(frozen=True)
class NormalizedEndpoint:
    base_url: str
    chat_completions_url: str
    scheme: str
    host: str
    port: int


def parse_host_list(value: str) -> frozenset[str]:
    """Danh sách phân tách bằng dấu phẩy; mỗi entry được chuẩn hoá về hostname lowercase."""
    hosts = set()
    for raw in (value or "").split(","):
        item = raw.strip()
        if not item:
            continue
        normalized = _normalize_host(item, constants.AI_HOST_NOT_ALLOWED, item)
        hosts.add(normalized)
    return frozenset(hosts)


def parse_port_list(value: str) -> frozenset[int]:
    ports = set()
    for raw in (value or "").split(","):
        item = raw.strip()
        if not item:
            continue
        try:
            port = int(item)
        except ValueError:
            raise UrlPolicyError(constants.AI_ENDPOINT_INVALID, "Port trong allowlist không hợp lệ.")
        if not 1 <= port <= 65535:
            raise UrlPolicyError(constants.AI_ENDPOINT_INVALID, "Port trong allowlist không hợp lệ.")
        ports.add(port)
    return frozenset(ports)


def policy_from_settings(settings) -> EndpointPolicy:
    return EndpointPolicy(
        allowed_hosts=parse_host_list(settings.ai_review_allowed_hosts),
        allowed_private_hosts=parse_host_list(settings.ai_review_allowed_private_hosts),
        allowed_http_hosts=parse_host_list(settings.ai_review_allowed_http_hosts),
        allowed_ports=parse_port_list(settings.ai_review_allowed_ports),
        is_production=settings.is_production,
    )


def normalize_endpoint(base_url: str, policy: EndpointPolicy) -> NormalizedEndpoint:
    """Chuẩn hoá + kiểm tra cú pháp và allowlist; raise `UrlPolicyError` với mã lỗi ổn định."""
    raw = (base_url or "").strip()
    if not raw:
        raise UrlPolicyError(constants.AI_ENDPOINT_INVALID, "Base URL không được để trống.")

    parsed = urlsplit(raw)
    scheme = parsed.scheme.lower()
    if scheme not in _DEFAULT_PORTS:
        raise UrlPolicyError(
            constants.AI_ENDPOINT_INVALID, "Base URL phải bắt đầu bằng http:// hoặc https://."
        )
    if parsed.username or parsed.password:
        raise UrlPolicyError(
            constants.AI_ENDPOINT_INVALID, "Base URL không được chứa thông tin đăng nhập."
        )
    if parsed.query or parsed.fragment:
        raise UrlPolicyError(
            constants.AI_ENDPOINT_INVALID, "Base URL không được chứa query hoặc fragment."
        )

    host = _normalize_host(parsed.hostname or "", constants.AI_ENDPOINT_INVALID, "")
    try:
        port = parsed.port or _DEFAULT_PORTS[scheme]
    except ValueError:
        raise UrlPolicyError(constants.AI_ENDPOINT_INVALID, "Port của Base URL không hợp lệ.")

    if host not in policy.allowed_hosts:
        raise UrlPolicyError(
            constants.AI_HOST_NOT_ALLOWED,
            f"Host '{host}' chưa được vận hành cho phép.",
        )
    if port not in policy.allowed_ports:
        raise UrlPolicyError(
            constants.AI_HOST_NOT_ALLOWED, f"Port {port} chưa được vận hành cho phép."
        )
    if scheme == "http" and policy.is_production and host not in policy.allowed_http_hosts:
        raise UrlPolicyError(
            constants.AI_INSECURE_ENDPOINT_NOT_ALLOWED,
            "Production chỉ cho phép endpoint HTTPS.",
        )

    path = parsed.path.rstrip("/")
    base = f"{scheme}://{_authority(host, port, scheme)}{path}"
    return NormalizedEndpoint(
        base_url=base,
        chat_completions_url=f"{base}/{CHAT_COMPLETIONS_PATH}",
        scheme=scheme,
        host=host,
        port=port,
    )


def assert_network_allowed(endpoint: NormalizedEndpoint, policy: EndpointPolicy) -> None:
    """Kiểm tra địa chỉ thật: mọi IP phân giải ra phải công khai, trừ private exception tường minh.

    Gọi lại ngay trước mỗi request thật để DNS rebinding không đổi đích sau lúc lưu cấu hình.
    """
    if endpoint.host in policy.allowed_private_hosts:
        return
    for address in resolve_host(endpoint.host):
        if not _is_public_address(address):
            raise UrlPolicyError(
                constants.AI_PRIVATE_HOST_NOT_ALLOWED,
                f"Host '{endpoint.host}' trỏ tới địa chỉ nội bộ.",
            )


def resolve_host(host: str) -> list[str]:
    """Tách riêng để test thay được DNS mà không cần mạng thật."""
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise UrlPolicyError(
            constants.AI_CONNECTION_FAILED, f"Không phân giải được host '{host}'."
        )
    return [info[4][0] for info in infos]


def _is_public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if ip.version == 4 and ip in _SHARED_ADDRESS_SPACE:
        # 100.64.0.0/10 (CGNAT) không được `is_private` coi là private, nhưng nó vẫn nằm trong mạng
        # của nhà cung cấp chứ không phải Internet - gọi tới đó là rời khỏi đích công khai.
        return False
    return not (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_unspecified
        or ip.is_reserved
    )


def _authority(host: str, port: int, scheme: str) -> str:
    """Bỏ port mặc định cho URL gọn, giữ port lạ để URL ghép ra đúng thứ đã cấu hình."""
    return host if port == _DEFAULT_PORTS[scheme] else f"{host}:{port}"


def _normalize_host(host: str, code: str, original: str) -> str:
    candidate = (host or "").strip()
    # `example.com.` và `example.com` phân giải giống hệt nhau nhưng so chuỗi lại khác: một allowlist
    # khớp theo chuỗi không được phép có hai cách viết cùng một đích.
    if not candidate or candidate.endswith("."):
        raise UrlPolicyError(code, f"Host '{original or host}' không hợp lệ.")
    try:
        # IDNA cho tên miền quốc tế; `ip_address` cho IP literal (idna codec không nhận IP).
        ipaddress.ip_address(candidate)
    except ValueError:
        try:
            return candidate.encode("idna").decode("ascii").lower()
        except (UnicodeError, ValueError):
            raise UrlPolicyError(code, f"Host '{original or host}' không hợp lệ.")
    return candidate.lower()
