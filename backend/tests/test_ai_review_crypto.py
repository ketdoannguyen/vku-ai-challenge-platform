"""Fernet: vòng lặp mã hoá, khoá sai/thiếu, ciphertext bị sửa, và không rò rỉ ra log."""

import logging

import pytest
from cryptography.fernet import Fernet

from app.ai_review import constants, crypto
from app.core.config import get_settings

PLAINTEXT = "sk-live-very-secret-value"


@pytest.fixture()
def master_key(monkeypatch):
    key = Fernet.generate_key().decode("ascii")
    monkeypatch.setenv("LLM_CONFIG_ENCRYPTION_KEY", key)
    get_settings.cache_clear()
    yield key
    get_settings.cache_clear()


def test_roundtrip_returns_original_plaintext(master_key):
    token = crypto.encrypt_secret(PLAINTEXT)
    assert token != PLAINTEXT
    assert crypto.decrypt_secret(token) == PLAINTEXT


def test_encryption_available_tracks_key_validity(master_key):
    assert crypto.encryption_available() is True


def test_missing_master_key_is_reported_but_does_not_explode(monkeypatch):
    monkeypatch.setenv("LLM_CONFIG_ENCRYPTION_KEY", "")
    get_settings.cache_clear()
    assert crypto.encryption_available() is False
    with pytest.raises(crypto.CryptoError) as exc:
        crypto.encrypt_secret(PLAINTEXT)
    assert exc.value.code == constants.AI_ENCRYPTION_KEY_MISSING


def test_malformed_master_key_is_treated_as_missing(monkeypatch):
    monkeypatch.setenv("LLM_CONFIG_ENCRYPTION_KEY", "not-a-fernet-key")
    get_settings.cache_clear()
    assert crypto.encryption_available() is False
    with pytest.raises(crypto.CryptoError) as exc:
        crypto.decrypt_secret("whatever")
    assert exc.value.code == constants.AI_ENCRYPTION_KEY_MISSING


def test_decrypting_with_a_rotated_key_fails_closed(monkeypatch):
    monkeypatch.setenv("LLM_CONFIG_ENCRYPTION_KEY", Fernet.generate_key().decode("ascii"))
    get_settings.cache_clear()
    token = crypto.encrypt_secret(PLAINTEXT)
    # Đổi master key: ciphertext cũ không còn giải mã được, và điều đó phải là lỗi tường minh.
    monkeypatch.setenv("LLM_CONFIG_ENCRYPTION_KEY", Fernet.generate_key().decode("ascii"))
    get_settings.cache_clear()
    with pytest.raises(crypto.CryptoError):
        crypto.decrypt_secret(token)


def test_tampered_ciphertext_fails_closed(master_key):
    token = crypto.encrypt_secret(PLAINTEXT)
    tampered = ("A" if token[0] != "A" else "B") + token[1:]
    with pytest.raises(crypto.CryptoError):
        crypto.decrypt_secret(tampered)


def test_plaintext_never_appears_in_logs(master_key, caplog):
    with caplog.at_level(logging.DEBUG):
        token = crypto.encrypt_secret(PLAINTEXT)
        crypto.decrypt_secret(token)
    assert PLAINTEXT not in caplog.text
