from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal, Protocol, cast

from maidan_ai.config import Settings
from maidan_ai.db import DbPool, create_db_pool
from maidan_ai.domain_events import JsonObject, JsonValue

logger = logging.getLogger(__name__)

Pillar = Literal["move", "learn", "feel"]
HOST_NUDGE_JOB_KIND = "host_nudge"
STRUCTURED_OUTPUT_REPAIR_ATTEMPTS = 1

DEMAND_SENSING_RUBRIC = "\n".join(
    [
        "You are Maidan's demand-sensing analyst for a Bengaluru wellness and lifestyle "
        "marketplace.",
        "",
        "Read batched area/pillar demand buckets and return latent demand signals. Use only the "
        "provided aggregate evidence. Treat recent bookings, profile-interest clusters, posts, "
        "chat topics, and high fill rates as demand. Treat low open slots or no open slots for "
        "the requested tags as unmet supply.",
        "",
        "Return only valid JSON. Do not wrap it in Markdown. Return one signal for every input "
        "bucket with exactly these keys: id, area, pillar, signal_strength, unmet_interest, "
        "suggested_action, evidence. signal_strength must be a number from 0 to 1. "
        "unmet_interest must be short lowercase tags. evidence must be a non-empty array of "
        "brief statements grounded in the input counts or samples.",
    ]
)

INTEREST_TO_PILLAR: dict[str, Pillar] = {
    "art therapy": "feel",
    "badminton": "move",
    "birding": "learn",
    "boxing": "move",
    "breathwork": "feel",
    "coffee": "learn",
    "community": "feel",
    "conditioning": "move",
    "cycling": "move",
    "fermentation": "learn",
    "food": "learn",
    "gardening": "learn",
    "journaling": "feel",
    "language": "learn",
    "meditation": "feel",
    "mobility": "move",
    "movement": "move",
    "nature walk": "learn",
    "photography": "learn",
    "pickleball": "move",
    "pottery": "learn",
    "running": "move",
    "skating": "move",
    "sleep": "feel",
    "sound": "feel",
    "sound bath": "feel",
    "strength": "move",
    "sunrise": "move",
    "trees": "learn",
    "trails": "move",
    "yin": "feel",
    "yin yoga": "feel",
    "yoga": "move",
}


class CheapDemandSensingClient(Protocol):
    async def cheap_call(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 512,
    ) -> str:
        pass


class DemandSensingStore(Protocol):
    async def fetch_buckets(
        self,
        *,
        window_start: datetime,
        window_end: datetime,
        supply_window_end: datetime,
    ) -> list[DemandBucket]:
        pass

    async def persist_signals(
        self,
        signals: Sequence[DemandSignal],
        buckets: Mapping[str, DemandBucket],
        *,
        window_start: datetime,
        window_end: datetime,
        config: DemandSensingRunConfig,
    ) -> DemandPersistenceResult:
        pass


@dataclass(frozen=True)
class DemandTag:
    tag: str
    score: float
    sources: tuple[str, ...]

    def to_json(self) -> JsonObject:
        return {
            "tag": self.tag,
            "score": round(self.score, 3),
            "sources": list(self.sources),
        }


@dataclass(frozen=True)
class DemandBucket:
    id: str
    area: str
    pillar: Pillar
    booking_count: int
    booking_headcount: int
    pending_booking_count: int
    post_count: int
    message_count: int
    interested_explorer_count: int
    activity_count: int
    open_slot_count: int
    open_seat_count: int
    avg_fill_rate: float
    tags: tuple[DemandTag, ...]
    evidence: tuple[str, ...]
    source_counts: dict[str, int]
    open_slots_by_tag: dict[str, int]
    open_seats_by_tag: dict[str, int]
    demand_score: float

    def prompt_json(self) -> JsonObject:
        return {
            "id": self.id,
            "area": self.area,
            "pillar": self.pillar,
            "source_counts": cast(JsonValue, self.source_counts),
            "booking_headcount": self.booking_headcount,
            "pending_booking_count": self.pending_booking_count,
            "interested_explorer_count": self.interested_explorer_count,
            "activity_count": self.activity_count,
            "open_slot_count": self.open_slot_count,
            "open_seat_count": self.open_seat_count,
            "avg_fill_rate": round(self.avg_fill_rate, 3),
            "tags": [tag.to_json() for tag in self.tags],
            "open_slots_by_tag": cast(JsonValue, self.open_slots_by_tag),
            "evidence": list(self.evidence),
        }


