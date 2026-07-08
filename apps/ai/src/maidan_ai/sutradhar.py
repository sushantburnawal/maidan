from __future__ import annotations

import json
import math
import re
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Literal, Protocol, cast

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from maidan_ai.db import DbPool
from maidan_ai.domain_events import JsonObject
from maidan_ai.embeddings import Embedder, pgvector_literal
from maidan_ai.llm_provider import LLMContentBlock, LLMMessage, LLMResponse, LLMTool, LLMToolCall

Pillar = Literal["move", "learn", "feel"]

SUTRADHAR_SYSTEM_PROMPT = "\n".join(
    [
        "You are Sutradhar, Maidan's warm, grounded guide for discovering local activities in "
        "Bengaluru.",
        "Speak naturally and use Maidan's three-pillar vocabulary: Move, Learn, Feel.",
        "Never invent activities, hosts, slots, prices, locations, or availability.",
        "Before recommending activities, call search_activities. Recommend only activities "
        "returned by tools in this conversation.",
        "Use get_activity when the explorer asks for details, slots, fairness, price, or booking "
        "readiness.",
        "Use get_user_context when personalisation would help, and treat the supplied persistent "
        "context as private.",
        "If search_activities returns no matches, say that clearly and offer to register interest; "
        "do not name any made-up activity.",
        "When you recommend an activity, include its activity id exactly as returned by the tool.",
    ]
)

MAX_TOOL_ITERATIONS = 4
MEMORY_TTL_SECONDS = 60 * 60 * 24
MAX_MEMORY_MESSAGES = 8
SUTRADHAR_RATE_LIMIT_MESSAGE = "No Money No honey babes, out of tokens coz they are $$$"

SUTRADHAR_TOOLS: tuple[LLMTool, ...] = (
    {
        "name": "search_activities",
        "description": (
            "Hybrid vector, text, and PostGIS search over published Maidan activities. Use this "
            "before making any recommendation."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The explorer's activity need in their own words.",
                },
                "pillar": {
                    "type": "string",
                    "enum": ["move", "learn", "feel"],
                    "description": "Optional Maidan pillar filter.",
                },
                "near": {
                    "description": (
                        "Optional place hint such as Indiranagar, or an object with label, lat, "
                        "lng, and radius_km."
                    ),
                    "oneOf": [
                        {"type": "string"},
                        {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string"},
                                "lat": {"type": "number"},
                                "lng": {"type": "number"},
                                "radius_km": {"type": "number"},
                            },
                            "additionalProperties": False,
                        },
                    ],
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_activity",
        "description": "Get a published activity's details, next open slots, and fairness score.",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "string", "description": "Activity UUID."}},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_user_context",
        "description": (
            "Get the current explorer's interests and recent bookings for personalisation."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "profile_id": {"type": "string", "description": "Current explorer profile UUID."}
            },
            "required": ["profile_id"],
            "additionalProperties": False,
        },
    },
)


class SutradharChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message: str = Field(min_length=1, max_length=2000)
    session_id: str = Field(
        min_length=1,
        max_length=160,
        validation_alias=AliasChoices("session_id", "sessionId"),
    )
    profile_id: str = Field(
        min_length=1,
        max_length=160,
        validation_alias=AliasChoices("profile_id", "profileId"),
    )


class SutradharRedis(Protocol):
    async def get(self, name: str) -> str | None:
        pass

    async def set(self, name: str, value: str, *, ex: int | None = None) -> object:
        pass


class SutradharChatClient(Protocol):
    async def chat_call(
        self,
        messages: Sequence[LLMMessage],
        *,
        system: str | None = None,
        max_tokens: int = 1024,
        tools: Sequence[LLMTool],
    ) -> LLMResponse:
        pass


