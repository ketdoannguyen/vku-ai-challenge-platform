"""Biên SSRF: host công khai mặc định được phép, scheme/port, và địa chỉ thật sau khi phân giải DNS."""

import pytest

from app.ai_review import constants, url_policy
from app.ai_review.url_policy import (
    EndpointPolicy,
    UrlPolicyError,
    assert_network_allowed,
    normalize_endpoint,
    parse_host_list,
)


def policy(
    *,
    private=(),
    http=(),
    ports=(443,),
    production=True,
) -> EndpointPolicy:
    return EndpointPolicy(
        allowed_private_hosts=frozenset(private),
        allowed_http_hosts=frozenset(http),
        allowed_ports=frozenset(ports),
        is_production=production,
    )


def test_https_host_normalizes_and_builds_chat_completions_url():
    endpoint = normalize_endpoint("https://api.example.com/v1/", policy())
    assert endpoint.host == "api.example.com"
    assert endpoint.port == 443
    assert endpoint.base_url == "https://api.example.com/v1"
    assert endpoint.chat_completions_url == "https://api.example.com/v1/chat/completions"


def test_any_public_host_is_accepted_without_an_allowlist():
    # Không còn allowlist host: provider OpenAI-compatible bất kỳ dùng được ngay.
    endpoint = normalize_endpoint("https://opencode.ai/zen/v1", policy())
    assert endpoint.host == "opencode.ai"
    assert endpoint.chat_completions_url == "https://opencode.ai/zen/v1/chat/completions"

    other = normalize_endpoint("https://some-other-provider.test/v1", policy())
    assert other.host == "some-other-provider.test"


def test_public_ip_literals_are_accepted_and_ipv6_authority_is_bracketed():
    assert normalize_endpoint("https://93.184.216.34/v1", policy()).base_url == (
        "https://93.184.216.34/v1"
    )
    v6 = normalize_endpoint("https://[2606:2800::1]/v1", policy())
    assert v6.host == "2606:2800::1"
    assert v6.base_url == "https://[2606:2800::1]/v1"
    assert v6.chat_completions_url == "https://[2606:2800::1]/v1/chat/completions"


def test_default_port_is_omitted_and_custom_port_is_kept():
    assert normalize_endpoint("https://api.example.com", policy()).base_url == (
        "https://api.example.com"
    )
    endpoint = normalize_endpoint("https://api.example.com:8443", policy(ports=(8443,)))
    assert endpoint.chat_completions_url == (
        "https://api.example.com:8443/chat/completions"
    )


def test_credentials_query_and_fragment_are_rejected():
    for url in (
        "https://user:pass@api.example.com",
        "https://api.example.com/v1?key=1",
        "https://api.example.com/v1#frag",
    ):
        with pytest.raises(UrlPolicyError) as exc:
            normalize_endpoint(url, policy())
        assert exc.value.code == constants.AI_ENDPOINT_INVALID


def test_non_http_scheme_and_empty_url_are_rejected():
    for url in ("ftp://api.example.com", "file:///etc/passwd", "", "   "):
        with pytest.raises(UrlPolicyError) as exc:
            normalize_endpoint(url, policy())
        assert exc.value.code == constants.AI_ENDPOINT_INVALID


def test_trailing_dot_host_is_rejected_rather_than_silently_normalized():
    with pytest.raises(UrlPolicyError):
        normalize_endpoint("https://api.example.com.", policy())


def test_port_outside_the_operator_allowlist_is_rejected():
    with pytest.raises(UrlPolicyError) as exc:
        normalize_endpoint("https://api.example.com:9000", policy())
    assert exc.value.code == constants.AI_ENDPOINT_INVALID


def test_http_is_allowed_in_development_but_not_in_production_unless_exempted():
    dev = normalize_endpoint("http://api.example.com", policy(production=False, ports=(80,)))
    assert dev.chat_completions_url == "http://api.example.com/chat/completions"

    with pytest.raises(UrlPolicyError) as exc:
        normalize_endpoint("http://api.example.com", policy(ports=(443, 80)))
    assert exc.value.code == constants.AI_INSECURE_ENDPOINT_NOT_ALLOWED

    exempt = normalize_endpoint(
        "http://api.example.com", policy(http=("api.example.com",), ports=(80,))
    )
    assert exempt.scheme == "http"
    assert exempt.chat_completions_url == "http://api.example.com/chat/completions"


