"""Dịch vụ nhận một lượt chấm và chạy nó trong sandbox.

Chỉ API gọi được service này (không publish port, không route qua Nginx). Service không giữ trạng
thái nào giữa các lượt: mọi thứ cần cho một lượt chấm nằm trong chính request.
"""

import logging
import sys
from contextlib import asynccontextmanager
from typing import AsyncIterator

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from app.core.config import get_settings
from app.evaluator_runner.sandbox import Sandbox, Slots
from app.scoring.errors import EvaluatorError

logger = logging.getLogger(__name__)

# Trần cứng của body: hai file CSV tối đa 10 MiB mỗi file (giới hạn upload) nên 32 MiB là dư, và một
# request vượt ngưỡng là lỗi phía gọi chứ không phải việc để Starlette đọc hết vào RAM.
MAX_REQUEST_BYTES = 32 * 1024 * 1024
UNAVAILABLE_CODE = "EVALUATOR_UNAVAILABLE"


class EvaluateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_code: str
    ground_truth_csv: str
    submission_csv: str


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    app.state.sandbox = Sandbox(
        image=settings.evaluator_runtime_image,
        timeout_seconds=settings.evaluator_timeout_seconds,
    )
    app.state.slots = Slots(settings.evaluator_max_concurrency)
    if not app.state.sandbox.available:
        logger.error(
            "Không thấy docker trong image runner: mọi lượt chấm sẽ trả %s cho tới khi sửa xong.",
            UNAVAILABLE_CODE,
        )
    logger.info(
        "Runner sẵn sàng: image=%s, timeout=%ss, đồng thời=%s",
        app.state.sandbox.image,
        settings.evaluator_timeout_seconds,
        settings.evaluator_max_concurrency,
    )
    yield


app = FastAPI(title="Evaluator Runner", lifespan=lifespan)


def _failure(error: EvaluatorError, status_code: int) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"code": error.code, "message": error.message, "detail": error.detail},
    )


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_REQUEST_BYTES:
        return JSONResponse(
            status_code=413,
            content={"code": UNAVAILABLE_CODE, "message": "Yêu cầu vượt quá dung lượng cho phép."},
        )
    return await call_next(request)


@app.get("/health")
async def health(request: Request) -> dict:
    sandbox: Sandbox = request.app.state.sandbox
    return {
        "status": "ok" if sandbox.available else "degraded",
        "docker": sandbox.available,
        "runtime_id": sandbox.image,
    }


@app.post("/evaluate")
async def evaluate(payload: EvaluateRequest, request: Request) -> JSONResponse:
    sandbox: Sandbox = request.app.state.sandbox
    slots: Slots = request.app.state.slots
    if not await slots.take():
        return _failure(
            EvaluatorError(UNAVAILABLE_CODE, "Hệ thống chấm đang bận, vui lòng thử lại."), 503
        )
    try:
        metrics, duration_ms = await sandbox.run(
            source_code=payload.source_code,
            ground_truth_csv=payload.ground_truth_csv,
            submission_csv=payload.submission_csv,
        )
    except EvaluatorError as error:
        logger.info("Lượt chấm thất bại: %s - %s", error.code, error.message)
        status_code = 503 if error.code == UNAVAILABLE_CODE else 422
        return _failure(error, status_code)
    finally:
        await slots.release()
    return JSONResponse(
        status_code=200,
        content={
            "status": "passed",
            "runtime_id": sandbox.image,
            "metrics": metrics,
            "duration_ms": duration_ms,
        },
    )


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = get_settings()
    # Một worker duy nhất: bộ đếm đồng thời nằm trong process, nhiều worker là nhiều lần trần.
    uvicorn.run(app, host="0.0.0.0", port=settings.evaluator_runner_port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
