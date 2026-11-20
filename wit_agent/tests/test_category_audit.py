import asyncio
import json
from types import SimpleNamespace

from wit_agent.agent import ShoppingAgent, product_source_name, select_products
from wit_agent.category_audit import CategoryAuditAgent
from wit_agent.llm import validate_exclude_terms
from wit_agent.memory import MemoryManager
from wit_agent.tests.narrative_stub import EvidenceNarrator


class JsonModel:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = 0

    async def complete(self, _request, _invocation):
        self.calls += 1
        value = self.outputs.pop(0)
        return SimpleNamespace(final_text=json.dumps(value, ensure_ascii=False))


def run(coro):
    return asyncio.run(coro)


def test_shared_exclusions_survive_user_forget_and_queries_are_regenerated(tmp_path):
    async def scenario():
        memory = MemoryManager(tmp_path / "memory.sqlite3")
        model = JsonModel([
            {"queries": ["通勤显瘦长裙", "女士通勤裙子"]},
            {"excludeTerms": ["小皮鞋", "打底袜", "腰带", "披肩"]},
            {"queries": ["度假飘逸长裙", "海边裙子"]},
        ])
        auditor = CategoryAuditAgent(memory, model)
        first = await auditor.plan_search(None, {
            "targetCategory": "裙子", "goal": "通勤裙子",
            "preferences": {"scene": "通勤"},
            "answers": [{"id": "detail", "value": "显瘦长裙"}],
        })
        memory.save("s", {"preferences": {"style": "法式"}})
        memory.forget("s", "all")
        second = await auditor.plan_search(None, {
            "targetCategory": "裙子", "goal": "度假裙子",
            "preferences": {"scene": "度假"},
            "answers": [{"id": "detail", "value": "飘逸"}],
        })
        assert first["excludeTermsSource"] == "generated"
        assert second["excludeTermsSource"] == "memory"
        assert first["excludeTerms"] == second["excludeTerms"]
        assert first["queries"] != second["queries"]
        assert model.calls == 3  # two query plans; exclusion generation only once
        assert memory.get_category_exclusions("裙子") == first["excludeTerms"]

    run(scenario())


def test_exclusions_reject_target_subcategories_without_category_specific_rules():
    assert validate_exclude_terms([
        "咖啡豆", "咖啡粉", "咖啡礼盒", "咖啡饮料",
        "滤纸", "清洁片", "手冲壶", "滤纸",
    ], "咖啡") == ["滤纸", "清洁片", "手冲壶"]


def test_old_contaminated_exclusions_are_regenerated_by_current_prompt(tmp_path):
    async def scenario():
        memory = MemoryManager(tmp_path / "regenerate.db")
        memory.save_category_exclusions(
            "咖啡", ["咖啡豆", "咖啡粉", "咖啡礼盒", "咖啡饮料"],
        )
        model = JsonModel([
            {"queries": ["办公室咖啡", "现磨咖啡"]},
            {"excludeTerms": ["滤纸", "清洁片", "手冲壶", "咖啡豆", "咖啡礼盒"]},
        ])
        auditor = CategoryAuditAgent(memory, model)
        plan = await auditor.plan_search(None, {
            "targetCategory": "咖啡", "goal": "办公室喝咖啡",
            "preferences": {}, "answers": [],
        })
        assert plan["excludeTermsSource"] == "regenerated"
        assert plan["excludeTerms"] == ["滤纸", "清洁片", "手冲壶"]
        assert memory.get_category_exclusions("咖啡") == plan["excludeTerms"]

    run(scenario())


def test_audit_is_closed_world_and_missing_rows_are_uncertain(tmp_path):
    async def scenario():
        model = JsonModel([{"decisions": [
            {"id": "accepted", "decision": "accepted", "primaryCategory": "移动电源", "confidence": 0.98},
            {"id": "accepted", "decision": "reject", "primaryCategory": "配件", "confidence": 1},
            {"id": "rejected", "decision": "reject", "primaryCategory": "保护套", "reason": "本体是保护套", "confidence": 0.97},
            {"id": "forged", "decision": "accept", "primaryCategory": "充电宝", "confidence": 1},
            {"id": "missing-category", "decision": "accept", "confidence": 1},
        ]}])
        auditor = CategoryAuditAgent(MemoryManager(tmp_path / "m.db"), model)
        result = await auditor.audit_products(None, "充电宝", ["保护套"], [
            {"id": "accepted", "title": "充电宝赠保护套", "source": "taobao"},
            {"id": "rejected", "title": "充电宝赠保护套", "source": "taobao"},
            {"id": "omitted", "title": "充电宝赠保护套", "source": "taobao"},
            {"id": "missing-category", "title": "充电宝赠保护套", "source": "taobao"},
        ])
        assert [row["id"] for row in result["accepted"]] == ["accepted"]
        assert [row["id"] for row in result["rejected"]] == ["rejected"]
        assert {row["id"] for row in result["uncertain"]} == {"omitted", "missing-category"}

    run(scenario())


def test_local_fallback_distinguishes_product_body_from_accessory(tmp_path):
    async def scenario():
        auditor = CategoryAuditAgent(MemoryManager(tmp_path / "local.db"), None)
        cases = (
            ("裙子", "法式小皮鞋女配裙子", "rejected"),
            ("裙子", "法式通勤显瘦长裙", "accepted"),
            ("充电宝", "充电宝保护套", "rejected"),
            ("充电宝", "充电宝赠保护套", "uncertain"),
            ("餐桌", "防水餐桌布", "rejected"),
            ("餐桌", "小户型实木餐桌", "accepted"),
            ("台灯", "台灯灯罩配件", "rejected"),
            ("台灯", "阅读护眼桌面台灯", "accepted"),
        )
        for index, (category, title, expected) in enumerate(cases):
            result = await auditor.audit_products(
                None, category, [], [{"id": str(index), "title": title}],
            )
            assert [row["id"] for row in result[expected]] == [str(index)]

    run(scenario())