@dataclass(frozen=True)
class DemandSignal:
    bucket_id: str
    area: str
    pillar: Pillar
    signal_strength: float
    unmet_interest: tuple[str, ...]
    suggested_action: str
    evidence: tuple[str, ...]

    def to_json(self) -> JsonObject:
        return {
            "area": self.area,
            "pillar": self.pillar,
            "signal_strength": round(self.signal_strength, 4),
            "unmet_interest": list(self.unmet_interest),
            "suggested_action": self.suggested_action,
            "evidence": list(self.evidence),
        }


@dataclass(frozen=True)
class DemandSensingRunConfig:
    window_days: int = 14
    supply_horizon_days: int = 30
    max_buckets_per_call: int = 12
    strong_signal_threshold: float = 0.7
    thin_open_slot_threshold: int = 0


@dataclass(frozen=True)
class DemandPersistenceResult:
    demand_signal_count: int
    host_nudge_count: int
    demand_signal_ids: tuple[str, ...]


@dataclass(frozen=True)
class DemandSensingRunResult:
    window_start: datetime
    window_end: datetime
    bucket_count: int
    demand_signal_count: int
    host_nudge_count: int

    def to_json(self) -> JsonObject:
        return {
            "window_start": self.window_start.isoformat().replace("+00:00", "Z"),
            "window_end": self.window_end.isoformat().replace("+00:00", "Z"),
            "bucket_count": self.bucket_count,
            "demand_signal_count": self.demand_signal_count,
            "host_nudge_count": self.host_nudge_count,
        }


class DemandSensingModelOutputError(ValueError):
    pass


class DemandSensingRepository:
    def __init__(self, pool: DbPool) -> None:
        self._pool = pool

    async def fetch_buckets(
        self,
        *,
        window_start: datetime,
        window_end: datetime,
        supply_window_end: datetime,
    ) -> list[DemandBucket]:
        async with self._pool.acquire() as connection:
            booking_rows = await connection.fetch(_BOOKING_SIGNALS_SQL, window_start, window_end)
            post_rows = await connection.fetch(_POST_SIGNALS_SQL, window_start, window_end)
            message_rows = await connection.fetch(_MESSAGE_SIGNALS_SQL, window_start, window_end)
            interest_rows = await connection.fetch(_INTEREST_SIGNALS_SQL, window_end)
            supply_rows = await connection.fetch(_SUPPLY_SQL, window_end, supply_window_end)

        builder = DemandBucketBuilder()
        for row in booking_rows:
            builder.add_booking(row)
        for row in post_rows:
            builder.add_post(row)
        for row in message_rows:
            builder.add_message(row)
        for row in interest_rows:
            builder.add_profile_interests(row)
        for row in supply_rows:
            builder.apply_supply(row)

        return builder.buckets()

    async def persist_signals(
        self,
        signals: Sequence[DemandSignal],
        buckets: Mapping[str, DemandBucket],
        *,
        window_start: datetime,
        window_end: datetime,
        config: DemandSensingRunConfig,
    ) -> DemandPersistenceResult:
        signal_ids: list[str] = []
        host_nudge_count = 0

        async with self._pool.acquire() as connection:
            async with connection.transaction():
                for signal in signals:
                    bucket = buckets[signal.bucket_id]
                    evidence = demand_signal_evidence(signal, bucket)
                    inserted = await connection.fetchrow(
                        """
                        insert into demand_signals (
                          area,
                          pillar,
                          signal_strength,
                          "window",
                          evidence
                        )
                        values (
                          $1,
                          $2::activity_pillar,
                          $3::numeric,
                          tstzrange($4::timestamptz, $5::timestamptz, '[)'),
                          $6::jsonb
                        )
                        returning id::text
                        """,
                        signal.area,
                        signal.pillar,
                        f"{signal.signal_strength:.4f}",
                        window_start,
                        window_end,
                        json.dumps(evidence),
                    )
                    if inserted is None:
                        raise RuntimeError("demand_signals insert did not return an id")

                    signal_id = str(inserted["id"])
                    signal_ids.append(signal_id)

                    if should_create_host_nudge(signal, bucket, config):
                        await connection.execute(
                            """
                            insert into ai_jobs (kind, ref_id, status, payload, result)
                            values ($1, $2, 'succeeded', $3::jsonb, $4::jsonb)
                            on conflict (kind, ref_id) do update
                            set status = 'succeeded',
                                payload = excluded.payload,
                                result = excluded.result
                            """,
                            HOST_NUDGE_JOB_KIND,
                            host_nudge_ref_id(signal, window_start, window_end),
                            json.dumps(host_nudge_payload(signal, bucket, signal_id, evidence)),
                            json.dumps(host_nudge_result(signal, bucket)),
                        )
                        host_nudge_count += 1

        return DemandPersistenceResult(
            demand_signal_count=len(signal_ids),
            host_nudge_count=host_nudge_count,
            demand_signal_ids=tuple(signal_ids),
        )


