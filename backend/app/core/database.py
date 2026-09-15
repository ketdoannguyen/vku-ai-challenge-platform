import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from app.core.config import Settings

logger = logging.getLogger(__name__)


class MongoContext:
    """Giữ Mongo client và database; tạo/mỗi lifecycle rõ ràng ở app startup/shutdown."""

    def __init__(self, settings: Settings):
        self._settings = settings
        self.client: Optional[AsyncIOMotorClient] = None

    def connect(self) -> None:
        logger.info("Connecting to MongoDB at %s:%s", self._settings.mongo_host, self._settings.mongo_port)
        self.client = AsyncIOMotorClient(self._settings.mongo_uri)

    def close(self) -> None:
        if self.client is not None:
            self.client.close()
            self.client = None

    @property
    def db(self) -> AsyncIOMotorDatabase:
        if self.client is None:
            raise RuntimeError("Mongo client not initialized — app lifecycle error")
        return self.client[self._settings.mongo_database]

    async def ping(self) -> bool:
        if self.client is None:
            return False
        try:
            await self.client.admin.command("ping")
            return True
        except Exception:
            logger.warning("Mongo ping failed at %s:%s", self._settings.mongo_host, self._settings.mongo_port)
            return False


@asynccontextmanager
async def mongo_lifespan(settings: Settings) -> AsyncIterator[MongoContext]:
    ctx = MongoContext(settings)
    ctx.connect()
    try:
        yield ctx
    finally:
        ctx.close()
