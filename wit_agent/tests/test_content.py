import asyncio

from wit_agent.agent import ShoppingAgent
from wit_agent.content import content_reply, normalize_link_record
from wit_agent.tests.narrative_stub import EvidenceNarrator


def test_content_followup_uses_saved_record_without_search(tmp_path):
    async def scenario():
        counts = {"product": 0, "content": 0}

        async def products(_query, _filters):
            counts["product"] += 1
            return {"ok": True, "items": [{"id": "lamp-1", "title": "书桌台灯", "price": 89}]}

        async def content(_task):
            counts["content"] += 1
            return {"status": "ok", "records": [{"id": "xiaohongshu:abc", "kind": "content", "title": "台灯体验", "body": "使用一周后觉得占地比较小。", "media": [], "retrieval": {"textAvailable": True}}]}

        async with ShoppingAgent(tmp_path / "content.db", products, narrator=EvidenceNarrator(),
                                 questionnaire_enabled=False, content_search=content) as agent:
            result = await agent.chat("s", "我想买台灯")
            assert result["type"] == "results"
            assert result["contentRecords"][0]["id"] == "xiaohongshu:abc"
            assert result["ui"]["blocks"][-1]["recordIds"] == ["xiaohongshu:abc"]
            before = counts.copy()
            answer = await agent.chat("s", "这篇为什么推荐它？", record_id="xiaohongshu:abc")
            assert answer["type"] == "content_detail"
            assert "占地比较小" in answer["message"]
            assert counts == before
            product_answer = await agent.chat("s", "这款价格多少？")
            assert product_answer["type"] == "comparison"
            assert counts == before

    asyncio.run(scenario())


def test_title_only_and_media_answers_do_not_invent():
    record = {"title": "台灯分享", "body": "", "media": []}
    assert "正文尚未取得" in content_reply(record, "为什么推荐")
    assert "没有进行图像或视频内容识别" in content_reply(record, "图里是什么")


def test_product_failure_does_not_discard_content(tmp_path):
    async def scenario():
        async def products(_query, _filters):
            raise OSError("product offline")

        async def content(_task):
            return {"status": "partial", "records": [{"id": "xiaohongshu:note", "kind": "content", "title": "台灯分享", "body": "", "media": [], "retrieval": {"textAvailable": False}}]}

        async with ShoppingAgent(tmp_path / "partial.db", products, questionnaire_enabled=False,
                                 content_search=content) as agent:
            result = await agent.chat("s", "我想买台灯")
            assert result["type"] == "results"
            assert result["items"] == []
            assert result["contentRecords"][0]["title"] == "台灯分享"
            assert agent.memory.load("s")["content_records"][0]["id"] == "xiaohongshu:note"
            answer = await agent.chat("s", "这篇说了什么？", record_id="xiaohongshu:note")
            assert "正文尚未取得" in answer["message"]

    asyncio.run(scenario())


def test_link_bridge_record_enters_session_without_product_search(tmp_path):
    async def scenario():
        calls = {"products": 0, "discovery": 0}

        async def products(_query, _filters):
            calls["products"] += 1
            return {"ok": True, "items": []}

        async def discover(_task):
            calls["discovery"] += 1
            return {"records": []}

        raw = {"id": "link:article", "source": {"url": "https://example.com/article", "platform": "example.com"},
               "title": "桌面布置经验", "body": "作者说台灯要考虑桌面空间。", "images": [],
               "status": "complete", "readBy": ["公开网页"]}
        normalized = normalize_link_record(raw)
        assert normalized["kind"] == "content"
        assert normalized["retrieval"]["textAvailable"]
        async with ShoppingAgent(tmp_path / "links.db", products, questionnaire_enabled=False,
                                 content_search=discover) as agent:
            result = await agent.chat("s", "参考 https://example.com/article", link_record=raw)
            assert result["type"] == "link_content"
            assert result["items"] == []
            assert result["contentRecords"][0]["source"]["url"] == raw["source"]["url"]
            assert calls == {"products": 0, "discovery": 0}
            answer = await agent.chat("s", "这篇说了什么？", record_id="link:article")
            assert answer["type"] == "content_detail"
            assert "桌面空间" in answer["message"]
            assert calls == {"products": 0, "discovery": 0}

    asyncio.run(scenario())


def test_multiple_links_keep_distinct_presentations_and_product_boundary(tmp_path):
    async def scenario():
        async def products(_query, _filters):
            raise AssertionError("link preview must not search products")

        source = [
            {"id": "link:video", "source": {"url": "https://example.com/video", "platform": "视频站"},
             "title": "一段视频", "status": "partial", "contentType": "video",
             "presentation": {"protocol": "v0.9.1", "layout": "video-fallback", "messages": [{"version": "v0.9.1"}]}},
            {"id": "link:article", "source": {"url": "https://example.com/article", "platform": "网页"},
             "title": "一篇文章", "body": "文章正文", "status": "complete", "contentType": "article",
             "presentation": {"protocol": "v0.9.1", "layout": "article", "messages": [{"version": "v0.9.1"}]}},
            {"id": "link:product", "source": {"url": "https://item.taobao.com/item.htm?id=1", "platform": "淘宝"},
             "title": "商品链接", "status": "partial", "linkCategory": "product"},
        ]
        async with ShoppingAgent(tmp_path / "multiple.db", products, questionnaire_enabled=False) as agent:
            result = await agent.chat("s", "看这三条", link_records=source)
            assert result["type"] == "link_content"
            assert len(result["contentRecords"]) == 3
            assert result["contentRecords"][0]["presentation"]["layout"] == "video-fallback"
            assert result["contentRecords"][1]["presentation"]["layout"] == "article"
            assert result["contentRecords"][2]["kind"] == "product_link"
            assert len(agent.memory.load("s")["content_records"]) == 3

    asyncio.run(scenario())
