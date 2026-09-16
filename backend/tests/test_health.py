"""Test health endpoint: api alive + mongo reachable status, không cần Mongo thật."""

import asyncio
from contextlib import asynccontextmanager, contextmanager
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.database import MongoContext
from app.main import app


@contextmanager
def _client(mongo_reachable: bool, *, raise_server_exceptions: bool = True):
    @asynccontextmanager
    async def fake_lifespan(app):
        ctx = MongoContext.__new__(MongoContext)
        ctx.client = object()
        ctx.ping = AsyncMock(return_value=mongo_reachable)
        app.state.mongo = ctx
        yield

    # Ghi đè tạm lifespan để không connect Mongo thật, rồi phục hồi cho các test khác.
    original_lifespan = app.router.lifespan_context
    app.router.lifespan_context = fake_lifespan
    try:
        with TestClient(app, raise_server_exceptions=raise_server_exceptions) as client:
            yield client
    finally:
        app.router.lifespan_context = original_lifespan


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


def test_method_not_allowed_has_stable_contract_error():
    with _client(True) as client:
        response = client.post("/api/health")
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "METHOD_NOT_ALLOWED"


def test_unhandled_exception_returns_safe_contract_error_without_traceback():
    with _client(True, raise_server_exceptions=False) as client:
        with patch("app.main.resolve_session", new=AsyncMock(side_effect=RuntimeError("private detail"))):
            response = client.get("/api/auth/me", cookies={"aic_session": "test-token"})

    assert response.status_code == 500
    assert response.json() == {
        "error": {
            "code": "INTERNAL_ERROR",
            "message": "Máy chủ gặp lỗi. Vui lòng thử lại sau.",
        }
    }
    assert "private detail" not in response.text
    assert "Traceback" not in response.text


def test_ping_failure_returns_false_not_raise():
    """MongoContext.ping với client lỗi phải trả False (degraded), không raise."""
    with patch("app.core.database.AsyncIOMotorClient") as client_cls:
        client_cls.return_value.admin.command = AsyncMock(side_effect=RuntimeError("conn refused"))
        ctx = MongoContext(get_settings())
        ctx.connect()
        assert asyncio.run(ctx.ping()) is False