class DemandSensingService:
    def __init__(self, client: CheapDemandSensingClient) -> None:
        self._client = client

    async def analyse(self, buckets: Sequence[DemandBucket]) -> list[DemandSignal]:
        if not buckets:
            return []

        prompt = build_demand_prompt(buckets)
        max_tokens = max_tokens_for_buckets(buckets)
        last_error: DemandSensingModelOutputError | None = None
        signals_by_bucket_id: dict[str, DemandSignal] | None = None

        for attempt in range(STRUCTURED_OUTPUT_REPAIR_ATTEMPTS + 1):
            raw_response = await self._client.cheap_call(
                prompt,
                system=DEMAND_SENSING_RUBRIC,
                max_tokens=max_tokens,
            )
            try:
                signals_by_bucket_id = parse_demand_response(raw_response, buckets)
                break
            except DemandSensingModelOutputError as error:
                last_error = error
                if attempt >= STRUCTURED_OUTPUT_REPAIR_ATTEMPTS:
                    raise
                prompt = build_demand_repair_prompt(
                    original_prompt=build_demand_prompt(buckets),
                    invalid_response=raw_response,
                    validation_error=str(error),
                )
        if signals_by_bucket_id is None:
            raise DemandSensingModelOutputError(str(last_error))

        return [signals_by_bucket_id[bucket.id] for bucket in buckets]


class DemandSensingRunner:
    def __init__(
        self,
        store: DemandSensingStore,
        service: DemandSensingService,
        config: DemandSensingRunConfig,
    ) -> None:
        self._store = store
        self._service = service
        self._config = config

    async def run_once(self, *, run_at: datetime | None = None) -> DemandSensingRunResult:
        window_end = utc_datetime(run_at)
        window_start = window_end - timedelta(days=self._config.window_days)
        supply_window_end = window_end + timedelta(days=self._config.supply_horizon_days)
        buckets = await self._store.fetch_buckets(
            window_start=window_start,
            window_end=window_end,
            supply_window_end=supply_window_end,
        )
        if not buckets:
            return DemandSensingRunResult(
                window_start=window_start,
                window_end=window_end,
                bucket_count=0,
                demand_signal_count=0,
                host_nudge_count=0,
            )

        signals: list[DemandSignal] = []
        for batch in batched(buckets, self._config.max_buckets_per_call):
            signals.extend(await self._service.analyse(batch))

        persistence = await self._store.persist_signals(
            signals,
            {bucket.id: bucket for bucket in buckets},
            window_start=window_start,
            window_end=window_end,
            config=self._config,
        )
        return DemandSensingRunResult(
            window_start=window_start,
            window_end=window_end,
            bucket_count=len(buckets),
            demand_signal_count=persistence.demand_signal_count,
            host_nudge_count=persistence.host_nudge_count,
        )


@dataclass(frozen=True)
class DemandSensingSchedulerConfig:
    initial_delay_seconds: float = 60.0
    interval_seconds: float = 86_400.0


class DemandSensingScheduler:
    def __init__(
        self,
        runner: DemandSensingRunner,
        config: DemandSensingSchedulerConfig,
    ) -> None:
        self._runner = runner
        self._config = config
        self._running = False
        self._task: asyncio.Task[None] | None = None

    @property
    def running(self) -> bool:
        return self._running

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(
            self.run_forever(),
            name="maidan-ai-demand-sensing-scheduler",
        )

    async def stop(self) -> None:
        self._running = False
        task = self._task
        if task is None:
            return
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    async def run_forever(self) -> None:
        if self._config.initial_delay_seconds > 0:
            await asyncio.sleep(self._config.initial_delay_seconds)

        while self._running:
            try:
                result = await self._runner.run_once()
                logger.info(
                    "demand_sensing_run_completed buckets=%s signals=%s host_nudges=%s",
                    result.bucket_count,
                    result.demand_signal_count,
                    result.host_nudge_count,
                )
                await asyncio.sleep(self._config.interval_seconds)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("demand_sensing_run_failed")
                await asyncio.sleep(min(self._config.interval_seconds, 3600.0))