class SutradharStore(Protocol):
    async def search_activities(
        self,
        *,
        query: str,
        pillar: Pillar | None,
        near: NearHint | None,
        limit: int = 6,
    ) -> list[ActivitySearchResult]:
        pass

    async def get_activity(self, activity_id: str) -> JsonObject | None:
        pass

    async def get_user_context(self, profile_id: str) -> UserContext:
        pass

    async def register_interest(
        self,
        *,
        query: str,
        profile_id: str,
        pillar: Pillar,
        near: NearHint | None,
    ) -> str:
        pass


@dataclass(frozen=True)
class NearHint:
    label: str
    lat: float | None
    lng: float | None
    radius_km: float

    def to_json(self) -> JsonObject:
        result: JsonObject = {"label": self.label, "radius_km": self.radius_km}
        if self.lat is not None and self.lng is not None:
            result["lat"] = self.lat
            result["lng"] = self.lng
        return result


@dataclass(frozen=True)
class ActivitySlotSummary:
    id: str
    starts_at: str
    ends_at: str
    capacity: int
    booked_count: int
    status: str

    def to_json(self) -> JsonObject:
        return {
            "id": self.id,
            "starts_at": self.starts_at,
            "ends_at": self.ends_at,
            "capacity": self.capacity,
            "booked_count": self.booked_count,
            "open_seats": max(self.capacity - self.booked_count, 0),
            "status": self.status,
        }


@dataclass(frozen=True)
class ActivitySearchResult:
    id: str
    title: str
    description: str
    pillar: Pillar
    category: str
    meeting_point: str
    base_price_inr: int
    currency: str
    capacity: int
    fairness_score: float
    host_name: str
    distance_m: int | None
    next_open_slot: ActivitySlotSummary | None
    score: float

    def to_json(self) -> JsonObject:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "pillar": self.pillar,
            "category": self.category,
            "meeting_point": self.meeting_point,
            "base_price_inr": self.base_price_inr,
            "currency": self.currency,
            "capacity": self.capacity,
            "fairness_score": round(self.fairness_score, 2),
            "host_name": self.host_name,
            "distance_m": self.distance_m,
            "next_open_slot": None
            if self.next_open_slot is None
            else self.next_open_slot.to_json(),
            "score": round(self.score, 4),
        }


@dataclass(frozen=True)
class UserContext:
    profile_id: str
    display_name: str | None
    interests: tuple[str, ...]
    recent_bookings: tuple[JsonObject, ...]

    def to_json(self) -> JsonObject:
        return {
            "profile_id": self.profile_id,
            "display_name": self.display_name,
            "interests": list(self.interests),
            "recent_bookings": list(self.recent_bookings),
        }

    def summary(self) -> str:
        name = self.display_name or "Explorer"
        interests = ", ".join(self.interests) if self.interests else "not set"
        if not self.recent_bookings:
            bookings = "none yet"
        else:
            bookings = "; ".join(
                compact_text(
                    (
                        f"{booking.get('activity_title', 'activity')} "
                        f"({booking.get('status', 'seen')})"
                    ),
                    limit=120,
                )
                for booking in self.recent_bookings[:3]
            )
        return f"Profile: {name}. Interests: {interests}. Recent bookings: {bookings}."


@dataclass(frozen=True)
class ToolExecution:
    payload: JsonObject
    activity_ids: tuple[str, ...] = ()
    activities: tuple[ActivitySearchResult, ...] = ()
    empty_search: bool = False
    demand_signal_id: str | None = None


@dataclass(frozen=True)
class SutradharChatResult:
    answer: str
    activity_ids: tuple[str, ...]
    demand_signal_id: str | None


