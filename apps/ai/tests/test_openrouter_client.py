from __future__ import annotations

import asyncio
import json
from typing import cast

import httpx
from pytest import MonkeyPatch

from maidan_ai.config import Settings
from maidan_ai.domain_events import JsonObject
from maidan_ai.openrouter_client import OpenRouterClient


def test_openrouter_cheap_call_requests_json_without_reasoning(
    monkeypatch: MonkeyPatch,
) -> None:
    async def run() -> None:
        monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
        requests: list[dict[str, object]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            requests.append(payload)
            assert request.headers["authorization"] == "Bearer test-key"
            assert request.url.path == "/chat/completions"
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '{"allow":true,"categories":[],"severity":0,'
                                    '"reason":"Safe."}'
                                )
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 12, "completion_tokens": 8},
                },
            )

        http_client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://openrouter.test",
        )
        client = OpenRouterClient(Settings(), http_client=http_client)

        result = await client.cheap_call("Moderate this", system="rubric")

        await http_client.aclose()

        assert '"allow":true' in result
        assert requests[0]["model"] == "google/gemma-4-31b-it:free"
        assert requests[0]["response_format"] == {"type": "json_object"}
        assert requests[0]["reasoning"] == {"enabled": False}
        today = cast(JsonObject, client.metrics.snapshot()["today"])
        haiku = cast(JsonObject, today["haiku"])
        assert haiku["calls"] == 1

    asyncio.run(run())


def test_openrouter_chat_call_normalizes_tool_calls(monkeypatch: MonkeyPatch) -> None:
    async def run() -> None:
        monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")

        def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            assert payload["tools"][0]["function"]["name"] == "search_activities"
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": "call_1",
                                        "type": "function",
                                        "function": {
                                            "name": "search_activities",
                                            "arguments": '{"query":"cycling near Indiranagar"}',
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                    "usage": {"prompt_tokens": 20, "completion_tokens": 5},
                },
            )

        http_client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://openrouter.test",
        )
        client = OpenRouterClient(Settings(), http_client=http_client)

        response = await client.chat_call(
            [{"role": "user", "content": "Find cycling"}],
            tools=[
                {
                    "name": "search_activities",
                    "description": "Search activities.",
                    "input_schema": {"type": "object"},
                }
            ],
        )

        await http_client.aclose()

        assert response.tool_calls[0].id == "call_1"
        assert response.tool_calls[0].name == "search_activities"
        assert response.tool_calls[0].input == {"query": "cycling near Indiranagar"}
        today = cast(JsonObject, client.metrics.snapshot()["today"])
        sonnet = cast(JsonObject, today["sonnet"])
        assert sonnet["calls"] == 1

    asyncio.run(run())


def test_openrouter_rate_limit_is_not_swallowed(monkeypatch: MonkeyPatch) -> None:
    async def run() -> None:
        monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
        monkeypatch.setenv("OPENROUTER_MAX_RETRIES", "0")
        http_client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _request: httpx.Response(429, json={})),
            base_url="https://openrouter.test",
        )
        client = OpenRouterClient(Settings(), http_client=http_client)

        try:
            await client.cheap_call("Moderate this")
        except RuntimeError as error:
            assert "rate limit" in str(error)
        else:
            raise AssertionError("OpenRouter 429 was swallowed")
        finally:
            await http_client.aclose()

    asyncio.run(run())