class DemandBucketBuilder:
    def __init__(self) -> None:
        self._buckets: dict[tuple[str, Pillar], _MutableBucket] = {}

    def add_booking(self, row: Mapping[str, object]) -> None:
        pillar = pillar_from_text(row.get("pillar"))
        if pillar is None:
            return
        area = normalize_area(row.get("area"))
        tag = normalize_tag(row.get("tag"))
        status = str(row.get("status", ""))
        headcount = json_int(row.get("headcount"), fallback=1)
        weight = float(headcount) * (2.0 if status == "confirmed" else 1.2)
        activity_title = compact_text(row.get("activity_title"), fallback="activity")
        activity_area = compact_text(row.get("activity_area"), fallback=area)
        bucket = self._bucket(area, pillar)
        bucket.add_signal(
            source="booking",
            tag=tag,
            weight=weight,
            evidence=(
                f"{headcount} {status} booking headcount for {activity_title} "
                f"from {area} explorer demand"
            ),
        )
        bucket.booking_count += 1
        bucket.booking_headcount += headcount
        if status == "pending":
            bucket.pending_booking_count += 1
        if activity_area != area:
            bucket.add_evidence(
                f"Demand is from {area} even though the booked supply is in {activity_area}"
            )

    def add_post(self, row: Mapping[str, object]) -> None:
        area = normalize_area(row.get("area"))
        pillar = pillar_from_text(row.get("pillar"))
        tag = normalize_tag(row.get("tag"))
        if pillar is not None and tag:
            activity_title = compact_text(row.get("activity_title"), fallback="linked activity")
            bucket = self._bucket(area, pillar)
            bucket.add_signal(
                source="post",
                tag=tag,
                weight=0.7,
                evidence=f"Recent post discusses {activity_title}",
            )
            bucket.post_count += 1
            return

        body = compact_text(row.get("body"), fallback="")
        interests = text_array(row.get("interests"))
        for interest in matched_interests((*interests, *tags_from_text(body))):
            inferred_pillar = INTEREST_TO_PILLAR[interest]
            bucket = self._bucket(area, inferred_pillar)
            bucket.add_signal(
                source="post",
                tag=interest,
                weight=0.4,
                evidence=f"Unlinked recent post in {area} aligns with {interest}",
            )
            bucket.post_count += 1

    def add_message(self, row: Mapping[str, object]) -> None:
        pillar = pillar_from_text(row.get("pillar"))
        if pillar is None:
            return
        area = normalize_area(row.get("area"))
        tag = normalize_tag(row.get("tag"))
        bucket = self._bucket(area, pillar)
        bucket.add_signal(
            source="message",
            tag=tag,
            weight=0.25,
            evidence=(
                "Recent chat topic on "
                f"{compact_text(row.get('activity_title'), fallback='activity')}"
            ),
        )
        bucket.message_count += 1

    def add_profile_interests(self, row: Mapping[str, object]) -> None:
        area = normalize_area(row.get("area"))
        profile_id = str(row.get("profile_id", ""))
        for interest in matched_interests(text_array(row.get("interests"))):
            pillar = INTEREST_TO_PILLAR[interest]
            bucket = self._bucket(area, pillar)
            bucket.add_signal(
                source="profile_interest",
                tag=interest,
                weight=0.6,
                evidence=f"Explorer interest cluster in {area} includes {interest}",
            )
            if profile_id:
                bucket.interested_explorer_ids.add(profile_id)

    def apply_supply(self, row: Mapping[str, object]) -> None:
        pillar = pillar_from_text(row.get("pillar"))
        if pillar is None:
            return
        area = normalize_area(row.get("area"))
        key = (area, pillar)
        bucket = self._buckets.get(key)
        if bucket is None:
            return

        tag = normalize_tag(row.get("tag"))
        open_slots = json_int(row.get("open_slot_count"), fallback=0)
        open_seats = json_int(row.get("open_seat_count"), fallback=0)
        activity_count = json_int(row.get("activity_count"), fallback=0)
        avg_fill_rate = json_float(row.get("avg_fill_rate"), fallback=0.0)

        bucket.activity_count += activity_count
        bucket.open_slot_count += open_slots
        bucket.open_seat_count += open_seats
        if tag:
            bucket.open_slots_by_tag[tag] += open_slots
            bucket.open_seats_by_tag[tag] += open_seats
        if avg_fill_rate > bucket.avg_fill_rate:
            bucket.avg_fill_rate = avg_fill_rate

    def buckets(self) -> list[DemandBucket]:
        snapshots = [bucket.snapshot() for bucket in self._buckets.values()]
        return sorted(
            (bucket for bucket in snapshots if bucket.demand_score > 0),
            key=lambda bucket: (-bucket.demand_score, bucket.area, bucket.pillar),
        )

    def _bucket(self, area: str, pillar: Pillar) -> _MutableBucket:
        key = (area, pillar)
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = _MutableBucket(area=area, pillar=pillar)
            self._buckets[key] = bucket
        return bucket