def test_basic_filter_diagnostics_explain_every_rejection():
    diagnostics = {}
    selected = select_products([
        {"id": "power", "title": "大容量移动电源快充", "price": 99},
        {"id": "expensive", "title": "大容量充电宝", "price": 399},
        {"id": "valid", "title": "便携大容量充电宝", "price": 129},
        {"id": "valid", "title": "重复ID充电宝", "price": 99},
    ], {"category": "充电宝", "maxPrice": 200}, limit=20, diagnostics=diagnostics)

    assert [item["id"] for item in selected] == ["power", "valid"]
    assert diagnostics["normalizedCount"] == 4
    assert diagnostics["qualifiedCount"] == 2
    assert diagnostics["rejectionReasons"] == {
        "over_budget": 1,
        "duplicate_id": 1,
    }


def test_hybrid_audit_keeps_obvious_products_local_and_chunks_ambiguity(tmp_path):
    async def scenario():
        model = JsonModel([
            {"decisions": [
                {"id": f"gift-{index}", "decision": "accept",
                 "primaryCategory": "充电宝", "confidence": 0.9}
                for index in range(5)
            ]},
            {"decisions": [
                {"id": "gift-5", "decision": "accept",
                 "primaryCategory": "移动电源", "confidence": 0.9}
            ]},
        ])
        auditor = CategoryAuditAgent(MemoryManager(tmp_path / "hybrid.db"), model)
        obvious = await auditor.audit_products(None, "充电宝", ["保护套"], [
            {"id": "power", "title": "大容量快充移动电源"},
            {"id": "case", "title": "充电宝保护套"},
        ])
        assert [row["id"] for row in obvious["accepted"]] == ["power"]
        assert [row["id"] for row in obvious["rejected"]] == ["case"]
        assert model.calls == 0

        ambiguous = await auditor.audit_products(None, "充电宝", ["保护套"], [
            {"id": f"gift-{index}", "title": "充电宝赠保护套"}
            for index in range(6)
        ])
        assert len(ambiguous["accepted"]) == 6
        assert model.calls == 2
        assert all(row["auditMethod"] == "model" for row in ambiguous["accepted"])

    run(scenario())


def test_shopping_agent_retries_and_audits_taobao_and_yuemai(tmp_path):
    async def scenario():
        calls = []

        async def search(query, filters):
            source = filters.get("_source")
            calls.append((source, query))
            if source == "yuemai":
                return {"ok": True, "source": "yuemai", "items": [
                    {"id": "yuemai:shoe", "title": "法式小皮鞋女配裙子", "source": "yuemai"},
                ]}
            taobao_round = sum(1 for call_source, _ in calls if call_source == "taobao")
            items = ([
                {"id": "taobao:d1", "title": "法式通勤显瘦长裙", "source": "taobao"},
                {"id": "taobao:shoe", "title": "小皮鞋女配裙子", "source": "taobao"},
            ] if taobao_round == 1 else [
                {"id": "taobao:d2", "title": "女士通勤裙子长款", "source": "taobao"},
                {"id": "taobao:d3", "title": "显瘦连衣裙通勤", "source": "taobao"},
            ])
            return {"ok": True, "source": "taobao", "items": items}

        search.supports_product_sources = True
        async with ShoppingAgent(
            tmp_path / "integrated.db", search, questionnaire_enabled=False,
            narrator=EvidenceNarrator(),
        ) as agent:
            result = await agent.chat("s", "想买裙子，通勤穿")

        assert {item["id"] for item in result["items"]} == {
            "taobao:d1", "taobao:d2", "taobao:d3",
        }
        assert all(product_source_name(item) == "taobao" for item in result["items"])
        assert len([call for call in calls if call[0] == "taobao"]) == 2
        assert len([call for call in calls if call[0] == "yuemai"]) == 1
        assert all(item.get("categoryAudit", {}).get("primaryCategory") == "裙子"
                   for item in result["items"])
        events = [json.loads(line) for line in
                  (tmp_path / "category-audit.events.jsonl").read_text(encoding="utf-8").splitlines()]
        filter_events = [event for event in events if event["event"] == "category_basic_filter"]
        assert filter_events
        assert filter_events[0]["sourceCount"] == 2
        assert filter_events[0]["rejectionReasons"] == {}

    run(scenario())


def test_taobao_failure_can_fall_back_to_audited_yuemai(tmp_path):
    async def scenario():
        async def search(_query, filters):
            if filters.get("_source") == "taobao":
                raise OSError("taobao offline")
            return {"ok": True, "source": "yuemai", "items": [
                {"id": "yuemai:lamp", "title": "阅读桌面台灯", "source": "yuemai"},
            ]}

        search.supports_product_sources = True
        async with ShoppingAgent(
            tmp_path / "fallback.db", search, questionnaire_enabled=False,
            narrator=EvidenceNarrator(),
        ) as agent:
            result = await agent.chat("s", "想买台灯")
        assert result["ok"]
        assert [item["id"] for item in result["items"]] == ["yuemai:lamp"]
        assert result["items"][0]["categoryAudit"]["primaryCategory"] == "台灯"

    run(scenario())
