import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

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
        yield


app = FastAPI(title="AI Challenge Platform API", lifespan=lifespan)


def error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": {"code": code, "message": message}})


@app.exception_handler(404)
async def not_found_handler(request: Request, exc) -> JSONResponse:
    return error_response(404, "NOT_FOUND", "Không tìm thấy tài nguyên.")


@app.get("/api/health")
async def health(request: Request) -> JSONResponse:
    mongo: MongoContext = request.app.state.mongo
    reachable = await mongo.ping()
    body = {"status": "ok" if reachable else "degraded", "mongo": "reachable" if reachable else "unreachable"}
    return JSONResponse(status_code=200 if reachable else 503, content=body)
