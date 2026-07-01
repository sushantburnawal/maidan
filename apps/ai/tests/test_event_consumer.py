from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from collections.abc import Callable, Mapping

from maidan_ai.domain_events import (
    DomainEvent,
    DomainEventValidator,
    JsonObject,
    default_events_schema_path,
)
from maidan_ai.event_bus import EventConsumerConfig, RedisDomainEventConsumer
from maidan_ai.handlers import build_default_handlers
from maidan_ai.jobs import EventProcessingState

STREAM_DOMAIN_EVENTS = "maidan.events"
DEAD_LETTER_STREAM = "maidan.events.dead-letter"

type StreamFields = dict[str, str]
type StreamEntry = tuple[str, StreamFields]


def test_consumer_joins_group_and_acks_valid_event_exactly_once() -> None:
    async def run() -> None:
        redis = FakeRedis()
        jobs = FakeJobStore()
        consumer = build_consumer(redis, jobs)
        await consumer.start()

        try:
            event = valid_activity_published_event(event_id=101)
            entry_id = await redis.xadd(STREAM_DOMAIN_EVENTS, stream_fields(event))

            await wait_until(lambda: redis.ack_count(entry_id) == 1)
            await asyncio.sleep(0.05)

            assert redis.created_groups == [(STREAM_DOMAIN_EVENTS, "maidan-ai", "0-0")]
            assert redis.ack_count(entry_id) == 1
            assert jobs.statuses[str(event["id"])] == "succeeded"
        finally:
            await consumer.stop()

    asyncio.run(run())


def test_schema_invalid_event_goes_to_dead_letter_and_loop_continues() -> None:
    async def run() -> None:
        redis = FakeRedis()
        jobs = FakeJobStore()
        consumer = build_consumer(redis, jobs)
        await consumer.start()

        try:
            invalid_event = valid_activity_published_event(event_id=102)
            del invalid_event["payload"]["title"]
            invalid_entry_id = await redis.xadd(STREAM_DOMAIN_EVENTS, stream_fields(invalid_event))

            await wait_until(lambda: redis.stream_len(DEAD_LETTER_STREAM) == 1)
            assert redis.ack_count(invalid_entry_id) == 1
            assert jobs.invalid_events
            assert consumer.running

            valid_event = valid_activity_published_event(event_id=103)
            valid_entry_id = await redis.xadd(STREAM_DOMAIN_EVENTS, stream_fields(valid_event))

            await wait_until(lambda: redis.ack_count(valid_entry_id) == 1)
            assert jobs.statuses[str(valid_event["id"])] == "succeeded"
        finally:
            await consumer.stop()

    asyncio.run(run())


def test_follow_created_event_is_acked_as_valid_noop() -> None:
    async def run() -> None:
        redis = FakeRedis()
        jobs = FakeJobStore()
        consumer = build_consumer(redis, jobs)
        await consumer.start()

        try:
            event = valid_follow_created_event(event_id=104)
            entry_id = await redis.xadd(STREAM_DOMAIN_EVENTS, stream_fields(event))

            await wait_until(lambda: redis.ack_count(entry_id) == 1)
            await asyncio.sleep(0.05)

            assert redis.ack_count(entry_id) == 1
            assert jobs.statuses[str(event["id"])] == "succeeded"
            assert redis.stream_len(DEAD_LETTER_STREAM) == 0
            assert not jobs.invalid_events
        finally:
            await consumer.stop()

    asyncio.run(run())


def build_consumer(redis: FakeRedis, jobs: FakeJobStore) -> RedisDomainEventConsumer:
    validator = DomainEventValidator.from_schema_path(default_events_schema_path())
    return RedisDomainEventConsumer(
        redis=redis,
        jobs=jobs,
        validator=validator,
        handlers=build_default_handlers(),
        config=EventConsumerConfig(
            stream_name=STREAM_DOMAIN_EVENTS,
            group_name="maidan-ai",
            consumer_name="test-consumer",
            stream_start_id="0-0",
            batch_size=10,
            block_ms=100,
            max_attempts=3,
            retry_delay_seconds=0,
            dead_letter_stream=DEAD_LETTER_STREAM,
        ),
    )


def valid_activity_published_event(event_id: int) -> DomainEvent:
    return {
        "id": event_id,
        "aggregate_type": "activity",
        "aggregate_id": "11111111-1111-4111-8111-111111111111",
        "event_type": "activity.published",
        "payload": {
            "activity_id": "11111111-1111-4111-8111-111111111111",
            "host_id": "22222222-2222-4222-8222-222222222222",
            "title": "Hemant's Nandi Hills sunrise trail ride",
            "description": "A steady sunrise ride up Nandi Hills.",
            "pillar": "move",
            "category": "cycling",
            "meeting_point": "Hebbal flyover",
            "location": {"lat": 13.1986, "lng": 77.7066},
            "base_price_inr": 1200,
            "published_at": "2026-06-18T00:00:00.000Z",
        },
        "created_at": "2026-06-18T00:00:00.000Z",
    }


def valid_follow_created_event(event_id: int) -> DomainEvent:
    return {
        "id": event_id,
        "aggregate_type": "follow",
        "aggregate_id": "22222222-2222-4222-8222-222222222222",
        "event_type": "follow.created",
        "payload": {
            "follower_id": "11111111-1111-4111-8111-111111111111",
            "followee_id": "22222222-2222-4222-8222-222222222222",
            "created_at": "2026-06-18T00:00:00.000Z",
        },
        "created_at": "2026-06-18T00:00:00.000Z",
    }


