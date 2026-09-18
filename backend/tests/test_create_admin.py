"""Giao diện dòng lệnh của scripts/create_admin.py - không cần MongoDB."""

import io
import sys

from scripts.create_admin import main, read_password


def test_doc_mat_khau_tu_stdin_khi_pipe(monkeypatch):
    monkeypatch.setattr(sys, "stdin", io.StringIO("matkhau1234\n"))

    assert read_password() == "matkhau1234"


def test_doc_mat_khau_bo_ca_xuong_dong_crlf(monkeypatch):
    monkeypatch.setattr(sys, "stdin", io.StringIO("matkhau1234\r\n"))

    assert read_password() == "matkhau1234"


async def test_tu_choi_khi_thieu_tham_so(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["create_admin.py", "admin@vku.udn.vn"])

    assert await main() == 2


async def test_bao_loi_gon_khi_email_khong_hop_le(monkeypatch, capsys):
    """Chặn trước khi kết nối Mongo: email sai phải thoát code 2, không ném traceback."""
    monkeypatch.setattr(sys, "stdin", io.StringIO("matkhau1234\n"))
    monkeypatch.setattr(sys, "argv", ["create_admin.py", "admin@test.local", "ADMIN NKD"])

    assert await main() == 2
    assert "email không hợp lệ" in capsys.readouterr().err
