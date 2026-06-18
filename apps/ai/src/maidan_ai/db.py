from __future__ import annotations

from collections.abc import Mapping
from contextlib import AbstractAsyncContextManager
from typing import Protocol

import asyncpg  # type: ignore[import-untyped]

from maidan_ai.config import Settings


class DbConnection(Protocol):
    def transaction(self) -> AbstractAsyncContextManager[None]:
        pass

    async def fetchrow(self, query: str, *args: object) -> Mapping[str, object] | None:
        pass

    async def execute(self, query: str, *args: object) -> object:
        pass


class DbPool(Protocol):
    def acquire(self) -> AbstractAsyncContextManager[DbConnection]:
        pass

    async def execute(self, query: str, *args: object) -> object:
        pass

    async def close(self) -> None:
        pass


async def create_db_pool(settings: Settings) -> DbPool:
    return await asyncpg.create_pool(  # type: ignore[no-any-return]
        dsn=settings.database_url,
        min_size=settings.db_pool_min_size,
        max_size=settings.db_pool_max_size,
        ssl=True if settings.postgres_ssl else None,
    )
