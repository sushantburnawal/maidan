from __future__ import annotations

import asyncio
import logging
from collections import Counter
from collections.abc import Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from typing import Literal, Protocol

from maidan_ai.db import DbPool
from maidan_ai.domain_events import JsonObject

logger = logging.getLogger(__name__)

Pillar = Literal["move", "learn", "feel"]
ParticipantRole = Literal["host", "attendee"]

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


@dataclass(frozen=True)
class MatchProfile:
    id: str
    display_name: str
    interests: tuple[str, ...]
    role: ParticipantRole


@dataclass(frozen=True)
class MatchActivityGroup:
    activity_id: str
    title: str
    pillar: Pillar
    category: str
    host: MatchProfile
    explorers: tuple[MatchProfile, ...]

    @property
    def participants(self) -> tuple[MatchProfile, ...]:
        return (self.host, *self.explorers)


@dataclass(frozen=True)
class ProfilePillarAffinity:
    same_pillar_count: int
    total_count: int

    @property
    def score(self) -> float:
        if self.total_count <= 0:
            return 0.0
        return clamp01(self.same_pillar_count / self.total_count)


@dataclass(frozen=True)
class MatchScore:
    profile_id: str
    activity_id: str
    score: float
    reason: str

    def to_json(self) -> JsonObject:
        return {
            "profile_id": self.profile_id,
            "activity_id": self.activity_id,
            "score": round(self.score, 4),
            "reason": self.reason,
        }


@dataclass(frozen=True)
class MatchmakingResult:
    activity_id: str
    score_count: int

    def to_json(self) -> JsonObject:
        return {
            "activity_id": self.activity_id,
            "score_count": self.score_count,
        }


@dataclass(frozen=True)
class MatchmakingRunResult:
    activity_count: int
    score_count: int

    def to_json(self) -> JsonObject:
        return {
            "activity_count": self.activity_count,
            "score_count": self.score_count,
        }


@dataclass(frozen=True)
class ActivityVibe:
    activity_id: str
    title: str
    pillar: Pillar
    participant_count: int
    people: tuple[MatchProfile, ...]
    shared_interests: tuple[tuple[str, int], ...]
    summary: str

    def to_json(self) -> JsonObject:
        return {
            "activity_id": self.activity_id,
            "title": self.title,
            "pillar": self.pillar,
            "participant_count": self.participant_count,
            "people": [
                {
                    "display_name": participant.display_name,
                    "role": participant.role,
                }
                for participant in self.people
            ],
            "shared_interests": [
                {
                    "tag": tag,
                    "count": count,
                }
                for tag, count in self.shared_interests
            ],
            "summary": self.summary,
        }


class MatchmakingStore(Protocol):
    async def fetch_activity_group(self, activity_id: str) -> MatchActivityGroup | None:
        pass

    async def fetch_activity_ids_for_recompute(self, limit: int) -> list[str]:
        pass

    async def fetch_pillar_affinities(
        self,
        profile_ids: Sequence[str],
        pillar: Pillar,
    ) -> dict[str, ProfilePillarAffinity]:
        pass

    async def fetch_embedding_similarity(
        self,
        profile_id: str,
        comparison_profile_ids: Sequence[str],
    ) -> float | None:
        pass

    async def upsert_match_scores(self, scores: Sequence[MatchScore]) -> None:
        pass


