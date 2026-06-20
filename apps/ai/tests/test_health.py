import asyncio

import httpx
from pytest import MonkeyPatch

from maidan_ai.anthropic_client import AnthropicClient
from maidan_ai.config import Settings
from maidan_ai.main import create_app
from maidan_ai.openrouter_client import OpenRouterClient


def test_health() -> None:
    async def run() -> None:
        transport = httpx.ASGITransport(app=create_app())
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get("/health")

        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        assert response.json()["service"] == "ai"

    asyncio.run(run())


def test_ready_reflects_dependency_status(monkeypatch: MonkeyPatch) -> None:
    async def run() -> None:
        monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
        app = create_app()
        app.state.settings = Settings()
        app.state.db_pool = FakeDbPool()
        app.state.redis = FakeRedis(healthy=False)
        openrouter_http = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={})),
            base_url="https://openrouter.test",
        )
        app.state.llm_provider = OpenRouterClient(
            app.state.settings,
            http_client=openrouter_http,
        )

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get("/health/ready")

        await openrouter_http.aclose()

        assert response.status_code == 503
        assert response.json()["status"] == "unhealthy"
        assert response.json()["checks"]["redis"]["status"] == "unhealthy"
        assert response.json()["checks"]["llm"]["status"] == "ok"
        assert response.json()["checks"]["llm"]["provider"] == "openrouter"

    asyncio.run(run())


def test_ready_reports_openrouter_auth_failure(monkeypatch: MonkeyPatch) -> None:
    async def run() -> None:
        monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
        app = create_app()
        app.state.settings = Settings()
        app.state.db_pool = FakeDbPool()
        app.state.redis = FakeRedis(healthy=True)
        openrouter_http = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _request: httpx.Response(401, json={})),
            base_url="https://openrouter.test",
        )
        app.state.llm_provider = OpenRouterClient(
            app.state.settings,
            http_client=openrouter_http,
        )

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get("/health/ready")

        await openrouter_http.aclose()

        assert response.status_code == 503
        body = response.json()
        assert body["checks"]["llm"]["status"] == "unhealthy"
        assert "OpenRouter auth failed" in body["checks"]["llm"]["detail"]

    asyncio.run(run())


def test_ready_uses_anthropic_when_selected(monkeypatch: MonkeyPatch) -> None:
    async def run() -> None:
        monkeypatch.setenv("AI_PROVIDER", "anthropic")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        app = create_app()
        settings = Settings()
        app.state.settings = settings
        app.state.db_pool = FakeDbPool()
        app.state.redis = FakeRedis(healthy=True)
        anthropic_http = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={})),
            base_url="https://anthropic.test",
        )
        app.state.llm_provider = AnthropicClient(settings, http_client=anthropic_http)

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get("/health/ready")

        await anthropic_http.aclose()

        assert response.status_code == 200
        assert response.json()["checks"]["llm"]["provider"] == "anthropic"

    asyncio.run(run())


def test_claude_call_increments_internal_cost_metric(monkeypatch: MonkeyPatch) -> None:
    async def run() -> None:
        monkeypatch.setenv("AI_PROVIDER", "anthropic")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        app = create_app()
        settings = Settings()

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST":
                return httpx.Response(
                    200,
                    json={
                        "content": [{"type": "text", "text": "ok"}],
                        "usage": {
                            "input_tokens": 1000,
                            "output_tokens": 200,
                            "cache_creation_input_tokens": 50,
                            "cache_read_input_tokens": 25,
                        },
                    },
                )
            return httpx.Response(200, json={})

        anthropic_http = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://anthropic.test",
        )
        anthropic = AnthropicClient(settings, http_client=anthropic_http)
        app.state.settings = settings
        app.state.llm_provider = anthropic

        assert await anthropic.cheap_call("hello") == "ok"

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get("/internal/metrics")

        await anthropic_http.aclose()

        assert response.status_code == 200
        haiku = response.json()["claude"]["today"]["haiku"]
        assert haiku["calls"] == 1
        assert haiku["input_tokens"] == 1000
        assert haiku["output_tokens"] == 200
        assert haiku["cost_usd"] > 0

    asyncio.run(run())


class FakeDbPool:
    async def execute(self, _query: str, *args: object) -> object:
        del args
        return "SELECT 1"


class FakeRedis:
    def __init__(self, *, healthy: bool) -> None:
        self._healthy = healthy

    async def ping(self) -> str:
        if not self._healthy:
            raise RuntimeError("redis down")
        return "PONG"
