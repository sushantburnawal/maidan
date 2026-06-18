from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol, cast

from maidan_ai.db import DbPool
from maidan_ai.domain_events import JsonObject
from maidan_ai.embeddings import Embedder, pgvector_literal


@dataclass(frozen=True)
class ActivityEmbeddingInput:
    id: str
    title: str
    description: str
    category: str
    pillar: str
    status: str


@dataclass(frozen=True)
class ActivityEmbeddingResult:
    activity_id: str
    status: str
    embedding_dimensions: int | None = None

    def to_json(self) -> JsonObject:
        result: JsonObject = {
            "activity_id": self.activity_id,
            "status": self.status,
        }
        if self.embedding_dimensions is not None:
            result["embedding_dimensions"] = self.embedding_dimensions
        return result


@dataclass(frozen=True)
class BackfillResult:
    embedded_count: int

    def to_json(self) -> JsonObject:
        return {"embedded_count": self.embedded_count}


class ActivityEmbeddingStore(Protocol):
    async def fetch_activity(self, activity_id: str) -> ActivityEmbeddingInput | None:
        pass

    async def fetch_published_activities_missing_embedding(
        self, limit: int
    ) -> list[ActivityEmbeddingInput]:
        pass

    async def update_embedding(self, activity_id: str, embedding: Sequence[float]) -> None:
        pass

    async def clear_embedding(self, activity_id: str) -> None:
        pass


class ActivityEmbeddingRepository:
    def __init__(self, pool: DbPool, dimensions: int = 768) -> None:
        self._pool = pool
        self._dimensions = dimensions

    async def fetch_activity(self, activity_id: str) -> ActivityEmbeddingInput | None:
        async with self._pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                select id::text, title, description, category, pillar::text, status::text
                from activities
                where id = $1::uuid
                """,
                activity_id,
            )

        return None if row is None else activity_input_from_row(row)

    async def fetch_published_activities_missing_embedding(
        self, limit: int
    ) -> list[ActivityEmbeddingInput]:
        async with self._pool.acquire() as connection:
            rows = await connection.fetch(
                """
                select id::text, title, description, category, pillar::text, status::text
                from activities
                where status = 'published'::activity_status
                  and embedding is null
                order by created_at, id
                limit $1
                """,
                limit,
            )

        return [activity_input_from_row(row) for row in rows]

    async def update_embedding(self, activity_id: str, embedding: Sequence[float]) -> None:
        await self._pool.execute(
            """
            update activities
            set embedding = $2::vector(768)
            where id = $1::uuid
            """,
            activity_id,
            pgvector_literal(embedding, self._dimensions),
        )

    async def clear_embedding(self, activity_id: str) -> None:
        await self._pool.execute(
            """
            update activities
            set embedding = null
            where id = $1::uuid
              and embedding is not null
            """,
            activity_id,
        )


class ActivityEmbeddingService:
    def __init__(self, repository: ActivityEmbeddingStore, embedder: Embedder) -> None:
        self._repository = repository
        self._embedder = embedder

    async def embed_activity(self, activity_id: str) -> ActivityEmbeddingResult:
        activity = await self._repository.fetch_activity(activity_id)
        if activity is None:
            return ActivityEmbeddingResult(activity_id=activity_id, status="missing")

        if activity.status != "published":
            await self._repository.clear_embedding(activity.id)
            return ActivityEmbeddingResult(activity_id=activity.id, status="skipped_unpublished")

        embedding = await self._embed_one(activity)
        await self._repository.update_embedding(activity.id, embedding)
        return ActivityEmbeddingResult(
            activity_id=activity.id,
            status="embedded",
            embedding_dimensions=len(embedding),
        )

    async def backfill_missing(self, batch_size: int) -> BackfillResult:
        embedded_count = 0
        while True:
            activities = await self._repository.fetch_published_activities_missing_embedding(
                batch_size
            )
            if not activities:
                break

            embeddings = await self._embedder.embed(
                [build_activity_embedding_text(activity) for activity in activities]
            )
            if len(embeddings) != len(activities):
                raise ValueError(
                    f"Embedder returned {len(embeddings)} embeddings for {len(activities)} texts"
                )

            for activity, embedding in zip(activities, embeddings, strict=True):
                await self._repository.update_embedding(activity.id, embedding)
                embedded_count += 1

        return BackfillResult(embedded_count=embedded_count)

    async def _embed_one(self, activity: ActivityEmbeddingInput) -> list[float]:
        embeddings = await self._embedder.embed([build_activity_embedding_text(activity)])
        if len(embeddings) != 1:
            raise ValueError(f"Embedder returned {len(embeddings)} embeddings for one text")
        return embeddings[0]


def build_activity_embedding_text(activity: ActivityEmbeddingInput) -> str:
    return "\n".join(
        [
            f"Title: {activity.title}",
            f"Description: {activity.description}",
            f"Category: {activity.category}",
            f"Pillar: {activity.pillar}",
        ]
    )


def activity_input_from_row(row: object) -> ActivityEmbeddingInput:
    values = cast(Mapping[str, object], row)
    return ActivityEmbeddingInput(
        id=str(values["id"]),
        title=str(values["title"]),
        description=str(values["description"]),
        category=str(values["category"]),
        pillar=str(values["pillar"]),
        status=str(values["status"]),
    )