@dataclass
class _MutableBucket:
    area: str
    pillar: Pillar
    booking_count: int = 0
    booking_headcount: int = 0
    pending_booking_count: int = 0
    post_count: int = 0
    message_count: int = 0
    activity_count: int = 0
    open_slot_count: int = 0
    open_seat_count: int = 0
    avg_fill_rate: float = 0.0

    def __post_init__(self) -> None:
        self.source_counts: Counter[str] = Counter()
        self.tag_scores: defaultdict[str, float] = defaultdict(float)
        self.tag_sources: dict[str, set[str]] = defaultdict(set)
        self.evidence: list[str] = []
        self.interested_explorer_ids: set[str] = set()
        self.open_slots_by_tag: Counter[str] = Counter()
        self.open_seats_by_tag: Counter[str] = Counter()

    def add_signal(self, *, source: str, tag: str, weight: float, evidence: str) -> None:
        self.source_counts[source] += 1
        if tag:
            self.tag_scores[tag] += weight
            self.tag_sources[tag].add(source)
        self.add_evidence(evidence)

    def add_evidence(self, evidence: str) -> None:
        normalized = " ".join(evidence.split())
        if normalized and normalized not in self.evidence and len(self.evidence) < 10:
            self.evidence.append(normalized)

    def snapshot(self) -> DemandBucket:
        tags = tuple(
            DemandTag(
                tag=tag,
                score=float(score),
                sources=tuple(sorted(self.tag_sources[tag])),
            )
            for tag, score in sorted(
                self.tag_scores.items(),
                key=lambda item: (-item[1], item[0]),
            )[:8]
        )
        evidence = list(self.evidence[:8])
        if self.open_slot_count == 0:
            evidence.append(f"No open {self.pillar} slots in {self.area} over the supply horizon")
        else:
            evidence.append(
                f"{self.open_slot_count} open {self.pillar} slots and "
                f"{self.open_seat_count} open seats in {self.area}"
            )

        demand_score = (
            self.booking_headcount * 1.5
            + self.pending_booking_count * 0.8
            + len(self.interested_explorer_ids) * 0.75
            + self.post_count * 0.5
            + self.message_count * 0.25
            + max(self.avg_fill_rate - 0.6, 0) * 3.0
        )

        return DemandBucket(
            id=bucket_id(self.area, self.pillar),
            area=self.area,
            pillar=self.pillar,
            booking_count=self.booking_count,
            booking_headcount=self.booking_headcount,
            pending_booking_count=self.pending_booking_count,
            post_count=self.post_count,
            message_count=self.message_count,
            interested_explorer_count=len(self.interested_explorer_ids),
            activity_count=self.activity_count,
            open_slot_count=self.open_slot_count,
            open_seat_count=self.open_seat_count,
            avg_fill_rate=self.avg_fill_rate,
            tags=tags,
            evidence=tuple(evidence),
            source_counts=dict(self.source_counts),
            open_slots_by_tag=dict(self.open_slots_by_tag),
            open_seats_by_tag=dict(self.open_seats_by_tag),
            demand_score=demand_score,
        )


def build_demand_prompt(buckets: Sequence[DemandBucket]) -> str:
    payload: JsonObject = {"buckets": [bucket.prompt_json() for bucket in buckets]}
    buckets_json = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    return (
        "Produce demand signals for these area/pillar buckets using the cached rubric. "
        "Return ONLY JSON shaped as "
        '{"signals":[{"id":string,"area":string,"pillar":"move|learn|feel",'
        '"signal_strength":0-1,"unmet_interest":[string],'
        '"suggested_action":string,"evidence":[string]}]}.\n'
        f"Input: {buckets_json}"
    )


def build_demand_repair_prompt(
    *,
    original_prompt: str,
    invalid_response: str,
    validation_error: str,
) -> str:
    return (
        "The previous demand-sensing response failed JSON validation. Return ONLY a corrected "
        "JSON response for the original request. Do not include reasoning, Markdown, or "
        "commentary.\n"
        f"Validation error: {validation_error}\n"
        f"Original request:\n{original_prompt}\n"
        f"Invalid response:\n{invalid_response}"
    )


