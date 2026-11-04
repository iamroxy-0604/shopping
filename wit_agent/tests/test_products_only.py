import asyncio
from wit_agent.agent import ShoppingAgent
from wit_agent.tests.narrative_stub import EvidenceNarrator


def test_products_only_does_not_fetch_posts(tmp_path):
    async def scenario():
        calls = []
        async def search(query, filters):
            return {"ok": True, "items": [{"id": "lamp", "title": "书桌台灯", "price": 89}]}
        async def content(task):
            calls.append(task)
            raise AssertionError("Desktop shopping must not call content retrieval")
        async with ShoppingAgent(tmp_path / "shopping.db", search, narrator=EvidenceNarrator(),
                                 questionnaire_enabled=False, content_search=content) as agent:
            result = await agent.chat("desktop-session", "我想买台灯", products_only=True)
            assert result["type"] == "results"
            assert result["items"]
            assert result["contentRecords"] == []
            assert calls == []
            assert "篇相关帖子" not in result["message"]
    asyncio.run(scenario())
