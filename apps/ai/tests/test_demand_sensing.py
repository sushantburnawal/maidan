from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from maidan_ai.demand_sensing import (
    DEMAND_SENSING_RUBRIC,
    DemandBucket,
    DemandPersistenceResult,
    DemandSensingModelOutputError,
    DemandSensingRunConfig,
    DemandSensingRunner,
    DemandSensingService,
    DemandSignal,
    DemandTag,
    bucket_id,
    demand_signal_evidence,
    parse_demand_response,
    should_create_host_nudge,
)
from maidan_ai.domain_events import JsonObject


def test_seeded_shape_batch_writes_evidence_and_host_nudge_for_unmet_cycling() -> None:
    async def run() -> None:
        bucket = seeded_indiranagar_move_gap_bucket()
        client = FakeCheapDemandClient(
            [
                json.dumps(
                    {
                        "signals": [
                            {
                                "id": bucket.id,
                                "area": "Indiranagar",
                                "pillar": "move",
                                "signal_strength": 0.91,
                                "unmet_interest": ["cycling"],
                                "suggested_action": (
                                    "Invite cycling hosts to run beginner rides near Indiranagar."
                                ),
                                "evidence": [
                                    "Recent Indiranagar explorers booked cycling outside the area.",
                                    "There are no open cycling slots in Indiranagar.",
                                ],
                            }
                        ]
                    }
                )
            ]
        )
        store = FakeDemandStore([bucket])
        runner = DemandSensingRunner(
            store,
            DemandSensingService(client),
            DemandSensingRunConfig(),
        )

        result = await runner.run_once(run_at=datetime(2026, 6, 19, tzinfo=UTC))

        assert result.bucket_count == 1
        assert result.demand_signal_count == 1
        assert result.host_nudge_count == 1
        assert client.calls[0]["system"] == DEMAND_SENSING_RUBRIC
        assert '"id":"indiranagar:move"' in str(client.calls[0]["prompt"])
        assert store.evidence[0]["model_evidence"]
        assert store.evidence[0]["source_samples"]
        assert store.host_nudge_signals == ["indiranagar:move"]

    asyncio.run(run())


def test_demand_response_requires_explainable_evidence() -> None:
    bucket = seeded_indiranagar_move_gap_bucket()
    raw_response = json.dumps(
        {
            "signals": [
                {
                    "id": bucket.id,
                    "area": bucket.area,
                    "pillar": bucket.pillar,
                    "signal_strength": 0.8,
                    "unmet_interest": ["cycling"],
                    "suggested_action": "Invite cycling hosts.",
                    "evidence": [],
                }
            ]
        }
    )

    try:
        parse_demand_response(raw_response, [bucket])
    except DemandSensingModelOutputError:
        return

    raise AssertionError("demand-sensing response without evidence was accepted")


def test_demand_sensing_repairs_invalid_json_before_persisting() -> None:
    async def run() -> None:
        bucket = seeded_indiranagar_move_gap_bucket()
        client = FakeCheapDemandClient(
            [
                "not-json",
                json.dumps(
                    {
                        "signals": [
                            {
                                "id": bucket.id,
                                "area": "Indiranagar",
                                "pillar": "move",
                                "signal_strength": 0.8,
                                "unmet_interest": ["cycling"],
                                "suggested_action": "Invite cycling hosts.",
                                "evidence": ["No open cycling slots near Indiranagar."],
                            }
                        ]
                    }
                ),
            ]
        )
        store = FakeDemandStore([bucket])
        runner = DemandSensingRunner(
            store,
            DemandSensingService(client),
            DemandSensingRunConfig(),
        )

        result = await runner.run_once(run_at=datetime(2026, 6, 19, tzinfo=UTC))

        assert result.demand_signal_count == 1
        assert len(client.calls) == 2
        assert "failed JSON validation" in str(client.calls[1]["prompt"])
        assert store.evidence[0]["model_evidence"] == ["No open cycling slots near Indiranagar."]

    asyncio.run(run())


def seeded_indiranagar_move_gap_bucket() -> DemandBucket:
    return DemandBucket(
        id=bucket_id("Indiranagar", "move"),
        area="Indiranagar",
        pillar="move",
        booking_count=2,
        booking_headcount=3,
        pending_booking_count=1,
        post_count=1,
        message_count=0,
        interested_explorer_count=1,
        activity_count=1,
        open_slot_count=2,
        open_seat_count=19,
        avg_fill_rate=0.05,
        tags=(
            DemandTag(
                tag="cycling",
                score=6.6,
                sources=("booking", "profile_interest"),
            ),
            DemandTag(tag="sunrise", score=0.6, sources=("profile_interest",)),
        ),
        evidence=(
            "3 confirmed/pending booking headcount for Nandi Hills sunrise trail ride "
            "from Indiranagar explorer demand",
            "Demand is from Indiranagar even though the booked supply is in Nandi Hills",
            "Explorer interest cluster in Indiranagar includes cycling",
            "2 open move slots and 19 open seats in Indiranagar",
        ),
        source_counts={"booking": 2, "profile_interest": 1, "post": 1},
        open_slots_by_tag={"strength": 2},
        open_seats_by_tag={"strength": 19},
        demand_score=7.55,
    )


@dataclass
class FakeDemandStore:
    buckets: list[DemandBucket]

    def __post_init__(self) -> None:
        self.signals: list[DemandSignal] = []
        self.evidence: list[JsonObject] = []
        self.host_nudge_signals: list[str] = []

    async def fetch_buckets(
        self,
        *,
        window_start: datetime,
        window_end: datetime,
        supply_window_end: datetime,
    ) -> list[DemandBucket]:
        del window_start, window_end, supply_window_end
        return self.buckets

    async def persist_signals(
        self,
        signals: Sequence[DemandSignal],
        buckets: Mapping[str, DemandBucket],
        *,
        window_start: datetime,
        window_end: datetime,
        config: DemandSensingRunConfig,
    ) -> DemandPersistenceResult:
        del window_start, window_end
        self.signals.extend(signals)
        host_nudge_count = 0
        signal_ids: list[str] = []
        for index, signal in enumerate(signals, start=1):
            bucket = buckets[signal.bucket_id]
            self.evidence.append(demand_signal_evidence(signal, bucket))
            signal_ids.append(f"signal-{index}")
            if should_create_host_nudge(signal, bucket, config):
                host_nudge_count += 1
                self.host_nudge_signals.append(signal.bucket_id)

        return DemandPersistenceResult(
            demand_signal_count=len(signals),
            host_nudge_count=host_nudge_count,
            demand_signal_ids=tuple(signal_ids),
        )


class FakeCheapDemandClient:
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