class SutradharRepository:
    def __init__(
        self,
        pool: DbPool,
        *,
        embedder: Embedder | None = None,
        embedding_dimensions: int = 768,
    ) -> None:
        self._pool = pool
        self._embedder = embedder
        self._embedding_dimensions = embedding_dimensions

    async def search_activities(
        self,
        *,
        query: str,
        pillar: Pillar | None,
        near: NearHint | None,
        limit: int = 6,
    ) -> list[ActivitySearchResult]:
        query_embedding: str | None = None
        if self._embedder is not None:
            embeddings = await self._embedder.embed([query])
            if embeddings:
                query_embedding = pgvector_literal(embeddings[0], self._embedding_dimensions)

        lat = None if near is None else near.lat
        lng = None if near is None else near.lng
        radius_m = None if near is None else near.radius_km * 1000

        async with self._pool.acquire() as connection:
            rows = await connection.fetch(
                _SEARCH_ACTIVITIES_SQL,
                query,
                pillar,
                query_embedding is not None,
                query_embedding,
                lat,
                lng,
                radius_m,
                limit,
            )

        return [activity_search_result_from_row(row) for row in rows]

    async def get_activity(self, activity_id: str) -> JsonObject | None:
        async with self._pool.acquire() as connection:
            activity = await connection.fetchrow(
                """
                select
                  a.id::text,
                  a.title,
                  a.description,
                  a.pillar::text,
                  a.category,
                  a.meeting_point,
                  a.base_price_inr::int,
                  a.currency,
                  a.capacity::int,
                  a.fairness_score,
                  host.display_name as host_name
                from activities a
                join profiles host on host.id = a.host_id
                where a.id = $1::uuid
                  and a.status = 'published'::activity_status
                """,
                activity_id,
            )
            if activity is None:
                return None

            slot_rows = await connection.fetch(
                """
                select
                  id::text,
                  starts_at,
                  ends_at,
                  capacity::int,
                  booked_count::int,
                  status::text
                from activity_slots
                where activity_id = $1::uuid
                  and status = 'open'::slot_status
                  and starts_at >= now()
                order by starts_at, id
                limit 5
                """,
                activity_id,
            )

        activity_json = activity_json_from_row(activity)
        activity_json["next_slots"] = [slot_summary_from_row(row).to_json() for row in slot_rows]
        activity_json["fairness"] = {
            "score": activity_json["fairness_score"],
            "note": fairness_note(float_from_row(activity, "fairness_score")),
        }
        return activity_json

    async def get_user_context(self, profile_id: str) -> UserContext:
        async with self._pool.acquire() as connection:
            profile = await connection.fetchrow(
                """
                select id::text, display_name, interests
                from profiles
                where id = $1::uuid
                """,
                profile_id,
            )
            booking_rows = await connection.fetch(
                """
                select
                  b.id::text as booking_id,
                  b.status::text,
                  b.headcount::int,
                  b.created_at,
                  a.id::text as activity_id,
                  a.title as activity_title,
                  a.pillar::text,
                  a.category,
                  s.starts_at
                from bookings b
                join activity_slots s on s.id = b.slot_id
                join activities a on a.id = s.activity_id
                where b.explorer_id = $1::uuid
                order by b.created_at desc, b.id
                limit 5
                """,
                profile_id,
            )

        if profile is None:
            return UserContext(
                profile_id=profile_id,
                display_name=None,
                interests=(),
                recent_bookings=(),
            )

        return UserContext(
            profile_id=profile_id,
            display_name=optional_str(profile.get("display_name")),
            interests=text_array(profile.get("interests")),
            recent_bookings=tuple(booking_json_from_row(row) for row in booking_rows),
        )

    async def register_interest(
        self,
        *,
        query: str,
        profile_id: str,
        pillar: Pillar,
        near: NearHint | None,
    ) -> str:
        now = datetime.now(UTC)
        area = "Bengaluru" if near is None else near.label
        evidence: JsonObject = {
            "created_by": "sutradhar",
            "reason": "no_matching_activity_results",
            "query": query,
            "profile_id": profile_id,
            "near": None if near is None else near.to_json(),
            "requested_at": isoformat(now),
        }

        async with self._pool.acquire() as connection:
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
                area,
                pillar,
                "0.5500",
                now,
                now + timedelta(days=14),
                json.dumps(evidence, ensure_ascii=True, separators=(",", ":")),
            )

        if inserted is None:
            raise RuntimeError("demand_signals insert did not return an id")
        return str(inserted["id"])