def stream_fields(event: DomainEvent) -> StreamFields:
    return {
        "id": str(event["id"]),
        "aggregate_type": event["aggregate_type"],
        "aggregate_id": event["aggregate_id"],
        "event_type": event["event_type"],
        "payload": json.dumps(event["payload"]),
        "created_at": event["created_at"],
    }


async def wait_until(predicate: Callable[[], bool], timeout_seconds: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition was not met before timeout")


class FakeRedis:
    def __init__(self) -> None:
        self.created_groups: list[tuple[str, str, str]] = []
        self._streams: dict[str, list[StreamEntry]] = defaultdict(list)
        self._delivered: set[str] = set()
        self._pending: dict[str, tuple[str, StreamFields]] = {}
        self._ack_counts: dict[str, int] = defaultdict(int)
        self._sequence = 0
        self._condition = asyncio.Condition()

    async def xgroup_create(
        self,
        name: str,
        groupname: str,
        id: str = "$",
        mkstream: bool = False,
    ) -> object:
        self.created_groups.append((name, groupname, id))
        if mkstream:
            self._streams.setdefault(name, [])
        return True

    async def xadd(self, name: str, fields: Mapping[str, str], id: str = "*") -> str:
        async with self._condition:
            self._sequence += 1
            entry_id = id if id != "*" else f"{self._sequence}-0"
            self._streams[name].append((entry_id, dict(fields)))
            self._condition.notify_all()
            return entry_id

    async def xreadgroup(
        self,
        groupname: str,
        consumername: str,
        streams: dict[str, str],
        count: int | None = None,
        block: int | None = None,
    ) -> object:
        del groupname, consumername
        stream_name, stream_id = next(iter(streams.items()))
        limit = count or 1

        async with self._condition:
            if stream_id == "0":
                return self._format_response(stream_name, self._pending_entries(stream_name, limit))

            if block is not None:
                timeout = max(block / 1000, 0.001)
                try:
                    await asyncio.wait_for(
                        self._condition.wait_for(lambda: bool(self._available(stream_name))),
                        timeout=timeout,
                    )
                except TimeoutError:
                    return []

            entries = self._available(stream_name)[:limit]
            for entry_id, fields in entries:
                self._delivered.add(entry_id)
                self._pending[entry_id] = (stream_name, fields)
            return self._format_response(stream_name, entries)

    async def xack(self, name: str, groupname: str, *ids: str) -> int:
        del groupname
        acked = 0
        async with self._condition:
            for entry_id in ids:
                pending = self._pending.get(entry_id)
                if pending is None or pending[0] != name:
                    continue
                acked += 1
                self._ack_counts[entry_id] += 1
                del self._pending[entry_id]
            self._condition.notify_all()
        return acked

    def ack_count(self, entry_id: str) -> int:
        return self._ack_counts[entry_id]

    def stream_len(self, name: str) -> int:
        return len(self._streams[name])

    def _available(self, stream_name: str) -> list[StreamEntry]:
        return [
            (entry_id, fields)
            for entry_id, fields in self._streams[stream_name]
            if entry_id not in self._delivered and entry_id not in self._pending
        ]

    def _pending_entries(self, stream_name: str, limit: int) -> list[StreamEntry]:
        return [
            (entry_id, fields)
            for entry_id, (entry_stream_name, fields) in self._pending.items()
            if entry_stream_name == stream_name
        ][:limit]

    @staticmethod
    def _format_response(stream_name: str, entries: list[StreamEntry]) -> object:
        return [] if not entries else [(stream_name, entries)]


class FakeJobStore:
    def __init__(self) -> None:
        self.statuses: dict[str, str] = {}
        self.attempts: dict[str, int] = defaultdict(int)
        self.invalid_events: list[JsonObject] = []

    async def begin_event(self, event: DomainEvent, stream_entry_id: str) -> EventProcessingState:
        del stream_entry_id
        ref_id = str(event["id"])
        if self.statuses.get(ref_id) in {"succeeded", "dead_letter"}:
            return EventProcessingState(already_finished=True, attempts=self.attempts[ref_id])
        self.attempts[ref_id] += 1
        self.statuses[ref_id] = "processing"
        return EventProcessingState(already_finished=False, attempts=self.attempts[ref_id])

    async def mark_succeeded(self, event: DomainEvent, result: JsonObject) -> None:
        del result
        self.statuses[str(event["id"])] = "succeeded"

    async def mark_failed(self, event: DomainEvent, error: str, attempts: int) -> None:
        del error, attempts
        self.statuses[str(event["id"])] = "failed"

    async def mark_dead_letter(
        self,
        event: DomainEvent,
        error: str,
        attempts: int,
        dead_letter_entry_id: str,
    ) -> None:
        del error, attempts, dead_letter_entry_id
        self.statuses[str(event["id"])] = "dead_letter"

    async def record_invalid_event(
        self,
        ref_id: str,
        payload: JsonObject,
        reason: str,
        dead_letter_entry_id: str,
    ) -> None:
        self.invalid_events.append(
            {
                "ref_id": ref_id,
                "payload": payload,
                "reason": reason,
                "dead_letter_entry_id": dead_letter_entry_id,
            }
        )
