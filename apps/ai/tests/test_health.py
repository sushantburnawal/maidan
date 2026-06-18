import asyncio

import httpx

from maidan_ai.main import create_app


def test_health() -> None:
    async def run() -> None:
        transport = httpx.ASGITransport(app=create_app())
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get("/health")

        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        assert response.json()["service"] == "ai"

    asyncio.run(run())
