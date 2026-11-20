import asyncio

from wit_agent.agent import ShoppingAgent
from wit_agent.requirement import (derive_legacy_preferences, extract_high_confidence_fallbacks,
                                   merge_requirement, validate_requirement_delta)
from wit_agent.tests.narrative_stub import EvidenceNarrator


def test_compound_brand_category_price_and_color_are_separated():
    text = "我想买500元以内的白色苏泊尔电饭锅，不要黑色"
    delta = validate_requirement_delta(extract_high_confidence_fallbacks(text), text)
    requirement = merge_requirement(None, delta, text)

    assert requirement["category"]["canonical"] == "电饭锅"
    assert requirement["category"]["aliases"] == ["电饭锅", "电饭煲", "饭煲"]
    assert [row["canonical"] for row in requirement["brands"]["include"]] == ["苏泊尔"]
    assert requirement["price"]["max"] == 500
    assert [row["canonical"] for row in requirement["colors"]["exclude"]] == ["黑色"]


def test_evidence_gate_rejects_invented_explicit_fields():
    delta = validate_requirement_delta({
        "intent": "search_product",
        "changes": {
            "category": {"set": {"raw": "空气炸锅", "source": "explicit", "evidence": "空气炸锅"}},
            "brands": {"addInclude": [{"raw": "美的", "source": "explicit", "evidence": "美的"}]},
        },
    }, "我想买电饭锅")

    assert "category" not in delta["changes"]
    assert "brands" not in delta["changes"]
    assert "category_failed_evidence_gate" in delta["parseWarnings"]


def test_brand_replacement_keeps_category_and_budget():
    first_text = "我想买500元以内的苏泊尔电饭锅"
    current = merge_requirement(None, validate_requirement_delta(
        extract_high_confidence_fallbacks(first_text), first_text), first_text)
    next_text = "换成美的吧"
    updated = merge_requirement(current, validate_requirement_delta(
        extract_high_confidence_fallbacks(next_text), next_text), next_text)
    legacy = derive_legacy_preferences(updated)

    assert legacy["category"] == "电饭锅"
    assert legacy["brand"] == "美的"
    assert legacy["maxPrice"] == 500


def test_requirement_drives_search_and_category_alias_filter(tmp_path):
    async def scenario():
        calls = []

        async def search(query, filters):
            calls.append((query, filters))
            return {"ok": True, "items": [
                {"id": "rice", "title": "苏泊尔5L家用电饭煲", "price": 399},
                {"id": "other", "title": "美的家用电饭煲", "price": 399},
                {"id": "case", "title": "苏泊尔电饭锅防尘保护套", "price": 29},
            ]}

        async with ShoppingAgent(tmp_path / "requirement.db", search,
                                 questionnaire_enabled=False,
                                 narrator=EvidenceNarrator()) as agent:
            result = await agent.chat("s", "我想买500元以内的苏泊尔电饭锅")
            memory = agent.memory.load("s")

        assert result["requirementDebug"]["category"] == "电饭锅"
        assert result["requirementDebug"]["brands"] == ["苏泊尔"]
        assert [item["id"] for item in result["items"]] == ["rice"]
        assert memory["shopping_requirement"]["category"]["canonical"] == "电饭锅"
        assert memory["last_search_plan"]["requiredEvidence"]["categoryAny"] == ["电饭锅", "电饭煲", "饭煲"]
        assert calls

    asyncio.run(scenario())


def test_default_questionnaire_has_executable_contract():
    from wit_agent.agent import default_questionnaire

    questions = default_questionnaire("电饭锅", {})
    assert all(question["field"] for question in questions)
    assert all(question["affects"] for question in questions)
    assert len({question["field"] for question in questions}) == len(questions)