def test_private_address_is_rejected_unless_explicitly_exempted(monkeypatch):
    monkeypatch.setattr(url_policy, "resolve_host", lambda host: ["10.0.0.5"])
    endpoint = normalize_endpoint("https://api.example.com", policy())
    with pytest.raises(UrlPolicyError) as exc:
        assert_network_allowed(endpoint, policy())
    assert exc.value.code == constants.AI_PRIVATE_HOST_NOT_ALLOWED

    assert_network_allowed(endpoint, policy(private=("api.example.com",)))


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "::1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "0.0.0.0", "fd00::1"],
)
def test_loopback_private_link_local_and_metadata_addresses_are_blocked(monkeypatch, address):
    monkeypatch.setattr(url_policy, "resolve_host", lambda host: [address])
    endpoint = normalize_endpoint("https://api.example.com", policy())
    with pytest.raises(UrlPolicyError) as exc:
        assert_network_allowed(endpoint, policy())
    assert exc.value.code == constants.AI_PRIVATE_HOST_NOT_ALLOWED


def test_a_public_hostname_resolving_to_a_private_address_is_still_blocked(monkeypatch):
    # Không còn allowlist host nên đây là lớp duy nhất chặn một domain công khai trỏ vào nội bộ.
    monkeypatch.setattr(url_policy, "resolve_host", lambda host: ["169.254.169.254"])
    endpoint = normalize_endpoint("https://metadata.evil.test/v1", policy())
    with pytest.raises(UrlPolicyError) as exc:
        assert_network_allowed(endpoint, policy())
    assert exc.value.code == constants.AI_PRIVATE_HOST_NOT_ALLOWED


def test_any_single_private_answer_in_a_mixed_result_is_enough_to_block(monkeypatch):
    monkeypatch.setattr(url_policy, "resolve_host", lambda host: ["93.184.216.34", "127.0.0.1"])
    endpoint = normalize_endpoint("https://api.example.com", policy())
    with pytest.raises(UrlPolicyError):
        assert_network_allowed(endpoint, policy())


def test_public_address_passes(monkeypatch):
    monkeypatch.setattr(url_policy, "resolve_host", lambda host: ["93.184.216.34", "2606:2800::1"])
    assert_network_allowed(normalize_endpoint("https://api.example.com", policy()), policy())


def test_shared_address_space_is_not_a_public_destination(monkeypatch):
    # 100.64.0.0/10 không được stdlib coi là private, nhưng nó vẫn là mạng của nhà cung cấp.
    monkeypatch.setattr(url_policy, "resolve_host", lambda host: ["100.64.0.1"])
    endpoint = normalize_endpoint("https://api.example.com", policy())
    with pytest.raises(UrlPolicyError) as exc:
        assert_network_allowed(endpoint, policy())
    assert exc.value.code == constants.AI_PRIVATE_HOST_NOT_ALLOWED


def test_unresolvable_host_is_a_connection_error_not_a_policy_error(monkeypatch):
    def boom(host):
        raise UrlPolicyError(constants.AI_CONNECTION_FAILED, "no dns")

    monkeypatch.setattr(url_policy, "resolve_host", boom)
    endpoint = normalize_endpoint("https://api.example.com", policy())
    with pytest.raises(UrlPolicyError) as exc:
        assert_network_allowed(endpoint, policy())
    assert exc.value.code == constants.AI_CONNECTION_FAILED


def test_parse_host_list_normalizes_case_idna_and_ignores_blanks():
    hosts = parse_host_list(" API.Example.com , ,xn--vi-qma.example, ")
    assert hosts == frozenset({"api.example.com", "xn--vi-qma.example"})


def test_a_wildcard_entry_is_just_a_hostname_that_matches_nothing():
    # Hai danh sách exception còn lại vẫn khớp chính xác - một `*` ở đó không mở gì cả.
    assert parse_host_list("*") == frozenset({"*"})


def test_policy_from_settings_reads_every_remaining_policy_field(monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("AI_REVIEW_ALLOWED_PRIVATE_HOSTS", "internal.example.com")
    monkeypatch.setenv("AI_REVIEW_ALLOWED_HTTP_HOSTS", "plain.example.com")
    monkeypatch.setenv("AI_REVIEW_ALLOWED_PORTS", "443,8443")
    get_settings.cache_clear()
    built = url_policy.policy_from_settings(get_settings())
    assert built.allowed_private_hosts == frozenset({"internal.example.com"})
    assert built.allowed_http_hosts == frozenset({"plain.example.com"})
    assert built.allowed_ports == frozenset({443, 8443})
    assert built.is_production is True
