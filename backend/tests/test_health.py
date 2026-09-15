"""Test health endpoint: api alive + mongo reachable status, không cần Mongo thật."""

import asyncio
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.database import MongoContext
from app.main import app


def _client(mongo_reachable: bool) -> TestClient:
    @asynccontextmanager
    async def fake_lifespan(app):
        ctx = MongoContext.__new__(MongoContext)
        ctx.client = object()
        ctx.ping = AsyncMock(return_value=mongo_reachable)
        app.state.mongo = ctx
        yield

    # Ghi đè lifespan bằng no-op context để không connect Mongo thật
    app.router.lifespan_context = fake_lifespan
    return TestClient(app)


def test_health_ok_when_mongo_reachable():
    with _client(True) as client:
        resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "mongo": "reachable"}


def test_health_degraded_when_mongo_unreachable():
    with _client(False) as client:
        resp = client.get("/api/health")
    assert resp.status_code == 503
    assert resp.json() == {"status": "degraded", "mongo": "unreachable"}


def test_unknown_api_route_returns_contract_error_format():
    with _client(True) as client:
        resp = client.get("/api/no-such-endpoint")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_ping_failure_returns_false_not_raise():
    """MongoContext.ping với client lỗi phải trả False (degraded), không raise."""
    with patch("app.core.database.AsyncIOMotorClient") as client_cls:
        client_cls.return_value.admin.command = AsyncMock(side_effect=RuntimeError("conn refused"))
        ctx = MongoContext(get_settings())
        ctx.connect()
        assert asyncio.run(ctx.ping()) is False