class SutradharMemory:
    def __init__(
        self,
        redis_client: SutradharRedis,
        *,
        ttl_seconds: int = MEMORY_TTL_SECONDS,
        max_messages: int = MAX_MEMORY_MESSAGES,
    ) -> None:
        self._redis = redis_client
        self._ttl_seconds = ttl_seconds
        self._max_messages = max_messages

    async def load(self, *, profile_id: str, session_id: str) -> list[LLMMessage]:
        raw = await self._redis.get(memory_key(profile_id, session_id))
        if raw is None:
            return []

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return []

        if not isinstance(parsed, list):
            return []

        messages: list[LLMMessage] = []
        for item in parsed[-self._max_messages :]:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            content = item.get("content")
            if (role == "user" or role == "assistant") and isinstance(content, str):
                messages.append({"role": role, "content": content})

        return messages

    async def save(
        self,
        *,
        profile_id: str,
        session_id: str,
        messages: Sequence[LLMMessage],
    ) -> None:
        serializable: list[JsonObject] = []
        for message in messages:
            content = message["content"]
            if isinstance(content, str):
                serializable.append({"role": message["role"], "content": content})

        bounded = serializable[-self._max_messages :]
        await self._redis.set(
            memory_key(profile_id, session_id),
            json.dumps(bounded, ensure_ascii=True, separators=(",", ":")),
            ex=self._ttl_seconds,
        )


