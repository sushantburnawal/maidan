from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from collections.abc import Sequence

from maidan_ai.activity_embeddings import ActivityEmbeddingInput, ActivityEmbeddingService
from maidan_ai.embedding_queue import (
    ActivityEmbeddingQueueProcessor,
    BullMqEmbeddingsConsumer,
    BullMqJob,
    BullMqQueueConfig,
    domain_event_from_job,
)


def test_domain_event_from_bullmq_job_data() -> None:
    job = BullMqJob(
        id="job-1",
        name="activity.published",
        data={
            "id": 42,
            "aggregate_type": "activity",
            "aggregate_id": "11111111-1111-4111-8111-111111111111",
            "event_type": "activity.published",
            "payload": {
                "activity_id": "11111111-1111-4111-8111-111111111111",
            },
            "created_at": "2026-06-18T00:00:00.000Z",
            "stream_entry_id": "1-0",
        },
        opts={"attempts": 3},
    )

    event = domain_event_from_job(job)

    assert event["id"] == 42
    assert event["event_type"] == "activity.published"
    assert event["payload"]["activity_id"] == "11111111-1111-4111-8111-111111111111"


def test_bullmq_embeddings_consumer_processes_waiting_job() -> None:
    async def run() -> None:
        redis = FakeBullMqRedis(prefix="maidan", queue_name="maidan.embeddings")
        activity_id = "11111111-1111-4111-8111-111111111111"
        redis.add_job(
            "domain-event-1-maidan-embeddings",
            "activity.published",
            {
                "id": 1,
                "aggregate_type": "activity",
                "aggregate_id": activity_id,
                "event_type": "activity.published",
                "payload": {"activity_id": activity_id},
                "created_at": "2026-06-18T00:00:00.000Z",
                "stream_entry_id": "1-0",
            },
            {"attempts": 3},
        )
        repository = FakeActivityEmbeddingStore(
            [
                ActivityEmbeddingInput(
                    id=activity_id,
                    title="Nandi Hills sunrise trail ride",
                    description="A supported early-morning trail ride.",
                    category="cycling",
                    pillar="move",
                    status="published",
                )
            ]
        )
        service = ActivityEmbeddingService(repository, ConstantEmbedder())
        consumer = BullMqEmbeddingsConsumer(
            redis=redis,
            processor=ActivityEmbeddingQueueProcessor(service),
            config=BullMqQueueConfig(
                queue_name="maidan.embeddings",
                prefix="maidan",
                block_timeout_seconds=0,
            ),
        )

        processed = await consumer.process_once()

        assert processed == 1
        assert repository.embeddings[activity_id] == [0.25] * 768
        assert redis.completed == {"domain-event-1-maidan-embeddings"}
        assert not redis.lists[redis.key("active")]

    asyncio.run(run())


class FakeActivityEmbeddingStore:
    def __init__(self, activities: Sequence[ActivityEmbeddingInput]) -> None:
        self.activities = {activity.id: activity for activity in activities}
        self.embeddings: dict[str, list[float]] = {}

    async def fetch_activity(self, activity_id: str) -> ActivityEmbeddingInput | None:
        return self.activities.get(activity_id)

    async def fetch_published_activities_missing_embedding(
        self, limit: int
    ) -> list[ActivityEmbeddingInput]:
        del limit
        return []

    async def update_embedding(self, activity_id: str, embedding: Sequence[float]) -> None:
        self.embeddings[activity_id] = list(embedding)

    async def clear_embedding(self, activity_id: str) -> None:
        self.embeddings.pop(activity_id, None)


class ConstantEmbedder:
    dimensions = 768

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [[0.25] * 768 for _ in texts]


class FakeBullMqRedis:
    def __init__(self, prefix: str, queue_name: str) -> None:
        self.queue_key = f"{prefix}:{queue_name}"
        self.lists: dict[str, list[str]] = defaultdict(list)
        self.hashes: dict[str, dict[str, str]] = defaultdict(dict)
        self.completed: set[str] = set()

    def key(self, suffix: str) -> str:
        return f"{self.queue_key}:{suffix}"

    def add_job(self, job_id: str, name: str, data: object, opts: object) -> None:
        self.hashes[self.key(job_id)] = {
            "name": name,
            "data": json.dumps(data),
            "opts": json.dumps(opts),
        }
        self.lists[self.key("wait")].insert(0, job_id)

    async def execute_command(self, *args: object, **options: object) -> object:
        del options
        command = str(args[0]).upper()
        if command == "BRPOPLPUSH":
            source = str(args[1])
            destination = str(args[2])
            if not self.lists[source]:
                return None
            job_id = self.lists[source].pop()
            self.lists[destination].insert(0, job_id)
            return job_id
        if command == "HGETALL":
            return self.hashes[str(args[1])]
        if command == "HSET":
            key = str(args[1])
            for index in range(2, len(args), 2):
                self.hashes[key][str(args[index])] = str(args[index + 1])
            return 1
        if command == "HINCRBY":
            key = str(args[1])
            field = str(args[2])
            amount = int(str(args[3]))
            next_value = int(self.hashes[key].get(field, "0")) + amount
            self.hashes[key][field] = str(next_value)
            return next_value
        if command == "LREM":
            key = str(args[1])
            value = str(args[3])
            self.lists[key] = [item for item in self.lists[key] if item != value]
            return 1
        if command == "ZADD":
            if str(args[1]) == self.key("completed"):
                self.completed.add(str(args[3]))
            return 1
        if command == "XADD":
            return "1-0"
        if command == "SET":
            return "OK"
        if command == "DEL":
            return 1
        if command == "LPUSH":
            self.lists[str(args[1])].insert(0, str(args[2]))
            return len(self.lists[str(args[1])])
        raise AssertionError(f"Unsupported Redis command: {command}")
