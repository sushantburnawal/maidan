from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from dataclasses import dataclass
from typing import TypedDict, cast

from maidan_ai.domain_events import DomainEvent, JsonObject
from maidan_ai.embedding_queue import BullMqJob
from maidan_ai.jobs import EventProcessingState
from maidan_ai.moderation import (
    MODERATION_DECISION_JOB_KIND,
    MODERATION_QUEUE_JOB_KIND,
    MODERATION_RUBRIC,
    BullMqFailureAction,
    BullMqModerationConsumer,
    ModerationContent,
    ModerationDecision,
    ModerationItem,
    ModerationModelOutputError,
    ModerationQueueConfig,
    ModerationQueueProcessor,
    ModerationService,
    ModerationTargetType,
    parse_moderation_response,
)

QUEUE_MODERATION = "maidan.moderation"
MESSAGE_ID = "11111111-1111-4111-8111-111111111111"
AUTHOR_ID = "22222222-2222-4222-8222-222222222222"
CHAT_ID = "33333333-3333-4333-8333-333333333333"
SEEDED_ABUSIVE_SAMPLE = "I will find you at the trailhead and hurt you."


def test_benign_message_is_marked_ok() -> None:
    async def run() -> None:
        redis = FakeBullMqRedis(prefix="maidan", queue_name=QUEUE_MODERATION)
        store = FakeModerationStore()
        store.add_message(MESSAGE_ID, "See you at the trailhead.")
        redis.add_job(
            "domain-event-1-maidan-moderation",
            "message.created",
            message_created_job_data(event_id=1, message_id=MESSAGE_ID),
            {"attempts": 3},
        )
        consumer = build_consumer(
            redis,
            store,
            FakeCheapModerationClient(
                [
                    json.dumps(
                        {
                            "allow": True,
                            "categories": [],
                            "severity": 0,
                            "reason": "Benign ride coordination.",
                        }
                    )
                ]
            ),
        )

        processed = await consumer.process_once()

        assert processed == 1
        record = store.records[f"message:{MESSAGE_ID}"]
        assert record.moderation_status == "ok"
        assert record.is_hidden is False
        assert redis.completed == {"domain-event-1-maidan-moderation"}
        assert store.ai_jobs[(MODERATION_DECISION_JOB_KIND, f"message:{MESSAGE_ID}")][
            "status"
        ] == "succeeded"

    asyncio.run(run())


def test_seeded_abusive_message_is_blocked_hidden_and_notifies_author() -> None:
    async def run() -> None:
        redis = FakeBullMqRedis(prefix="maidan", queue_name=QUEUE_MODERATION)
        store = FakeModerationStore()
        store.add_message(MESSAGE_ID, SEEDED_ABUSIVE_SAMPLE)
        client = FakeCheapModerationClient(
            [
                json.dumps(
                    {
                        "allow": False,
                        "categories": ["violence", "harassment"],
                        "severity": 3,
                        "reason": "Threatens physical harm.",
                    }
                )
            ]
        )
        redis.add_job(
            "domain-event-2-maidan-moderation",
            "message.created",
            message_created_job_data(event_id=2, message_id=MESSAGE_ID),
            {"attempts": 3},
        )
        consumer = build_consumer(redis, store, client)

        processed = await consumer.process_once()

        assert processed == 1
        record = store.records[f"message:{MESSAGE_ID}"]
        assert record.moderation_status == "blocked"
        assert record.is_hidden is True
        assert store.notification_events == [
            {
                "target_type": "message",
                "target_id": MESSAGE_ID,
                "author_id": AUTHOR_ID,
                "severity": 3,
                "categories": ["violence", "harassment"],
                "reason": "Threatens physical harm.",
            }
        ]
        assert client.calls[0]["system"] == MODERATION_RUBRIC

    asyncio.run(run())


def test_parse_failures_retry_then_dead_letter_without_allowing() -> None:
    async def run() -> None:
        redis = FakeBullMqRedis(prefix="maidan", queue_name=QUEUE_MODERATION)
        store = FakeModerationStore()
        store.add_message(MESSAGE_ID, "Ordinary content should not be allowed on parse failure.")
        client = FakeCheapModerationClient(
            ["not-json", "still not json", "bad again", "still bad"]
        )
        job_id = "domain-event-3-maidan-moderation"
        redis.add_job(
            job_id,
            "message.created",
            message_created_job_data(event_id=3, message_id=MESSAGE_ID),
            {"attempts": 2},
        )
        consumer = build_consumer(redis, store, client)

        first_processed = await consumer.process_once()
        first_record = store.records[f"message:{MESSAGE_ID}"]

        assert first_processed == 1
        assert first_record.moderation_status == "pending"
        assert first_record.is_hidden is False
        assert redis.failed == set()
        assert redis.lists[redis.key("wait")] == [job_id]

        second_processed = await consumer.process_once()
        second_record = store.records[f"message:{MESSAGE_ID}"]

        assert second_processed == 1
        assert second_record.moderation_status == "pending"
        assert second_record.is_hidden is False
        assert redis.failed == {job_id}
        assert redis.stream_len(redis.key("dead-letter")) == 1
        assert store.ai_jobs[(MODERATION_QUEUE_JOB_KIND, job_id)]["status"] == "dead_letter"
        assert store.ai_jobs[(MODERATION_DECISION_JOB_KIND, f"message:{MESSAGE_ID}")][
            "status"
        ] == "dead_letter"

    asyncio.run(run())