class SutradharService:
    def __init__(
        self,
        *,
        client: SutradharChatClient,
        repository: SutradharStore,
        memory: SutradharMemory,
        max_tool_iterations: int = MAX_TOOL_ITERATIONS,
    ) -> None:
        self._client = client
        self._repository = repository
        self._memory = memory
        self._max_tool_iterations = max_tool_iterations

    async def chat(self, request: SutradharChatRequest) -> SutradharChatResult:
        user_context = await self._repository.get_user_context(request.profile_id)
        memory_messages = await self._memory.load(
            profile_id=request.profile_id,
            session_id=request.session_id,
        )
        messages: list[LLMMessage] = [
            *memory_messages,
            {"role": "user", "content": request.message.strip()},
        ]
        system = system_prompt_with_context(user_context)
        search_results_by_id: dict[str, ActivitySearchResult] = {}
        grounded_activity_ids: list[str] = []
        empty_search = False
        demand_signal_id: str | None = None
        final_answer = ""

        for _ in range(self._max_tool_iterations):
            response = await self._client.chat_call(
                messages,
                system=system,
                max_tokens=1200,
                tools=SUTRADHAR_TOOLS,
            )
            messages.append({"role": "assistant", "content": list(response.content)})

            if response.tool_calls:
                tool_results: list[LLMContentBlock] = []
                for tool_call in response.tool_calls:
                    execution = await self._execute_tool(
                        tool_call,
                        profile_id=request.profile_id,
                        original_query=request.message,
                    )
                    for activity_id in execution.activity_ids:
                        if activity_id not in grounded_activity_ids:
                            grounded_activity_ids.append(activity_id)
                    for activity in execution.activities:
                        search_results_by_id[activity.id] = activity
                    empty_search = empty_search or execution.empty_search
                    demand_signal_id = demand_signal_id or execution.demand_signal_id
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": tool_call.id,
                            "content": json.dumps(
                                execution.payload,
                                ensure_ascii=True,
                                separators=(",", ":"),
                            ),
                        }
                    )

                messages.append({"role": "user", "content": tool_results})
                continue

            final_answer = response.text.strip()
            break

        grounded_ids = tuple(grounded_activity_ids)
        if empty_search and not grounded_ids:
            if demand_signal_id is None:
                demand_signal_id = await self._repository.register_interest(
                    query=request.message,
                    profile_id=request.profile_id,
                    pillar=infer_pillar(request.message, None),
                    near=infer_near_from_text(request.message),
                )
            final_answer = no_match_answer(request.message, demand_signal_id)
            activity_ids: tuple[str, ...] = ()
        else:
            if not final_answer:
                final_answer = grounded_fallback_answer(list(search_results_by_id.values()))
            activity_ids = selected_activity_ids(final_answer, grounded_ids)
            if not activity_ids:
                activity_ids = grounded_ids[:3]
            final_answer = ensure_activity_ids_in_answer(final_answer, activity_ids)

        memory_to_save: list[LLMMessage] = [
            *memory_messages,
            {"role": "user", "content": request.message.strip()},
            {"role": "assistant", "content": final_answer},
        ]
        await self._memory.save(
            profile_id=request.profile_id,
            session_id=request.session_id,
            messages=memory_to_save,
        )
        return SutradharChatResult(
            answer=final_answer,
            activity_ids=activity_ids,
            demand_signal_id=demand_signal_id,
        )

    async def stream_chat(self, request: SutradharChatRequest) -> AsyncIterator[str]:
        try:
            result = await self.chat(request)
        except Exception as error:
            if not is_rate_limit_error(error):
                raise
            yield sse_event({"type": "delta", "text": SUTRADHAR_RATE_LIMIT_MESSAGE})
            yield sse_event(
                {
                    "type": "final",
                    "activity_ids": [],
                    "demand_signal_id": None,
                    "error": "rate_limited",
                }
            )
            return

        for chunk in text_chunks(result.answer):
            yield sse_event({"type": "delta", "text": chunk})
        yield sse_event(
            {
                "type": "final",
                "activity_ids": list(result.activity_ids),
                "demand_signal_id": result.demand_signal_id,
            }
        )

    async def _execute_tool(
        self,
        tool_call: LLMToolCall,
        *,
        profile_id: str,
        original_query: str,
    ) -> ToolExecution:
        if tool_call.name == "search_activities":
            query = required_tool_text(tool_call.input, "query", fallback=original_query)
            pillar = tool_pillar(tool_call.input.get("pillar"))
            near = parse_near(tool_call.input.get("near")) or infer_near_from_text(
                f"{query} {original_query}"
            )
            results = await self._repository.search_activities(
                query=query,
                pillar=pillar,
                near=near,
            )
            activity_ids = tuple(activity.id for activity in results)
            demand_signal_id: str | None = None
            if not results:
                demand_signal_id = await self._repository.register_interest(
                    query=query,
                    profile_id=profile_id,
                    pillar=infer_pillar(query, pillar),
                    near=near,
                )
            return ToolExecution(
                payload={
                    "activities": [activity.to_json() for activity in results],
                    "query": query,
                    "pillar": pillar,
                    "near": None if near is None else near.to_json(),
                    "demand_signal_id": demand_signal_id,
                },
                activity_ids=activity_ids,
                activities=tuple(results),
                empty_search=not results,
                demand_signal_id=demand_signal_id,
            )

        if tool_call.name == "get_activity":
            activity_id = required_tool_text(tool_call.input, "id", fallback="")
            activity = await self._repository.get_activity(activity_id) if activity_id else None
            return ToolExecution(
                payload={
                    "activity": activity,
                    "found": activity is not None,
                },
                activity_ids=() if activity is None else (activity_id,),
            )

        if tool_call.name == "get_user_context":
            requested_profile_id = required_tool_text(
                tool_call.input,
                "profile_id",
                fallback=profile_id,
            )
            if requested_profile_id != profile_id:
                return ToolExecution(
                    payload={
                        "error": "profile_id_mismatch",
                        "message": "get_user_context may only read the current explorer.",
                    }
                )
            context = await self._repository.get_user_context(profile_id)
            return ToolExecution(payload=context.to_json())

        return ToolExecution(
            payload={
                "error": "unknown_tool",
                "message": f"Sutradhar does not expose a tool named {tool_call.name}.",
            }
        )


