from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence

from maidan_ai.domain_events import DomainEvent
from maidan_ai.handlers import build_default_handlers
from maidan_ai.matchmaking import (
    MatchActivityGroup,
    MatchmakingRunner,
    MatchmakingService,
    MatchProfile,
    MatchScore,
    Pillar,
    ProfilePillarAffinity,
)


def test_booking_confirmed_handler_writes_explainable_match_scores() -> None:
    async def run() -> None:
        store = FakeMatchmakingStore(seeded_nandi_group())
        service = MatchmakingService(store)
        handler = build_default_handlers(matchmaking_service=service)["booking.confirmed"]
        event: DomainEvent = {
            "id": 21,
            "aggregate_type": "booking",
            "aggregate_id": "33333333-3333-4333-8333-333333333333",
            "event_type": "booking.confirmed",
            "payload": {
                "booking_id": "33333333-3333-4333-8333-333333333333",
                "slot_id": "44444444-4444-4444-8444-444444444444",
                "activity_id": "11111111-1111-4111-8111-111111111111",
                "explorer_id": "55555555-5555-4555-8555-555555555555",
                "host_id": "22222222-2222-4222-8222-222222222222",
                "payment_id": "66666666-6666-4666-8666-666666666666",
                "headcount": 1,
                "amount_inr": 1499,
                "confirmed_at": "2026-06-18T00:00:00.000Z",
            },
            "created_at": "2026-06-18T00:00:00.000Z",
        }

        result = await handler.handle(event)

        assert result["handler"] == "matchmaking"
        assert result["score_count"] == 2
        assert {score.profile_id for score in store.scores} == {
            "55555555-5555-4555-8555-555555555555",
            "77777777-7777-4777-8777-777777777777",
        }
        assert all(score.score > 0.5 for score in store.scores)
        assert all("shared_interests=" in score.reason for score in store.scores)
        assert all("embedding_similarity=" in score.reason for score in store.scores)
        assert all("pillar_affinity=" in score.reason for score in store.scores)

    asyncio.run(run())


def test_nightly_runner_recomputes_seeded_co_booking_scores() -> None:
    async def run() -> None:
        store = FakeMatchmakingStore(seeded_nandi_group())
        service = MatchmakingService(store)
        runner = MatchmakingRunner(store, service, batch_size=10)

        result = await runner.run_once()

        assert result.activity_count == 1
        assert result.score_count == 2
        assert [score.activity_id for score in store.scores] == [
            "11111111-1111-4111-8111-111111111111",
            "11111111-1111-4111-8111-111111111111",
        ]
        assert min(score.score for score in store.scores) > 0

    asyncio.run(run())


def test_vibe_summary_lists_real_shared_interest_tags_without_phone_numbers() -> None:
    async def run() -> None:
        service = MatchmakingService(FakeMatchmakingStore(seeded_nandi_group()))

        vibe = await service.activity_vibe("11111111-1111-4111-8111-111111111111")

        assert vibe is not None
        payload = vibe.to_json()
        assert payload["shared_interests"] == [
            {"tag": "cycling", "count": 2},
            {"tag": "trails", "count": 2},
        ]
        summary = payload["summary"]
        assert isinstance(summary, str)
        assert "Hemant Rao" in summary
        assert "+919900000001" not in json.dumps(payload)
        assert "phone" not in json.dumps(payload).lower()

    asyncio.run(run())


def seeded_nandi_group() -> MatchActivityGroup:
    return MatchActivityGroup(
        activity_id="11111111-1111-4111-8111-111111111111",
        title="Nandi Hills sunrise trail ride",
        pillar="move",
        category="cycling",
        host=MatchProfile(
            id="22222222-2222-4222-8222-222222222222",
            display_name="Hemant Rao",
            interests=("cycling", "trails", "sunrise"),
            role="host",
        ),
        explorers=(
            MatchProfile(
                id="55555555-5555-4555-8555-555555555555",
                display_name="Nisha Pai",
                interests=("cycling", "coffee", "journaling"),
                role="attendee",
            ),
            MatchProfile(
                id="77777777-7777-4777-8777-777777777777",
                display_name="Vikram Bhat",
                interests=("trails", "running", "birding"),
                role="attendee",
            ),
        ),
    )


class FakeMatchmakingStore:
    def __init__(self, group: MatchActivityGroup) -> None:
        self.group = group
        self.scores: list[MatchScore] = []
        self.affinities = {
            group.host.id: ProfilePillarAffinity(same_pillar_count=2, total_count=2),
            group.explorers[0].id: ProfilePillarAffinity(same_pillar_count=1, total_count=1),
            group.explorers[1].id: ProfilePillarAffinity(same_pillar_count=1, total_count=1),
        }
        self.similarities = {
            group.explorers[0].id: 0.72,
            group.explorers[1].id: 0.64,
        }

    async def fetch_activity_group(self, activity_id: str) -> MatchActivityGroup | None:
        if activity_id != self.group.activity_id:
            return None
        return self.group

    async def fetch_activity_ids_for_recompute(self, limit: int) -> list[str]:
        del limit
        return [self.group.activity_id]

    async def fetch_pillar_affinities(
        self,
        profile_ids: Sequence[str],
        pillar: Pillar,
    ) -> dict[str, ProfilePillarAffinity]:
        del pillar
        return {
            profile_id: self.affinities[profile_id]
            for profile_id in profile_ids
            if profile_id in self.affinities
        }

    async def fetch_embedding_similarity(
        self,
        profile_id: str,
        comparison_profile_ids: Sequence[str],
    ) -> float | None:
        del comparison_profile_ids
        return self.similarities.get(profile_id)

    async def upsert_match_scores(self, scores: Sequence[MatchScore]) -> None:
        self.scores = list(scores)
