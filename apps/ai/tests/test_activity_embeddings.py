from __future__ import annotations

import asyncio
import math
from collections.abc import Sequence

from maidan_ai.activity_embeddings import (
    ActivityEmbeddingInput,
    ActivityEmbeddingService,
    build_activity_embedding_text,
)
from maidan_ai.domain_events import DomainEvent
from maidan_ai.handlers import build_default_handlers


def test_build_activity_embedding_text_uses_searchable_fields() -> None:
    activity = ActivityEmbeddingInput(
        id="activity-1",
        title="Nandi Hills sunrise trail ride",
        description="A supported early-morning trail ride through the Nandi foothills.",
        category="cycling",
        pillar="move",
        status="published",
    )

    assert build_activity_embedding_text(activity) == (
        "Title: Nandi Hills sunrise trail ride\n"
        "Description: A supported early-morning trail ride through the Nandi foothills.\n"
        "Category: cycling\n"
        "Pillar: move"
    )


def test_embed_activity_updates_published_activity_embedding() -> None:
    async def run() -> None:
        repository = FakeActivityEmbeddingStore(
            [
                ActivityEmbeddingInput(
                    id="activity-1",
                    title="Nandi Hills sunrise trail ride",
                    description="A supported early-morning trail ride through the Nandi foothills.",
                    category="cycling",
                    pillar="move",
                    status="published",
                )
            ]
        )
        embedder = KeywordEmbedder()
        service = ActivityEmbeddingService(repository, embedder)

        result = await service.embed_activity("activity-1")

        assert result.status == "embedded"
        assert result.embedding_dimensions == 768
        assert repository.embeddings["activity-1"] == embedder.embedded[0]
        assert "Nandi Hills sunrise trail ride" in embedder.texts[0]

    asyncio.run(run())


def test_embed_activity_clears_unpublished_activity_embedding() -> None:
    async def run() -> None:
        repository = FakeActivityEmbeddingStore(
            [
                ActivityEmbeddingInput(
                    id="activity-1",
                    title="Draft ride",
                    description="Not ready.",
                    category="cycling",
                    pillar="move",
                    status="paused",
                )
            ]
        )
        repository.embeddings["activity-1"] = [1.0] * 768
        service = ActivityEmbeddingService(repository, KeywordEmbedder())

        result = await service.embed_activity("activity-1")

        assert result.status == "skipped_unpublished"
        assert "activity-1" in repository.cleared
        assert "activity-1" not in repository.embeddings

    asyncio.run(run())


def test_backfill_embeds_all_published_activities_with_null_embedding() -> None:
    async def run() -> None:
        repository = FakeActivityEmbeddingStore(
            [
                ActivityEmbeddingInput(
                    id="trail-ride-1",
                    title="Nandi Hills sunrise trail ride",
                    description="A supported early-morning trail ride through the Nandi foothills.",
                    category="cycling",
                    pillar="move",
                    status="published",
                ),
                ActivityEmbeddingInput(
                    id="trail-ride-2",
                    title="Nandi Hills gravel climb clinic",
                    description="A focused clinic for cycling climbs and descent confidence.",
                    category="cycling",
                    pillar="move",
                    status="published",
                ),
                ActivityEmbeddingInput(
                    id="coffee-1",
                    title="Indiranagar filter coffee brewing",
                    description="Hands-on South Indian filter coffee brewing.",
                    category="coffee",
                    pillar="learn",
                    status="published",
                ),
            ]
        )
        service = ActivityEmbeddingService(repository, KeywordEmbedder())

        result = await service.backfill_missing(batch_size=2)

        assert result.embedded_count == 3
        assert set(repository.embeddings) == {"trail-ride-1", "trail-ride-2", "coffee-1"}

        query = KeywordEmbedder.vector_for_text("sunrise trail cycling ride")
        ranked = sorted(
            repository.embeddings,
            key=lambda activity_id: cosine_distance(repository.embeddings[activity_id], query),
        )
        assert ranked[:2] == ["trail-ride-1", "trail-ride-2"]

    asyncio.run(run())


def test_activity_event_handler_embeds_activity_updated_from_bus() -> None:
    async def run() -> None:
        activity_id = "11111111-1111-4111-8111-111111111111"
        repository = FakeActivityEmbeddingStore(
            [
                ActivityEmbeddingInput(
                    id=activity_id,
                    title="Nandi Hills gravel climb clinic",
                    description="A focused climbing clinic for riders.",
                    category="cycling",
                    pillar="move",
                    status="published",
                )
            ]
        )
        service = ActivityEmbeddingService(repository, KeywordEmbedder())
        handler = build_default_handlers(service)["activity.updated"]
        event: DomainEvent = {
            "id": 7,
            "aggregate_type": "activity",
            "aggregate_id": activity_id,
            "event_type": "activity.updated",
            "payload": {
                "activity_id": activity_id,
                "host_id": "22222222-2222-4222-8222-222222222222",
                "changed_fields": ["description"],
                "updated_at": "2026-06-18T00:00:00.000Z",
            },
            "created_at": "2026-06-18T00:00:00.000Z",
        }

        result = await handler.handle(event)

        assert result["handler"] == "activity_embedding"
        assert result["event_type"] == "activity.updated"
        assert result["status"] == "embedded"
        assert activity_id in repository.embeddings

    asyncio.run(run())


class FakeActivityEmbeddingStore:
    def __init__(self, activities: Sequence[ActivityEmbeddingInput]) -> None:
        self.activities = {activity.id: activity for activity in activities}
        self.embeddings: dict[str, list[float]] = {}
        self.cleared: set[str] = set()

    async def fetch_activity(self, activity_id: str) -> ActivityEmbeddingInput | None:
        return self.activities.get(activity_id)

    async def fetch_published_activities_missing_embedding(
        self, limit: int
    ) -> list[ActivityEmbeddingInput]:
        missing = [
            activity
            for activity in self.activities.values()
            if activity.status == "published" and activity.id not in self.embeddings
        ]
        return missing[:limit]

    async def update_embedding(self, activity_id: str, embedding: Sequence[float]) -> None:
        self.embeddings[activity_id] = list(embedding)

    async def clear_embedding(self, activity_id: str) -> None:
        self.cleared.add(activity_id)
        self.embeddings.pop(activity_id, None)


class KeywordEmbedder:
    dimensions = 768

    def __init__(self) -> None:
        self.texts: list[str] = []
        self.embedded: list[list[float]] = []

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        embeddings = [self.vector_for_text(text) for text in texts]
        self.texts.extend(texts)
        self.embedded.extend(embeddings)
        return embeddings

    @staticmethod
    def vector_for_text(text: str) -> list[float]:
        tokens = text.lower()
        vector = [0.0] * 768
        for index, keyword in enumerate(
            [
                "nandi",
                "trail",
                "ride",
                "cycling",
                "gravel",
                "climb",
                "coffee",
                "brewing",
                "learn",
            ]
        ):
            if keyword in tokens:
                vector[index] = 1.0
        return vector


def cosine_distance(left: Sequence[float], right: Sequence[float]) -> float:
    dot = sum(left_value * right_value for left_value, right_value in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    return 1.0 - dot / (left_norm * right_norm)
