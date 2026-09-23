from app.auth.passwords import hash_password, password_policy_error, verify_password


def test_hash_is_argon2id_not_plaintext():
    h = hash_password("matkhauan123")
    assert h.startswith("$argon2id$")
    assert "matkhauan123" not in h


def test_verify_correct_and_wrong_password():
    h = hash_password("matkhauan123")
    assert verify_password(h, "matkhauan123") is True
    assert verify_password(h, "sai-mat-khau") is False


def test_verify_malformed_hash_returns_false():
    assert verify_password("not-a-hash", "matkhauan123") is False


def test_password_policy():
    assert password_policy_error("ngan1") is not None  # <6 ký tự
    assert password_policy_error("du-6ky") is None  # đúng 6 ký tự
    assert password_policy_error("  dau-cach-2-dau  ") is not None
    assert password_policy_error("matkhau-du-do-luong") is None