def parse_demand_response(
    raw_response: str,
    buckets: Sequence[DemandBucket],
) -> dict[str, DemandSignal]:
    try:
        parsed = json.loads(raw_response)
    except json.JSONDecodeError as error:
        raise DemandSensingModelOutputError(
            f"demand-sensing response is not JSON: {error.msg}"
        ) from error

    raw_signals: object
    if isinstance(parsed, dict) and isinstance(parsed.get("signals"), list):
        raw_signals = parsed["signals"]
    elif isinstance(parsed, dict) and "area" in parsed:
        raw_signals = [parsed]
    elif isinstance(parsed, list):
        raw_signals = parsed
    else:
        raise DemandSensingModelOutputError("demand-sensing response is missing signals")

    bucket_by_id = {bucket.id: bucket for bucket in buckets}
    bucket_by_area_pillar = {(bucket.area, bucket.pillar): bucket for bucket in buckets}
    signals: dict[str, DemandSignal] = {}

    if not isinstance(raw_signals, list):
        raise DemandSensingModelOutputError("demand-sensing signals must be an array")

    for raw_signal in raw_signals:
        if not isinstance(raw_signal, dict):
            raise DemandSensingModelOutputError("demand-sensing signal must be an object")
        signal = demand_signal_from_json(raw_signal, bucket_by_id, bucket_by_area_pillar)
        if signal.bucket_id in signals:
            raise DemandSensingModelOutputError(f"duplicate signal id: {signal.bucket_id}")
        signals[signal.bucket_id] = signal

    missing = [bucket.id for bucket in buckets if bucket.id not in signals]
    extra = [signal_id for signal_id in signals if signal_id not in bucket_by_id]
    if missing or extra:
        raise DemandSensingModelOutputError(
            f"demand-sensing signals do not match buckets missing={missing} extra={extra}"
        )

    return signals


def demand_signal_from_json(
    raw: Mapping[str, object],
    bucket_by_id: Mapping[str, DemandBucket],
    bucket_by_area_pillar: Mapping[tuple[str, Pillar], DemandBucket],
) -> DemandSignal:
    raw_id = raw.get("id")
    bucket: DemandBucket | None = None
    if isinstance(raw_id, str) and raw_id:
        bucket = bucket_by_id.get(raw_id)

    area = required_text(raw, "area")
    pillar = required_pillar(raw, "pillar")
    if bucket is None:
        bucket = bucket_by_area_pillar.get((area, pillar))
    if bucket is None:
        raise DemandSensingModelOutputError(f"unknown demand bucket: {area}/{pillar}")

    strength = json_float(raw.get("signal_strength"), fallback=-1)
    if strength < 0 or strength > 1:
        raise DemandSensingModelOutputError("signal_strength must be between 0 and 1")

    unmet_interest = tuple(
        tag
        for tag in (normalize_tag(item) for item in required_text_list(raw, "unmet_interest"))
        if tag
    )
    suggested_action = required_text(raw, "suggested_action")
    evidence = tuple(required_text_list(raw, "evidence"))
    if not evidence:
        raise DemandSensingModelOutputError("evidence must be non-empty")

    return DemandSignal(
        bucket_id=bucket.id,
        area=bucket.area,
        pillar=bucket.pillar,
        signal_strength=strength,
        unmet_interest=unmet_interest,
        suggested_action=suggested_action,
        evidence=evidence,
    )


def demand_signal_evidence(signal: DemandSignal, bucket: DemandBucket) -> JsonObject:
    return {
        "model_evidence": list(signal.evidence),
        "source_counts": cast(JsonValue, bucket.source_counts),
        "source_samples": list(bucket.evidence),
        "tags": [tag.to_json() for tag in bucket.tags],
        "supply": {
            "activity_count": bucket.activity_count,
            "open_slot_count": bucket.open_slot_count,
            "open_seat_count": bucket.open_seat_count,
            "avg_fill_rate": round(bucket.avg_fill_rate, 3),
            "open_slots_by_tag": cast(JsonValue, bucket.open_slots_by_tag),
            "open_seats_by_tag": cast(JsonValue, bucket.open_seats_by_tag),
        },
        "unmet_interest": list(signal.unmet_interest),
        "suggested_action": signal.suggested_action,
    }


def should_create_host_nudge(
    signal: DemandSignal,
    bucket: DemandBucket,
    config: DemandSensingRunConfig,
) -> bool:
    if signal.signal_strength < config.strong_signal_threshold:
        return False

    if bucket.open_slot_count <= config.thin_open_slot_threshold:
        return True

    if not signal.unmet_interest:
        return False

    return all(
        bucket.open_slots_by_tag.get(tag, 0) <= config.thin_open_slot_threshold
        for tag in signal.unmet_interest
    )


def host_nudge_payload(
    signal: DemandSignal,
    bucket: DemandBucket,
    signal_id: str,
    evidence: JsonObject,
) -> JsonObject:
    return {
        "demand_signal_id": signal_id,
        "area": signal.area,
        "pillar": signal.pillar,
        "signal_strength": round(signal.signal_strength, 4),
        "unmet_interest": list(signal.unmet_interest),
        "suggested_action": signal.suggested_action,
        "evidence": evidence,
        "supply": {
            "open_slot_count": bucket.open_slot_count,
            "open_seat_count": bucket.open_seat_count,
            "open_slots_by_tag": cast(JsonValue, bucket.open_slots_by_tag),
        },
    }


