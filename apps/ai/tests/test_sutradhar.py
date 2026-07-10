from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping, Sequence
from typing import cast

import httpx
from pytest import MonkeyPatch

from maidan_ai.config import Settings
from maidan_ai.domain_events import JsonObject, JsonValue
from maidan_ai.llm_provider import (
    LLMMessage,
    LLMResponse,
    LLMTextBlock,
    LLMTool,
    LLMToolCall,
    LLMToolUseBlock,
)
from maidan_ai.main import create_app
from maidan_ai.sutradhar import (
    SUTRADHAR_RATE_LIMIT_MESSAGE,
    ActivitySearchResult,
    ActivitySlotSummary,
    NearHint,
    Pillar,
    SutradharChatRequest,
    SutradharMemory,
    SutradharService,
    UserContext,
)


def test_tool_loop_returns_only_seeded_activity_ids_for_indiranagar_weekend_query() -> None:
    async def run() -> None:
        indiranagar_activity = seeded_indiranagar_activity()
        client = FakeSutradharClient(
            [
                tool_use_response(
                    {
                        "query": "calm morning thing this weekend",
                        "near": "Indiranagar",
                    }
                ),
                text_response(
                    "For a calm Bengaluru morning near Indiranagar, start with "
                    "Indiranagar filter coffee brewing. It is a Learn activity with "
                    f"id {indiranagar_activity.id}."
                ),
            ]
        )
        store = FakeSutradharStore([indiranagar_activity])
        service = SutradharService(
            client=client,
            repository=store,
            memory=SutradharMemory(FakeRedis()),
        )

        result = await service.chat(
            SutradharChatRequest(
                message="find me a calm morning thing near Indiranagar this weekend",
                session_id="session-1",
                profile_id="profile-nisha",
            )
        )

        assert store.searches == [
            {
                "query": "calm morning thing this weekend",
                "pillar": None,
                "near": "Indiranagar",
            }
        ]
        assert result.activity_ids == (indiranagar_activity.id,)
        assert indiranagar_activity.id in result.answer
        assert result.demand_signal_id is None

        messages = cast(list[LLMMessage], client.calls[1]["messages"])
        search_tool_result = messages[-1]["content"]
        assert isinstance(search_tool_result, list)
        first_tool_result = cast(Mapping[str, object], search_tool_result[0])
        payload = json.loads(cast(str, first_tool_result["content"]))
        returned_ids = [activity["id"] for activity in payload["activities"]]
        assert returned_ids == [indiranagar_activity.id]

    asyncio.run(run())


def test_no_match_registers_demand_signal_and_does_not_fabricate() -> None:
    async def run() -> None:
        client = FakeSutradharClient(
            [
                tool_use_response(
                    {
                        "query": "moonlight underwater basket weaving",
                        "pillar": "learn",
                        "near": "Indiranagar",
                    }
                ),
                text_response("There are no real matching Maidan activities right now."),
            ]
        )
        store = FakeSutradharStore([])
        service = SutradharService(
            client=client,
            repository=store,
            memory=SutradharMemory(FakeRedis()),
        )

        result = await service.chat(
            SutradharChatRequest(
                message="find moonlight underwater basket weaving near Indiranagar",
                session_id="session-2",
                profile_id="profile-nisha",
            )
        )

        assert result.activity_ids == ()
        assert result.demand_signal_id == "demand-signal-1"
        assert "could not find a real Maidan activity" in result.answer
        assert "Demand signal id: demand-signal-1" in result.answer
        assert "moonlight underwater basket weaving studio" not in result.answer.lower()
        assert store.interests == [
            {
                "query": "moonlight underwater basket weaving",
                "profile_id": "profile-nisha",
                "pillar": "learn",
                "near": "Indiranagar",
            }
        ]

    asyncio.run(run())


def test_sutradhar_endpoint_requires_internal_token_and_streams_sse(
    monkeypatch: MonkeyPatch,
) -> None:
    async def run() -> None:
        monkeypatch.setenv("AI_INTERNAL_TOKEN", "test-internal-token")
        app = create_app()
        client = FakeSutradharClient(
            [
                tool_use_response({"query": "calm morning thing", "near": "Indiranagar"}),
                text_response(f"Try Indiranagar filter coffee brewing, id {SEEDED_ACTIVITY_ID}."),
            ]
        )
        app.state.settings = Settings()
        app.state.sutradhar_service = SutradharService(
            client=client,
            repository=FakeSutradharStore([seeded_indiranagar_activity()]),
            memory=SutradharMemory(FakeRedis()),
        )

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            unauthorized = await http.post(
                "/sutradhar/chat",
                json={
                    "message": "find me a calm morning thing near Indiranagar this weekend",
                    "sessionId": "session-3",
                    "profileId": "profile-nisha",
                },
            )
            response = await http.post(
                "/sutradhar/chat",
                headers={"authorization": "Bearer test-internal-token"},
                json={
                    "message": "find me a calm morning thing near Indiranagar this weekend",
                    "sessionId": "session-3",
                    "profileId": "profile-nisha",
                },
            )

        assert unauthorized.status_code == 401
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        events = parse_sse(response.text)
        assert events[-1] == {
            "type": "final",
            "activity_ids": [SEEDED_ACTIVITY_ID],
            "demand_signal_id": None,
        }
        streamed_text = "".join(
            cast(str, event["text"]) for event in events if event["type"] == "delta"
        )
        assert SEEDED_ACTIVITY_ID in streamed_text

    asyncio.run(run())