def test_moderation_repairs_invalid_json_before_applying() -> None:
    async def run() -> None:
        redis = FakeBullMqRedis(prefix="maidan", queue_name=QUEUE_MODERATION)
        store = FakeModerationStore()
        store.add_message(MESSAGE_ID, "See you at the trailhead.")
        client = FakeCheapModerationClient(
            [
                "not-json",
                json.dumps(
                    {
                        "allow": True,
                        "categories": [],
                        "severity": 0,
                        "reason": "Benign ride coordination.",
                    }
                ),
            ]
        )
        redis.add_job(
            "domain-event-4-maidan-moderation",
            "message.created",
            message_created_job_data(event_id=4, message_id=MESSAGE_ID),
            {"attempts": 1},
        )
        consumer = build_consumer(redis, store, client)

        processed = await consumer.process_once()

        assert processed == 1
        assert len(client.calls) == 2
        assert "failed JSON validation" in str(client.calls[1]["prompt"])
        record = store.records[f"message:{MESSAGE_ID}"]
        assert record.moderation_status == "ok"
        assert record.is_hidden is False

    asyncio.run(run())


def test_moderation_response_rejects_non_json() -> None:
    item = ModerationItem(
        job_id="job-1",
        event=cast(DomainEvent, message_created_job_data(event_id=4, message_id=MESSAGE_ID)),
        content=ModerationContent(
            target_type="message",
            target_id=MESSAGE_ID,
            author_id=AUTHOR_ID,
            body="Hello",
            moderation_status="pending",
            is_hidden=False,
        ),
    )

    try:
        parse_moderation_response("```json\n{}\n```", [item])
    except ModerationModelOutputError:
        return

    raise AssertionError("non-JSON moderation output was accepted")


def build_consumer(
    redis: FakeBullMqRedis,
    store: FakeModerationStore,
    client: FakeCheapModerationClient,
) -> BullMqModerationConsumer:
    return BullMqModerationConsumer(
        redis=redis,
        processor=ModerationQueueProcessor(store, ModerationService(client)),
        config=ModerationQueueConfig(
            queue_name=QUEUE_MODERATION,
            prefix="maidan",
            block_timeout_seconds=0,
            batch_size=8,
            batch_window_seconds=0,
        ),
    )


def message_created_job_data(event_id: int, message_id: str) -> JsonObject:
    return {
        "id": event_id,
        "aggregate_type": "message",
        "aggregate_id": message_id,
        "event_type": "message.created",
        "payload": {
            "message_id": message_id,
            "chat_id": CHAT_ID,
            "sender_id": AUTHOR_ID,
            "activity_id": None,
            "body": "ignored; worker fetches from database",
            "created_at": "2026-06-18T00:00:00.000Z",
        },
        "created_at": "2026-06-18T00:00:00.000Z",
        "stream_entry_id": "1-0",
    }


@dataclass
class StoredModerationRecord:
    target_type: str
    target_id: str
    author_id: str
    body: str
    moderation_status: str = "pending"
    is_hidden: bool = False

    def to_content(self) -> ModerationContent:
        return ModerationContent(
            target_type=cast(ModerationTargetType, self.target_type),
            target_id=self.target_id,
            author_id=self.author_id,
            body=self.body,
            moderation_status=self.moderation_status,
            is_hidden=self.is_hidden,
        )


class FakeAiJob(TypedDict):
    status: str
    result: object


