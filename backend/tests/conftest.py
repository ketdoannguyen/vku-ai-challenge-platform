import asyncio
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

# Cho pytest tìm thấy package `app` khi chạy từ repo root hoặc backend/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.accounts.service import AccountCreate  # noqa: E402
from app.core.database import MongoContext  # noqa: E402


def _mk(email, name, password, role):
    return AccountCreate(email=email, name=name, password=password, role=role)


@pytest.fixture()
def mock_db():
    return AsyncMongoMockClient().test_db


@pytest.fixture()
def app_with_db(mock_db):
    """App thật + Mongo mock; seed 1 admin + 1 participant qua service thật."""
    from app.accounts.service import create_account
    from app.main import app

    ctx = MongoContext.__new__(MongoContext)
    ctx.client = object()

    def get_db(self):
        return mock_db

    with patch.object(MongoContext, "db", property(get_db)):
        asyncio.run(create_account(mock_db, _mk("admin@vku.vn", "Admin Mét", "adminmatkhau1", "admin")))
        asyncio.run(create_account(mock_db, _mk("thi.sinh@vku.vn", "Thí Sinh", "thisinhmatkhau1", "participant")))
        app.state.mongo = ctx
        yield app
        app.state.mongo = None


@pytest.fixture()
def client(app_with_db):
    with TestClient(app_with_db) as c:
        yield c