def test_sutradhar_rate_limit_streams_structured_response(monkeypatch: MonkeyPatch) -> None:
    async def run() -> None:
        monkeypatch.setenv("AI_INTERNAL_TOKEN", "test-internal-token")
        app = create_app()
        app.state.settings = Settings()
        app.state.sutradhar_service = SutradharService(
            client=RateLimitedSutradharClient(),
            repository=FakeSutradharStore([seeded_indiranagar_activity()]),
            memory=SutradharMemory(FakeRedis()),
        )

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            response = await http.post(
                "/sutradhar/chat",
                headers={"authorization": "Bearer test-internal-token"},
                json={
                    "message": "find me a calm morning thing near Indiranagar this weekend",
                    "sessionId": "session-rate-limit",
                    "profileId": "profile-nisha",
                },
            )

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        events = parse_sse(response.text)
        assert events == [
            {"type": "delta", "text": SUTRADHAR_RATE_LIMIT_MESSAGE},
            {
                "type": "final",
                "activity_ids": [],
                "demand_signal_id": None,
                "error": "rate_limited",
            },
        ]

    asyncio.run(run())


SEEDED_ACTIVITY_ID = "11111111-1111-4111-8111-111111111111"


def seeded_indiranagar_activity() -> ActivitySearchResult:
    return ActivitySearchResult(
        id=SEEDED_ACTIVITY_ID,
        title="Indiranagar filter coffee brewing",
        description="Hands-on South Indian filter coffee brewing with decoction basics.",
        pillar="learn",
        category="coffee",
        meeting_point="12th Main tasting room, Indiranagar",
        base_price_inr=900,
        currency="INR",
        capacity=10,
        fairness_score=88,
        host_name="Meera Krishnan",
        distance_m=120,
        next_open_slot=ActivitySlotSummary(
            id="22222222-2222-4222-8222-222222222222",
            starts_at="2030-01-05T05:00:00Z",
            ends_at="2030-01-05T07:00:00Z",
            capacity=10,
            booked_count=1,
            status="open",
        ),
        score=0.91,
    )


def tool_use_response(input_json: Mapping[str, JsonValue]) -> LLMResponse:
    tool_input = dict(input_json)
    block: LLMToolUseBlock = {
        "type": "tool_use",
        "id": "toolu_search_1",
        "name": "search_activities",
        "input": tool_input,
    }
    return LLMResponse(
        content=(block,),
        stop_reason="tool_use",
        text="",
        tool_calls=(
            LLMToolCall(
                id=block["id"],
                name=block["name"],
                input=tool_input,
            ),
        ),
        raw={},
    )


def text_response(text: str) -> LLMResponse:
    block: LLMTextBlock = {"type": "text", "text": text}
    return LLMResponse(
        content=(block,),
        stop_reason="end_turn",
        text=text,
        tool_calls=(),
        raw={},
    )


class FakeSutradharClient:
    def __init__(self, responses: list[LLMResponse]) -> None:
        self.responses = responses
        self.calls: list[dict[str, object]] = []

    async def chat_call(
        self,
        messages: Sequence[LLMMessage],
        *,
        system: str | None = None,
        max_tokens: int = 1024,
        tools: Sequence[LLMTool],
    ) -> LLMResponse:
        self.calls.append(
            {
                "messages": list(messages),
                "system": system,
                "max_tokens": max_tokens,
                "tools": list(tools),
            }
        )
        return self.responses.pop(0)


class RateLimitedSutradharClient:
    async def chat_call(
        self,
        messages: Sequence[LLMMessage],
        *,
        system: str | None = None,
        max_tokens: int = 1024,
        tools: Sequence[LLMTool],
    ) -> LLMResponse:
        del messages, system, max_tokens, tools
        raise RuntimeError("OpenRouter rate limit persisted after retries (429)")


class FakeSutradharStore:
    def __init__(self, activities: Sequence[ActivitySearchResult]) -> None:
        self.activities = list(activities)
        self.searches: list[dict[str, object]] = []
        self.interests: list[dict[str, object]] = []

    async def search_activities(
        self,
        *,
        query: str,
        pillar: Pillar | None,
        near: NearHint | None,
        limit: int = 6,
    ) -> list[ActivitySearchResult]:
        del limit
        self.searches.append(
            {
                "query": query,
                "pillar": pillar,
                "near": None if near is None else near.label,
            }
        )
        return self.activities

    async def get_activity(self, activity_id: str) -> JsonObject | None:
        for activity in self.activities:
            if activity.id == activity_id:
                return activity.to_json()
        return None

    async def get_user_context(self, profile_id: str) -> UserContext:
        return UserContext(
            profile_id=profile_id,
            display_name="Nisha Pai",
            interests=("cycling", "coffee", "journaling"),
            recent_bookings=(),
        )

    async def register_interest(
        self,
        *,
        query: str,
        profile_id: str,
        pillar: Pillar,
        near: NearHint | None,
    ) -> str:
        self.interests.append(
            {
                "query": query,
                "profile_id": profile_id,
                "pillar": pillar,
                "near": None if near is None else near.label,
            }
        )
        return "demand-signal-1"


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    async def get(self, name: str) -> str | None:
        return self.values.get(name)

    async def set(self, name: str, value: str, *, ex: int | None = None) -> object:
        del ex
        self.values[name] = value
        return True


def parse_sse(raw: str) -> list[JsonObject]:
    events: list[JsonObject] = []
    for block in raw.strip().split("\n\n"):
        if not block.startswith("data: "):
            continue
        parsed = json.loads(block.removeprefix("data: "))
        if isinstance(parsed, dict):
            events.append(cast(JsonObject, parsed))
    return events