class MatchmakingRepository:
    def __init__(self, pool: DbPool) -> None:
        self._pool = pool

    async def fetch_activity_group(self, activity_id: str) -> MatchActivityGroup | None:
        async with self._pool.acquire() as connection:
            activity_row = await connection.fetchrow(
                """
                select
                  a.id::text,
                  a.title,
                  a.pillar::text,
                  a.category,
                  host.id::text as host_id,
                  host.display_name as host_display_name,
                  host.interests as host_interests
                from activities a
                join profiles host on host.id = a.host_id
                where a.id = $1::uuid
                  and a.status = 'published'::activity_status
                """,
                activity_id,
            )
            if activity_row is None:
                return None

            explorer_rows = await connection.fetch(
                """
                select distinct
                  explorer.id::text,
                  explorer.display_name,
                  explorer.interests
                from bookings b
                join activity_slots s on s.id = b.slot_id
                join profiles explorer on explorer.id = b.explorer_id
                where s.activity_id = $1::uuid
                  and b.status = 'confirmed'::booking_status
                order by explorer.display_name, explorer.id::text
                """,
                activity_id,
            )

        return activity_group_from_rows(activity_row, explorer_rows)

    async def fetch_activity_ids_for_recompute(self, limit: int) -> list[str]:
        rows = await self._pool.fetch(
            """
            select distinct a.id::text
            from activities a
            join activity_slots s on s.activity_id = a.id
            join bookings b on b.slot_id = s.id
            where a.status = 'published'::activity_status
              and b.status = 'confirmed'::booking_status
              and s.starts_at >= now()
            order by a.id::text
            limit $1
            """,
            max(limit, 1),
        )
        return [str(row["id"]) for row in rows]

    async def fetch_pillar_affinities(
        self,
        profile_ids: Sequence[str],
        pillar: Pillar,
    ) -> dict[str, ProfilePillarAffinity]:
        if not profile_ids:
            return {}

        rows = await self._pool.fetch(
            """
            with profile_scope as (
              select unnest($1::uuid[]) as profile_id
            ),
            profile_activity_pillars as (
              select distinct
                b.explorer_id as profile_id,
                a.id as activity_id,
                a.pillar
              from profile_scope ps
              join bookings b on b.explorer_id = ps.profile_id
              join activity_slots s on s.id = b.slot_id
              join activities a on a.id = s.activity_id
              where b.status = 'confirmed'::booking_status
                and a.status = 'published'::activity_status
              union
              select distinct
                a.host_id as profile_id,
                a.id as activity_id,
                a.pillar
              from profile_scope ps
              join activities a on a.host_id = ps.profile_id
              where a.status = 'published'::activity_status
            )
            select
              ps.profile_id::text,
              count(pap.activity_id)::int as total_count,
              count(pap.activity_id) filter (
                where pap.pillar = $2::activity_pillar
              )::int as same_pillar_count
            from profile_scope ps
            left join profile_activity_pillars pap on pap.profile_id = ps.profile_id
            group by ps.profile_id
            """,
            list(profile_ids),
            pillar,
        )

        return {
            str(row["profile_id"]): ProfilePillarAffinity(
                same_pillar_count=json_int(row.get("same_pillar_count"), fallback=0),
                total_count=json_int(row.get("total_count"), fallback=0),
            )
            for row in rows
        }

    async def fetch_embedding_similarity(
        self,
        profile_id: str,
        comparison_profile_ids: Sequence[str],
    ) -> float | None:
        if not comparison_profile_ids:
            return None

        async with self._pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                with target_activities as (
                  select distinct a.id, a.embedding
                  from bookings b
                  join activity_slots s on s.id = b.slot_id
                  join activities a on a.id = s.activity_id
                  where b.explorer_id = $1::uuid
                    and b.status = 'confirmed'::booking_status
                    and a.status = 'published'::activity_status
                    and a.embedding is not null
                ),
                comparison_activities as (
                  select distinct a.id, a.embedding
                  from bookings b
                  join activity_slots s on s.id = b.slot_id
                  join activities a on a.id = s.activity_id
                  where b.explorer_id = any($2::uuid[])
                    and b.status = 'confirmed'::booking_status
                    and a.status = 'published'::activity_status
                    and a.embedding is not null
                  union
                  select distinct a.id, a.embedding
                  from activities a
                  where a.host_id = any($2::uuid[])
                    and a.status = 'published'::activity_status
                    and a.embedding is not null
                )
                select avg(greatest(0::double precision, 1 - (
                  target_activities.embedding <=> comparison_activities.embedding
                )))::float8 as similarity
                from target_activities
                cross join comparison_activities
                where target_activities.id <> comparison_activities.id
                """,
                profile_id,
                list(comparison_profile_ids),
            )
        if row is None:
            return None

        similarity = row.get("similarity")
        if similarity is None:
            return None
        return clamp01(json_float(similarity, fallback=0.0))

    async def upsert_match_scores(self, scores: Sequence[MatchScore]) -> None:
        if not scores:
            return

        async with self._pool.acquire() as connection:
            async with connection.transaction():
                for score in scores:
                    await connection.execute(
                        """
                        insert into match_scores (
                          profile_id,
                          activity_id,
                          score,
                          reason
                        )
                        values ($1::uuid, $2::uuid, $3::numeric, $4)
                        on conflict (profile_id, activity_id) do update
                        set score = excluded.score,
                            reason = excluded.reason,
                            created_at = now()
                        """,
                        score.profile_id,
                        score.activity_id,
                        f"{score.score:.4f}",
                        score.reason,
                    )


class MatchmakingService:
    def __init__(self, store: MatchmakingStore) -> None:
        self._store = store

    async def compute_for_activity(self, activity_id: str) -> MatchmakingResult:
        group = await self._store.fetch_activity_group(activity_id)
        if group is None or not group.explorers:
            return MatchmakingResult(activity_id=activity_id, score_count=0)

        scores = await self._score_group(group)
        await self._store.upsert_match_scores(scores)
        return MatchmakingResult(activity_id=activity_id, score_count=len(scores))

    async def activity_vibe(self, activity_id: str) -> ActivityVibe | None:
        group = await self._store.fetch_activity_group(activity_id)
        if group is None:
            return None
        return build_activity_vibe(group)

    async def _score_group(self, group: MatchActivityGroup) -> list[MatchScore]:
        participant_ids = [participant.id for participant in group.participants]
        affinities = await self._store.fetch_pillar_affinities(participant_ids, group.pillar)
        scores: list[MatchScore] = []

        for explorer in group.explorers:
            comparison_profiles = [
                participant
                for participant in group.participants
                if participant.id != explorer.id
            ]
            comparison_ids = [participant.id for participant in comparison_profiles]
            shared_interests = shared_interest_tags(explorer, comparison_profiles)
            shared_component = shared_interest_component(shared_interests)
            embedding_similarity = await self._store.fetch_embedding_similarity(
                explorer.id,
                comparison_ids,
            )
            embedding_component = 0.0 if embedding_similarity is None else embedding_similarity
            pillar_component = pillar_affinity_component(
                explorer.id,
                comparison_ids,
                affinities,
                group,
            )
            score = clamp01(
                (shared_component * 0.45)
                + (embedding_component * 0.35)
                + (pillar_component * 0.20)
            )
            scores.append(
                MatchScore(
                    profile_id=explorer.id,
                    activity_id=group.activity_id,
                    score=score,
                    reason=match_reason(
                        shared_interests=shared_interests,
                        embedding_similarity=embedding_similarity,
                        pillar_affinity=pillar_component,
                        comparison_count=len(comparison_ids),
                    ),
                )
            )

        return scores


class MatchmakingRunner:
    def __init__(
        self,
        store: MatchmakingStore,
        service: MatchmakingService,
        *,
        batch_size: int = 100,
    ) -> None:
        self._store = store
        self._service = service
        self._batch_size = batch_size

    async def run_once(self) -> MatchmakingRunResult:
        activity_ids = await self._store.fetch_activity_ids_for_recompute(self._batch_size)
        score_count = 0
        for activity_id in activity_ids:
            result = await self._service.compute_for_activity(activity_id)
            score_count += result.score_count

        return MatchmakingRunResult(
            activity_count=len(activity_ids),
            score_count=score_count,
        )


@dataclass(frozen=True)
class MatchmakingSchedulerConfig:
    initial_delay_seconds: float = 60.0
    interval_seconds: float = 86_400.0


class MatchmakingScheduler:
    def __init__(
        self,
        runner: MatchmakingRunner,
        config: MatchmakingSchedulerConfig,
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
            name="maidan-ai-matchmaking-scheduler",
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
                    "matchmaking_run_completed activities=%s scores=%s",
                    result.activity_count,
                    result.score_count,
                )
                await asyncio.sleep(self._config.interval_seconds)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("matchmaking_run_failed")
                await asyncio.sleep(min(self._config.interval_seconds, 3600.0))


def build_activity_vibe(group: MatchActivityGroup) -> ActivityVibe:
    participants = group.participants
    shared_interests = group_shared_interests(participants)
    summary = vibe_summary(
        people=[participant.display_name for participant in participants[:4]],
        shared_interests=[tag for tag, _count in shared_interests[:4]],
    )
    return ActivityVibe(
        activity_id=group.activity_id,
        title=group.title,
        pillar=group.pillar,
        participant_count=len(participants),
        people=participants,
        shared_interests=shared_interests,
        summary=summary,
    )


def shared_interest_tags(
    target: MatchProfile,
    comparison_profiles: Sequence[MatchProfile],
) -> tuple[str, ...]:
    target_interests = set(target.interests)
    group_interests: set[str] = set()
    for profile in comparison_profiles:
        group_interests.update(profile.interests)
    return tuple(sorted(target_interests & group_interests))


def shared_interest_component(shared_interests: Sequence[str]) -> float:
    return clamp01(len(shared_interests) / 3)


def group_shared_interests(participants: Sequence[MatchProfile]) -> tuple[tuple[str, int], ...]:
    counts: Counter[str] = Counter()
    for participant in participants:
        counts.update(set(participant.interests))

    return tuple(
        (tag, count)
        for tag, count in sorted(
            counts.items(),
            key=lambda item: (-item[1], item[0]),
        )
        if count >= 2
    )


def pillar_affinity_component(
    target_profile_id: str,
    comparison_profile_ids: Sequence[str],
    affinities: Mapping[str, ProfilePillarAffinity],
    group: MatchActivityGroup,
) -> float:
    target_affinity = affinity_with_interest_fallback(
        affinities.get(target_profile_id),
        profile_by_id(group.participants, target_profile_id),
        group,
    )
    if not comparison_profile_ids:
        return target_affinity

    comparison_scores = [
        affinity_with_interest_fallback(
            affinities.get(profile_id),
            profile_by_id(group.participants, profile_id),
            group,
        )
        for profile_id in comparison_profile_ids
    ]
    comparison_affinity = sum(comparison_scores) / len(comparison_scores)
    return clamp01((target_affinity + comparison_affinity) / 2)


def affinity_with_interest_fallback(
    affinity: ProfilePillarAffinity | None,
    profile: MatchProfile | None,
    group: MatchActivityGroup,
) -> float:
    if affinity is not None and affinity.total_count > 0:
        return affinity.score

    if profile is None:
        return 0.0

    interests = set(profile.interests)
    if normalize_tag(group.category) in interests:
        return 1.0
    if any(INTEREST_TO_PILLAR.get(interest) == group.pillar for interest in interests):
        return 0.75
    return 0.0


def profile_by_id(profiles: Sequence[MatchProfile], profile_id: str) -> MatchProfile | None:
    for profile in profiles:
        if profile.id == profile_id:
            return profile
    return None


def match_reason(
    *,
    shared_interests: Sequence[str],
    embedding_similarity: float | None,
    pillar_affinity: float,
    comparison_count: int,
) -> str:
    shared = ",".join(shared_interests[:6]) if shared_interests else "none"
    embedding = "unavailable" if embedding_similarity is None else f"{embedding_similarity:.2f}"
    return (
        f"shared_interests={shared}; "
        f"embedding_similarity={embedding}; "
        f"pillar_affinity={pillar_affinity:.2f}; "
        f"compared_with={comparison_count}"
    )


def vibe_summary(*, people: Sequence[str], shared_interests: Sequence[str]) -> str:
    names = natural_join(people)
    interests = natural_join(shared_interests)
    if names and interests:
        return f"You'll meet {names}; shared interests include {interests}."
    if names:
        return f"You'll meet {names}."
    if interests:
        return f"Shared interests include {interests}."
    return "This group is still taking shape."


def natural_join(values: Sequence[str]) -> str:
    clean = [value for value in values if value]
    if not clean:
        return ""
    if len(clean) == 1:
        return clean[0]
    if len(clean) == 2:
        return f"{clean[0]} and {clean[1]}"
    return f"{', '.join(clean[:-1])}, and {clean[-1]}"


def activity_group_from_rows(
    activity_row: Mapping[str, object],
    explorer_rows: Sequence[Mapping[str, object]],
) -> MatchActivityGroup:
    values = activity_row
    pillar = pillar_from_text(values.get("pillar"))
    if pillar is None:
        raise ValueError("activity row has invalid pillar")

    host = MatchProfile(
        id=str(values["host_id"]),
        display_name=compact_text(values.get("host_display_name")),
        interests=text_array(values.get("host_interests")),
        role="host",
    )
    explorers = tuple(
        MatchProfile(
            id=str(row["id"]),
            display_name=compact_text(row.get("display_name")),
            interests=text_array(row.get("interests")),
            role="attendee",
        )
        for row in explorer_rows
        if str(row.get("id", "")) != host.id
    )
    return MatchActivityGroup(
        activity_id=str(values["id"]),
        title=compact_text(values.get("title")),
        pillar=pillar,
        category=compact_text(values.get("category")),
        host=host,
        explorers=explorers,
    )


def compact_text(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())


def text_array(value: object) -> tuple[str, ...]:
    if isinstance(value, list):
        return tuple(
            tag
            for tag in (normalize_tag(item) for item in value if isinstance(item, str))
            if tag
        )
    if isinstance(value, tuple):
        return tuple(
            tag
            for tag in (normalize_tag(item) for item in value if isinstance(item, str))
            if tag
        )
    return ()


def normalize_tag(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.lower().replace("_", " ").split())


def pillar_from_text(value: object) -> Pillar | None:
    if value == "move" or value == "learn" or value == "feel":
        return value
    return None


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


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))