def host_nudge_result(signal: DemandSignal, bucket: DemandBucket) -> JsonObject:
    missing_tags = [
        tag for tag in signal.unmet_interest if bucket.open_slots_by_tag.get(tag, 0) == 0
    ]
    reason = (
        f"strong_signal_no_open_{signal.pillar}_slots"
        if bucket.open_slot_count == 0
        else "strong_signal_no_open_slots_for_unmet_tags"
    )
    return {
        "status": "ready",
        "created_by": "demand_sensing",
        "reason": reason,
        "missing_tags": cast(JsonValue, missing_tags),
    }


def host_nudge_ref_id(signal: DemandSignal, window_start: datetime, window_end: datetime) -> str:
    basis = json.dumps(
        {
            "area": signal.area,
            "pillar": signal.pillar,
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "unmet_interest": list(signal.unmet_interest),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]
    return f"{slug(signal.area)}:{signal.pillar}:{digest}"


def max_tokens_for_buckets(buckets: Sequence[DemandBucket]) -> int:
    return min(4096, 512 + (256 * len(buckets)))


def bucket_id(area: str, pillar: Pillar) -> str:
    return f"{slug(area)}:{pillar}"


def slug(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return normalized or "area"


def matched_interests(values: Iterable[str]) -> tuple[str, ...]:
    matched: list[str] = []
    for value in values:
        tag = normalize_tag(value)
        if tag in INTEREST_TO_PILLAR and tag not in matched:
            matched.append(tag)
    return tuple(matched)


def tags_from_text(text: str) -> tuple[str, ...]:
    haystack = text.lower()
    return tuple(tag for tag in INTEREST_TO_PILLAR if tag in haystack)


def normalize_area(value: object) -> str:
    if isinstance(value, str) and value.strip():
        return " ".join(value.split())
    return "Bengaluru"


def normalize_tag(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.lower().replace("_", " ").split())


def pillar_from_text(value: object) -> Pillar | None:
    if value == "move" or value == "learn" or value == "feel":
        return value
    return None


def required_pillar(raw: Mapping[str, object], key: str) -> Pillar:
    pillar = pillar_from_text(raw.get(key))
    if pillar is None:
        raise DemandSensingModelOutputError(f"{key} must be move, learn, or feel")
    return pillar


def required_text(raw: Mapping[str, object], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise DemandSensingModelOutputError(f"{key} must be a non-empty string")
    return value.strip()


def required_text_list(raw: Mapping[str, object], key: str) -> list[str]:
    value = raw.get(key)
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    if not isinstance(value, list):
        raise DemandSensingModelOutputError(f"{key} must be an array of strings")
    texts: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise DemandSensingModelOutputError(f"{key} must be an array of non-empty strings")
        texts.append(item.strip())
    return texts


def compact_text(value: object, *, fallback: str) -> str:
    if not isinstance(value, str):
        return fallback
    compacted = " ".join(value.split())
    return compacted[:120] if compacted else fallback


def text_array(value: object) -> tuple[str, ...]:
    if isinstance(value, list):
        return tuple(item for item in value if isinstance(item, str))
    if isinstance(value, tuple):
        return tuple(item for item in value if isinstance(item, str))
    return ()


def json_int(value: object, *, fallback: int) -> int:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return fallback
    return fallback


def json_float(value: object, *, fallback: float) -> float:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return fallback
    return fallback


def utc_datetime(value: datetime | None) -> datetime:
    if value is None:
        return datetime.now(UTC)
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def batched(items: Sequence[DemandBucket], batch_size: int) -> Iterable[Sequence[DemandBucket]]:
    size = max(batch_size, 1)
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _area_sql(geography_sql: str) -> str:
    lat = f"st_y(({geography_sql})::geometry)"
    lng = f"st_x(({geography_sql})::geometry)"
    return f"""
        case
          when {geography_sql} is null then 'Bengaluru'
          when {lat} >= 13.2000 then 'Nandi Hills'
          when {lat} < 12.9200 then 'JP Nagar'
          when {lat} >= 12.9650 and {lng} < 77.6200 then 'Cubbon Park'
          when {lat} >= 12.9650 and {lng} >= 77.6200 then 'Indiranagar'
          when {lat} >= 12.9250 then 'Koramangala'
          else 'JP Nagar'
        end
    """


_BOOKING_SIGNALS_SQL = f"""
    select
      {_area_sql("coalesce(explorer.home_location, a.location)")} as area,
      {_area_sql("a.location")} as activity_area,
      a.pillar::text as pillar,
      lower(a.category) as tag,
      a.title as activity_title,
      b.status::text as status,
      b.headcount::int as headcount
    from bookings b
    join activity_slots s on s.id = b.slot_id
    join activities a on a.id = s.activity_id
    join profiles explorer on explorer.id = b.explorer_id
    where b.created_at >= $1::timestamptz
      and b.created_at < $2::timestamptz
      and b.status in ('confirmed'::booking_status, 'pending'::booking_status)
      and a.status = 'published'::activity_status
"""

_POST_SIGNALS_SQL = f"""
    select
      {_area_sql("coalesce(a.location, author.home_location)")} as area,
      a.pillar::text as pillar,
      lower(a.category) as tag,
      a.title as activity_title,
      p.body,
      author.interests
    from posts p
    join profiles author on author.id = p.author_id
    left join activities a on a.id = p.linked_activity_id
    where p.created_at >= $1::timestamptz
      and p.created_at < $2::timestamptz
      and p.is_hidden = false
      and (
        p.linked_activity_id is null
        or a.status = 'published'::activity_status
      )
"""

_MESSAGE_SIGNALS_SQL = f"""
    select
      {_area_sql("a.location")} as area,
      a.pillar::text as pillar,
      lower(a.category) as tag,
      a.title as activity_title,
      m.body
    from messages m
    join group_chats gc on gc.id = m.chat_id
    join activities a on a.id = gc.activity_id
    where m.created_at >= $1::timestamptz
      and m.created_at < $2::timestamptz
      and m.is_hidden = false
      and a.status = 'published'::activity_status
"""

_INTEREST_SIGNALS_SQL = f"""
    select
      {_area_sql("p.home_location")} as area,
      p.id::text as profile_id,
      p.interests
    from profiles p
    where p.home_location is not null
      and p.created_at < $1::timestamptz
      and not exists (
        select 1
        from host_profiles hp
        where hp.profile_id = p.id
      )
"""

_SUPPLY_SQL = f"""
    select
      {_area_sql("a.location")} as area,
      a.pillar::text as pillar,
      lower(a.category) as tag,
      count(distinct a.id)::int as activity_count,
      count(s.id) filter (
        where s.status = 'open'::slot_status
          and s.starts_at >= $1::timestamptz
          and s.starts_at < $2::timestamptz
          and s.booked_count < s.capacity
      )::int as open_slot_count,
      coalesce(
        sum(greatest(s.capacity - s.booked_count, 0)) filter (
          where s.status = 'open'::slot_status
            and s.starts_at >= $1::timestamptz
            and s.starts_at < $2::timestamptz
            and s.booked_count < s.capacity
        ),
        0
      )::int as open_seat_count,
      coalesce(
        avg((s.booked_count::numeric / nullif(s.capacity, 0))) filter (
          where s.starts_at >= $1::timestamptz
            and s.starts_at < $2::timestamptz
            and s.status in ('open'::slot_status, 'full'::slot_status)
        ),
        0
      )::float as avg_fill_rate
    from activities a
    left join activity_slots s on s.activity_id = a.id
    where a.status = 'published'::activity_status
    group by 1, 2, 3
"""


def config_from_settings(settings: Settings) -> DemandSensingRunConfig:
    return DemandSensingRunConfig(
        window_days=settings.demand_sensing_window_days,
        supply_horizon_days=settings.demand_sensing_supply_horizon_days,
        max_buckets_per_call=settings.demand_sensing_batch_size,
        strong_signal_threshold=settings.demand_sensing_strong_threshold,
        thin_open_slot_threshold=settings.demand_sensing_thin_open_slot_threshold,
    )


def scheduler_config_from_settings(settings: Settings) -> DemandSensingSchedulerConfig:
    return DemandSensingSchedulerConfig(
        initial_delay_seconds=settings.demand_sensing_initial_delay_seconds,
        interval_seconds=settings.demand_sensing_interval_seconds,
    )


async def run_from_settings(settings: Settings) -> DemandSensingRunResult:
    from maidan_ai.llm_provider import build_llm_provider

    pool = await create_db_pool(settings)
    try:
        runner = DemandSensingRunner(
            DemandSensingRepository(pool),
            DemandSensingService(build_llm_provider(settings)),
            config_from_settings(settings),
        )
        return await runner.run_once()
    finally:
        await pool.close()


async def async_main() -> None:
    result = await run_from_settings(Settings())
    print(json.dumps(result.to_json(), sort_keys=True))


def main() -> None:
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
