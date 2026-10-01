"""Tests for the evaluation harness; they do not assert agent quality."""

import asyncio
import os
import unittest

from evaluation.run_regression import compare_value, evaluate, load_inputs, run_local_agent, MISSING


class DataTests(unittest.TestCase):
    def test_pack_references_and_multi_turn_coverage(self):
        scenarios, checks = load_inputs()
        self.assertEqual(len(scenarios["scenarios"]), 36)
        self.assertEqual(sum(len(s["turns"]) for s in scenarios["scenarios"]), 75)
        self.assertEqual(len(checks["cross_session"]), 8)
        self.assertGreater(len(checks["search_delta"]), 20)

    def test_missing_cannot_pass_as_absent_except_explicit_absence(self):
        self.assertTrue(compare_value(MISSING, {"op": "absent"}))
        self.assertFalse(compare_value(MISSING, {"op": "eq", "value": "原木"}))
        self.assertFalse(compare_value(MISSING, {"op": "contains", "value": "原木"}))


class ScoringTests(unittest.TestCase):
    def setUp(self):
        all_scenarios, _ = load_inputs()
        self.product = all_scenarios["catalog"]["products"][0]
        self.scenarios = {
            "catalog": all_scenarios["catalog"],
            "scenarios": [{"id": "X01", "turns": [
                {"expect": {"purchase_intent": "none"}}
            ]}],
        }
        self.checks = {
            "memory": [{"scenario": "X01", "turn": 1, "path": "preferences.style",
                        "op": "eq", "value": "原木"}],
            "cross_session": [],
            "emotion_routing": [{"scenario": "X01", "turn": 1,
                                 "mood": "bored", "action": "explore"}],
            "search_delta": [{"scenario": "X01", "turn": 1, "op": "zero"}],
            "fact_text": [{"scenario": "X01", "turn": 1,
                           "op": "unknown", "topic_any": ["材质"]}],
        }

    def test_detects_research_pressure_and_unsupported_fact(self):
        product = self.product
        item = {"id": product["id"], "title": product["title"],
                "price": 1, "facts": {"title": product["title"], "price": 1,
                "material": product["material"], "color": product["color"],
                "dimensions": None}, "promotionUrl": ""}
        trace = {"turns": {"X01": [{
            "response": {"ok": True, "type": "results", "message": "立即购买",
                         "items": [item], "emotion": {"mood": "neutral"},
                         "policy": {"action": "search", "push_purchase": True}},
            "post_memory": {"preferences": {}}, "search_calls": [{"query": "灯"}],
        }]}, "boundaries": {}}
        report = evaluate(self.scenarios, self.checks, trace)
        failed = {row["metric"] for row in report["checks"] if not row["pass"]}
        self.assertEqual(failed, {"no_purchase_boundary", "structured_grounding",
                                  "memory", "emotion_routing", "followup_no_research",
                                  "fact_text"})
        self.assertEqual(report["summary"]["scenario_count"], 1)

    def test_missing_response_does_not_count_as_success(self):
        trace = {"turns": {"X01": [{"response": {}, "post_memory": {},
                                      "search_calls": [], "error": "agent error"}]},
                 "boundaries": {}}
        report = evaluate(self.scenarios, self.checks, trace)
        self.assertFalse(next(row for row in report["checks"]
                              if row["metric"] == "execution")["pass"])
        self.assertFalse(next(row for row in report["checks"]
                              if row["metric"] == "no_purchase_boundary")["pass"])
        self.assertFalse(next(row for row in report["checks"]
                              if row["metric"] == "memory")["pass"])

    def test_cross_session_checks_persisted_preference_not_harness_cleanup(self):
        checks = {**self.checks, "cross_session": [
            {"scenario": "X01", "path": "preferences.maxPrice", "op": "eq", "value": 100}
        ]}
        trace = {"turns": {"X01": [{"response": {"ok": True, "type": "question",
                                                 "message": "材质未提供。", "items": [],
                                                 "emotion": {"mood": "bored"},
                                                 "policy": {"action": "explore", "push_purchase": False}},
                                      "post_memory": {"preferences": {"style": "原木"}},
                                      "search_calls": []}]},
                 "boundaries": {"X01": {"preferences": {"maxPrice": 150},
                                         "current_items": [self.product]}}}
        report = evaluate(self.scenarios, checks, trace)
        boundary = [row for row in report["checks"] if row["metric"] == "cross_session"]
        self.assertEqual(len(boundary), 1)
        self.assertFalse(boundary[0]["pass"])
        self.assertEqual(boundary[0]["observed"], 150)
        isolation = next(row for row in report["checks"] if row["metric"] == "session_isolation")
        self.assertFalse(isolation["pass"])

    def test_missing_trace_cannot_pass_absence_or_zero_search(self):
        checks = {**self.checks, "memory": [
            {"scenario": "X01", "turn": 1, "path": "preferences.style", "op": "absent"}
        ]}
        report = evaluate(self.scenarios, checks, {"turns": {}, "boundaries": {}})
        for metric in ("execution", "memory", "followup_no_research"):
            self.assertFalse(next(row for row in report["checks"]
                                  if row["metric"] == metric)["pass"])


class AgentApiTests(unittest.TestCase):
    @unittest.skipUnless(os.getenv("WIT_FRAMEWORK_PATH"), "WIT_FRAMEWORK_PATH is required")
    def test_real_user_session_split_and_visible_products(self):
        scenarios, checks = load_inputs()
        selected = {"C13", "M19"}
        scenarios = {**scenarios, "scenarios": [s for s in scenarios["scenarios"]
                                                if s["id"] in selected]}
        traces = asyncio.run(run_local_agent(scenarios, checks))
        current = traces["setup"]["C13"]["memory"]["current_items"]
        self.assertEqual([item["id"] for item in current], ["lamp_01", "lamp_02"])
        self.assertEqual(current[0]["facts"]["material"], "木、玻璃")
        self.assertEqual([item["id"] for item in traces["turns"]["C13"][0]
                          ["pre_memory"]["current_items"]], ["lamp_01", "lamp_02"])
        first, second = traces["turns"]["M19"]
        self.assertEqual(first["user_id"], second["user_id"])
        self.assertNotEqual(first["session_id"], second["session_id"])
        self.assertEqual(traces["boundaries"]["M19"]["preferences"].get("style"), "原木")
        self.assertEqual(traces["boundaries"]["M19"]["current_items"], [])


if __name__ == "__main__":
    unittest.main()