def system_prompt_with_context(context: UserContext) -> str:
    return "\n\n".join(
        [
            SUTRADHAR_SYSTEM_PROMPT,
            "Persistent context summary for this explorer:",
            context.summary(),
        ]
    )


def memory_key(profile_id: str, session_id: str) -> str:
    return f"sutradhar:memory:{profile_id}:{session_id}"


def parse_near(value: object) -> NearHint | None:
    if isinstance(value, str):
        return near_from_label(value)
    if not isinstance(value, dict):
        return None

    label = optional_str(value.get("label")) or "Bengaluru"
    lat = finite_float(value.get("lat"))
    lng = finite_float(value.get("lng"))
    radius_km = finite_float(value.get("radius_km")) or 7.0
    if lat is None or lng is None:
        known = near_from_label(label)
        if known is not None:
            return NearHint(label=known.label, lat=known.lat, lng=known.lng, radius_km=radius_km)
    return NearHint(label=compact_text(label, limit=80), lat=lat, lng=lng, radius_km=radius_km)


def near_from_label(label: str) -> NearHint | None:
    normalized = normalize_text(label)
    if not normalized:
        return None
    for area, coordinates in KNOWN_AREAS.items():
        if normalize_text(area) in normalized or normalized in normalize_text(area):
            return NearHint(
                label=area,
                lat=coordinates[0],
                lng=coordinates[1],
                radius_km=7.0,
            )
    return NearHint(label=compact_text(label, limit=80), lat=None, lng=None, radius_km=7.0)


def infer_near_from_text(text: str) -> NearHint | None:
    normalized = normalize_text(text)
    for area in KNOWN_AREAS:
        if normalize_text(area) in normalized:
            return near_from_label(area)
    return None


def infer_pillar(query: str, explicit: Pillar | None) -> Pillar:
    if explicit is not None:
        return explicit
    normalized = normalize_text(query)
    if any(word in normalized for word in ("run", "ride", "cycle", "yoga", "strength", "move")):
        return "move"
    if any(word in normalized for word in ("learn", "coffee", "pottery", "language", "photo")):
        return "learn"
    return "feel"


def tool_pillar(value: object) -> Pillar | None:
    if value == "move" or value == "learn" or value == "feel":
        return value
    return None


def required_tool_text(raw: Mapping[str, object], key: str, *, fallback: str) -> str:
    value = raw.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return fallback.strip()


def selected_activity_ids(answer: str, grounded_ids: Sequence[str]) -> tuple[str, ...]:
    selected: list[str] = []
    for activity_id in grounded_ids:
        if activity_id in answer and activity_id not in selected:
            selected.append(activity_id)
    return tuple(selected)


def ensure_activity_ids_in_answer(answer: str, activity_ids: Sequence[str]) -> str:
    if not activity_ids:
        return answer
    missing = [activity_id for activity_id in activity_ids if activity_id not in answer]
    if not missing:
        return answer
    suffix = "Activity IDs: " + ", ".join(activity_ids) + "."
    return f"{answer.rstrip()}\n\n{suffix}" if answer.strip() else suffix


def no_match_answer(query: str, demand_signal_id: str) -> str:
    return (
        "I could not find a real Maidan activity matching that request right now, so I will not "
        "make one up. I have registered this as interest for hosts to see. "
        f"Demand signal id: {demand_signal_id}. Query: {compact_text(query, limit=140)}."
    )


def grounded_fallback_answer(results: Sequence[ActivitySearchResult]) -> str:
    if not results:
        return "I could not find a matching Maidan activity right now."
    lines = [
        "Here are grounded Maidan options from the current activity list:",
    ]
    for activity in list(results)[:3]:
        lines.append(
            f"- {activity.title} ({activity.pillar.title()}) - id {activity.id}; "
            f"{activity.meeting_point}; INR {activity.base_price_inr}."
        )
    return "\n".join(lines)