class FakeModerationStore:
    def __init__(self) -> None:
        self.records: dict[str, StoredModerationRecord] = {}
        self.attempts: dict[str, int] = defaultdict(int)
        self.ai_jobs: dict[tuple[str, str], FakeAiJob] = {}
        self.notification_events: list[JsonObject] = []

    def add_message(self, message_id: str, body: str) -> None:
        self.records[f"message:{message_id}"] = StoredModerationRecord(
            target_type="message",
            target_id=message_id,
            author_id=AUTHOR_ID,
            body=body,
        )

    async def fetch_content(self, event: DomainEvent) -> ModerationContent | None:
        payload = event["payload"]
        if not isinstance(payload, dict):
            return None
        message_id = payload.get("message_id")
        if not isinstance(message_id, str):
            return None
        record = self.records.get(f"message:{message_id}")
        if record is None:
            return None
        return record.to_content()

    async def begin_decision(self, item: ModerationItem) -> EventProcessingState:
        key = (MODERATION_DECISION_JOB_KIND, item.key)
        existing = self.ai_jobs.get(key)
        if existing is not None and existing["status"] in {"succeeded", "dead_letter"}:
            result = existing["result"]
            raw_attempts = result.get("attempts", 0) if isinstance(result, dict) else 0
            return EventProcessingState(
                already_finished=True,
                attempts=int(raw_attempts) if isinstance(raw_attempts, int | str) else 0,
            )

        self.attempts[item.key] += 1
        self.ai_jobs[key] = {
            "status": "processing",
            "result": {"attempts": self.attempts[item.key]},
        }
        return EventProcessingState(
            already_finished=False,
            attempts=self.attempts[item.key],
        )

    async def apply_decision(
        self,
        item: ModerationItem,
        decision: ModerationDecision,
    ) -> JsonObject:
        record = self.records[item.key]
        record.moderation_status = "ok" if decision.allow else "blocked"
        notification_event_id: int | None = None
        if not decision.allow and decision.severity >= 3:
            record.is_hidden = True
            self.notification_events.append(
                {
                    "target_type": record.target_type,
                    "target_id": record.target_id,
                    "author_id": record.author_id,
                    "severity": decision.severity,
                    "categories": list(decision.categories),
                    "reason": decision.reason,
                }
            )
            notification_event_id = len(self.notification_events)

        result: JsonObject = {
            "handler": "moderation_queue",
            "event_type": item.event["event_type"],
            "target_type": record.target_type,
            "target_id": record.target_id,
            "author_id": record.author_id,
            "moderation_status": record.moderation_status,
            "hidden": record.is_hidden,
            "notification_emitted": notification_event_id is not None,
            **decision.to_json(),
        }
        self.ai_jobs[(MODERATION_DECISION_JOB_KIND, item.key)] = {
            "status": "succeeded",
            "result": result,
        }
        return result

    async def mark_decision_failed(
        self,
        item: ModerationItem,
        error: str,
        attempts: int,
        *,
        dead_letter_entry_id: str | None = None,
    ) -> None:
        self.ai_jobs[(MODERATION_DECISION_JOB_KIND, item.key)] = {
            "status": "dead_letter" if dead_letter_entry_id is not None else "failed",
            "result": {
                "attempts": attempts,
                "last_error": error,
                "dead_letter_entry_id": dead_letter_entry_id,
            },
        }

    async def record_queue_failure(
        self,
        job: BullMqJob,
        error: str,
        action: BullMqFailureAction,
    ) -> None:
        self.ai_jobs[(MODERATION_QUEUE_JOB_KIND, job.id)] = {
            "status": "dead_letter" if action.dead_lettered else "failed",
            "result": {
                "attempts": action.attempts_made,
                "last_error": error,
                "dead_letter_entry_id": action.dead_letter_entry_id,
            },
        }


class FakeCheapModerationClient:
    def __init__(self, responses: list[str]) -> None:
        self.responses = responses
        self.calls: list[JsonObject] = []

    async def cheap_call(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 512,
    ) -> str:
        self.calls.append(
            {
                "prompt": prompt,
                "system": system,
                "max_tokens": max_tokens,
            }
        )
        return self.responses.pop(0)


class FakeBullMqRedis:
    def __init__(self, prefix: str, queue_name: str) -> None:
        self.queue_key = f"{prefix}:{queue_name}"
        self.lists: dict[str, list[str]] = defaultdict(list)
        self.hashes: dict[str, dict[str, str]] = defaultdict(dict)
        self.streams: dict[str, list[JsonObject]] = defaultdict(list)
        self.completed: set[str] = set()
        self.failed: set[str] = set()
        self._sequence = 0

    def key(self, suffix: str) -> str:
        return f"{self.queue_key}:{suffix}"

    def add_job(self, job_id: str, name: str, data: object, opts: object) -> None:
        self.hashes[self.key(job_id)] = {
            "name": name,
            "data": json.dumps(data),
            "opts": json.dumps(opts),
        }
        self.lists[self.key("wait")].insert(0, job_id)

    def stream_len(self, key: str) -> int:
        return len(self.streams[key])

    async def execute_command(self, *args: object, **options: object) -> object:
        del options
        command = str(args[0]).upper()
        if command in {"BRPOPLPUSH", "RPOPLPUSH"}:
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
            if str(args[1]) == self.key("failed"):
                self.failed.add(str(args[3]))
            return 1
        if command == "XADD":
            self._sequence += 1
            key = str(args[1])
            entry: JsonObject = {
                str(args[index]): str(args[index + 1]) for index in range(3, len(args), 2)
            }
            self.streams[key].append(entry)
            return f"{self._sequence}-0"
        if command == "SET":
            return "OK"
        if command == "DEL":
            return 1
        if command == "LPUSH":
            self.lists[str(args[1])].insert(0, str(args[2]))
            return len(self.lists[str(args[1])])
        raise AssertionError(f"Unsupported Redis command: {command}")
