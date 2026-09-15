import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.accounts import service as accounts_service
from app.accounts.admin_router import router as admin_accounts_router
from app.auth import sessions as sessions_module
from app.competitions import service as competitions_service
from app.competitions.admin_router import router as admin_competitions_router
from app.content import service as content_service
from app.content.admin_router import router as admin_content_router
from app.content.router import router as content_router
from app.competitions.router import router as competitions_router
from app.memberships import service as memberships_service
from app.memberships.admin_router import router as admin_memberships_router
from app.memberships.router import router as memberships_router
from app.scoring.admin_router import router as admin_scoring_router
from app.submissions import service as submissions_service
from app.submissions.router import router as submissions_router
from app.auth.router import router as auth_router
from app.auth.sessions import resolve_session
from app.core.config import get_settings
from app.core.database import MongoContext, mongo_lifespan

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    async with mongo_lifespan(settings) as ctx:
        app.state.mongo = ctx
        await accounts_service.ensure_indexes(ctx.db)
        await sessions_module.ensure_indexes(ctx.db)
        await competitions_service.ensure_indexes(ctx.db)
        await memberships_service.ensure_indexes(ctx.db)
        await content_service.ensure_indexes(ctx.db)
        await submissions_service.ensure_indexes(ctx.db)
        yield


app = FastAPI(title="AI Challenge Platform API", lifespan=lifespan)


def error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": {"code": code, "message": message}})


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict) and "code" in exc.detail:
        return error_response(exc.status_code, exc.detail["code"], exc.detail.get("message", ""))
    if exc.status_code == 404:
        return error_response(404, "NOT_FOUND", "Không tìm thấy tài nguyên.")
    return error_response(exc.status_code, "ERROR", str(exc.detail))


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return error_response(422, "VALIDATION_ERROR", "Dữ liệu gửi lên không hợp lệ.")


@app.middleware("http")
async def resolve_account_middleware(request: Request, call_next):
    """Gắn account hiện tại (nếu có) vào request.state — dependency auth dùng lại."""
    token = request.cookies.get(get_settings().session_cookie_name, "")
    if token and request.url.path.startswith("/api"):
        request.state.account = await resolve_session(request.app.state.mongo.db, token)
    return await call_next(request)


app.include_router(auth_router)
app.include_router(admin_accounts_router)
app.include_router(admin_competitions_router)
app.include_router(admin_memberships_router)
app.include_router(admin_content_router)
app.include_router(admin_scoring_router)
app.include_router(submissions_router)
app.include_router(memberships_router)
app.include_router(content_router)
app.include_router(competitions_router)


@app.get("/api/health")
async def health(request: Request) -> JSONResponse:
    mongo: MongoContext = request.app.state.mongo
    reachable = await mongo.ping()
    body = {"status": "ok" if reachable else "degraded", "mongo": "reachable" if reachable else "unreachable"}
    return JSONResponse(status_code=200 if reachable else 503, content=body)