def text_chunks(text: str, *, max_length: int = 180) -> list[str]:
    if len(text) <= max_length:
        return [text]
    chunks: list[str] = []
    current = ""
    for word in text.split(" "):
        next_value = word if not current else f"{current} {word}"
        if len(next_value) > max_length and current:
            chunks.append(current)
            current = word
        else:
            current = next_value
    if current:
        chunks.append(current)
    return chunks


def sse_event(payload: JsonObject) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=True, separators=(',', ':'))}\n\n"


def is_rate_limit_error(error: Exception) -> bool:
    message = str(error).lower()
    return "rate limit" in message or "429" in message


def activity_search_result_from_row(row: object) -> ActivitySearchResult:
    values = cast(Mapping[str, object], row)
    return ActivitySearchResult(
        id=str(values["id"]),
        title=str(values["title"]),
        description=str(values["description"]),
        pillar=cast(Pillar, str(values["pillar"])),
        category=str(values["category"]),
        meeting_point=str(values["meeting_point"]),
        base_price_inr=int_from_row(values, "base_price_inr"),
        currency=str(values["currency"]),
        capacity=int_from_row(values, "capacity"),
        fairness_score=float_from_row(values, "fairness_score"),
        host_name=str(values["host_name"]),
        distance_m=optional_int(values.get("distance_m")),
        next_open_slot=slot_summary_from_prefixed_row(values),
        score=float_from_row(values, "score"),
    )


def activity_json_from_row(row: object) -> JsonObject:
    values = cast(Mapping[str, object], row)
    return {
        "id": str(values["id"]),
        "title": str(values["title"]),
        "description": str(values["description"]),
        "pillar": str(values["pillar"]),
        "category": str(values["category"]),
        "meeting_point": str(values["meeting_point"]),
        "base_price_inr": int_from_row(values, "base_price_inr"),
        "currency": str(values["currency"]),
        "capacity": int_from_row(values, "capacity"),
        "fairness_score": round(float_from_row(values, "fairness_score"), 2),
        "host_name": str(values["host_name"]),
    }


def booking_json_from_row(row: object) -> JsonObject:
    values = cast(Mapping[str, object], row)
    return {
        "booking_id": str(values["booking_id"]),
        "status": str(values["status"]),
        "headcount": int_from_row(values, "headcount"),
        "created_at": isoformat(values.get("created_at")),
        "activity_id": str(values["activity_id"]),
        "activity_title": str(values["activity_title"]),
        "pillar": str(values["pillar"]),
        "category": str(values["category"]),
        "starts_at": isoformat(values.get("starts_at")),
    }


def slot_summary_from_row(row: object) -> ActivitySlotSummary:
    values = cast(Mapping[str, object], row)
    return ActivitySlotSummary(
        id=str(values["id"]),
        starts_at=isoformat(values.get("starts_at")),
        ends_at=isoformat(values.get("ends_at")),
        capacity=int_from_row(values, "capacity"),
        booked_count=int_from_row(values, "booked_count"),
        status=str(values["status"]),
    )


def slot_summary_from_prefixed_row(values: Mapping[str, object]) -> ActivitySlotSummary | None:
    slot_id = optional_str(values.get("slot_id"))
    if slot_id is None:
        return None
    return ActivitySlotSummary(
        id=slot_id,
        starts_at=isoformat(values.get("slot_starts_at")),
        ends_at=isoformat(values.get("slot_ends_at")),
        capacity=int_from_row(values, "slot_capacity"),
        booked_count=int_from_row(values, "slot_booked_count"),
        status=str(values.get("slot_status", "open")),
    )


def fairness_note(score: float) -> str:
    if score >= 85:
        return "Strong fairness score for comparable Maidan supply."
    if score >= 70:
        return "Fairness is acceptable, but compare price and fit before booking."
    return "Fairness is lower than nearby comparable supply."


def int_from_row(values: Mapping[str, object], key: str) -> int:
    return json_int(values.get(key), fallback=0)


def float_from_row(values: Mapping[str, object], key: str) -> float:
    return json_float(values.get(key), fallback=0.0)


def json_int(value: object, *, fallback: int) -> int:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, Decimal):
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
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return fallback
    return fallback


def optional_int(value: object) -> int | None:
    if value is None:
        return None
    number = json_int(value, fallback=-1)
    return None if number < 0 else number


def finite_float(value: object) -> float | None:
    number = json_float(value, fallback=math.nan)
    return number if math.isfinite(number) else None


def optional_str(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def text_array(value: object) -> tuple[str, ...]:
    if isinstance(value, list | tuple):
        return tuple(item.strip() for item in value if isinstance(item, str) and item.strip())
    return ()


def isoformat(value: object) -> str:
    if isinstance(value, datetime):
        normalized = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
        return normalized.astimezone(UTC).isoformat().replace("+00:00", "Z")
    if isinstance(value, str):
        return value
    return ""


def compact_text(value: object, *, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    compacted = " ".join(value.split())
    return compacted[:limit]


def normalize_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


KNOWN_AREAS: dict[str, tuple[float, float]] = {
    "Indiranagar": (12.9719, 77.6411),
    "Cubbon Park": (12.9763, 77.5929),
    "Koramangala": (12.9352, 77.6245),
    "JP Nagar": (12.9063, 77.5857),
    "Nandi Hills": (13.3702, 77.6835),
}


_SEARCH_ACTIVITIES_SQL = """
with origin as (
  select
    case
      when $5::float8 is null or $6::float8 is null then null
      else st_setsrid(st_makepoint($6::float8, $5::float8), 4326)::geography
    end as point
),
ranked as (
  select
    a.id::text,
    a.title,
    a.description,
    a.pillar::text,
    a.category,
    a.meeting_point,
    a.base_price_inr::int,
    a.currency,
    a.capacity::int,
    a.fairness_score,
    host.display_name as host_name,
    case
      when origin.point is null then null
      else round(st_distance(a.location, origin.point))::int
    end as distance_m,
    case
      when not $3::boolean or a.embedding is null then 0::double precision
      else greatest(0::double precision, 1 - (a.embedding <=> $4::vector(768)))
    end as semantic_score,
    ts_rank_cd(
      to_tsvector(
        'english',
        concat_ws(' ', a.title, a.description, a.category, a.meeting_point)
      ),
      plainto_tsquery('english', $1)
    )::double precision as text_score,
    case
      when concat_ws(' ', a.title, a.description, a.category, a.meeting_point)
        ilike ('%' || $1 || '%')
      then 1::double precision
      else 0::double precision
    end as phrase_score
  from activities a
  join profiles host on host.id = a.host_id
  cross join origin
  where a.status = 'published'::activity_status
    and ($2::text is null or a.pillar = $2::activity_pillar)
    and (
      origin.point is null
      or $7::float8 is null
      or st_dwithin(a.location, origin.point, $7::float8)
    )
),
scored as (
  select
    ranked.*,
    (
      ranked.semantic_score * 0.50
      + least(ranked.text_score, 1) * 0.25
      + ranked.phrase_score * 0.10
      + case
          when ranked.distance_m is null then 0.08
          else greatest(0::double precision, 1 - (ranked.distance_m::double precision / 10000))
        end * 0.15
    ) as score
  from ranked
)
select
  scored.*,
  slot.id::text as slot_id,
  slot.starts_at as slot_starts_at,
  slot.ends_at as slot_ends_at,
  slot.capacity::int as slot_capacity,
  slot.booked_count::int as slot_booked_count,
  slot.status::text as slot_status
from scored
left join lateral (
  select s.*
  from activity_slots s
  where s.activity_id = scored.id::uuid
    and s.status = 'open'::slot_status
    and s.starts_at >= now()
  order by s.starts_at, s.id
  limit 1
) slot on true
order by scored.score desc, slot.starts_at nulls last, scored.title
limit $8::int
"""
