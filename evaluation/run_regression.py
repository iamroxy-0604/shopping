"""Offline, evidence-backed regression against the local Wit shopping agent."""

from __future__ import annotations

import argparse
import asyncio
import copy
import gc
import hashlib
import json
import os
import re
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
UNKNOWN = re.compile(r"未提供|未列出|待确认|无法确认|不确定|不知道|没有.{0,8}信息|以商品详情为准")
PRESSURE = re.compile(r"立即购买|马上下单|赶紧买|现在下单|必须买|限时抢")
MISSING = object()


def load_inputs(scenarios_path: Path = HERE / "scenarios.json",
                checks_path: Path = HERE / "machine_checks.json") -> tuple[dict, dict]:
    scenarios = json.loads(scenarios_path.read_text(encoding="utf-8"))
    checks = json.loads(checks_path.read_text(encoding="utf-8"))
    by_id = {row["id"]: row for row in scenarios["scenarios"]}
    if len(by_id) != len(scenarios["scenarios"]) or not (30 <= len(by_id) <= 50):
        raise ValueError("scenario IDs must be unique and count must be 30–50")
    product_ids = {row["id"] for row in scenarios["catalog"]["products"]}
    if len(product_ids) != len(scenarios["catalog"]["products"]):
        raise ValueError("duplicate fixture product ID")
    for row in scenarios["scenarios"]:
        if len(row["turns"]) < 2 or set(row["setup"]["visible_product_ids"]) - product_ids:
            raise ValueError(f"invalid scenario setup: {row['id']}")
        sessions = [turn.get("session", 1) for turn in row["turns"]]
        if sessions != sorted(sessions) or sessions[0] != 1:
            raise ValueError(f"invalid session order: {row['id']}")
        for turn in row["turns"]:
            for name in ("mood", "intent", "purchase_intent", "policy"):
                if turn["expect"][name] not in scenarios["enums"][name]:
                    raise ValueError(f"invalid {name}: {row['id']}")
    for group in ("memory", "emotion_routing", "search_delta", "fact_text"):
        for check in checks[group]:
            scenario = by_id.get(check["scenario"])
            if scenario is None or not 1 <= check["turn"] <= len(scenario["turns"]):
                raise ValueError(f"invalid {group} check: {check}")
    for check in checks["cross_session"]:
        scenario = by_id.get(check["scenario"])
        if scenario is None or not any(turn.get("session", 1) > 1 for turn in scenario["turns"]):
            raise ValueError(f"invalid cross-session check: {check}")
    if set(checks["seed_preferences"]) - by_id.keys():
        raise ValueError("unknown seeded scenario")
    return scenarios, checks


def fixture_to_agent_product(product: dict, source: str) -> dict:
    return {
        "id": product["id"],
        "source": source,
        "facts": {
            "title": product["title"], "price": product["price_cny"],
            "material": product["material"], "color": product["color"],
            "dimensions": None,
        },
        "semantic": {"style_tags": product["style_tags"]},
    }


def get_path(data: dict, path: str):
    value = data
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            return MISSING
        value = value[part]
    return value


def compare_value(actual, spec: dict) -> bool:
    op = spec["op"]
    if op == "absent":
        return actual is MISSING or actual is None
    if actual is MISSING:
        return False
    if op == "eq":
        return actual == spec["value"]
    if op == "contains":
        return spec["value"] in actual if isinstance(actual, (list, str)) else False
    raise ValueError(f"unsupported comparison: {op}")


def result(metric: str, scenario: str, turn: int | None, passed: bool,
           observed, expected) -> dict:
    return {"metric": metric, "scenario": scenario, "turn": turn,
            "pass": bool(passed), "observed": observed, "expected": expected}


def evaluate(scenarios: dict, checks: dict, traces: dict) -> dict:
    """Only deterministic assertions. Missing evidence is a failure, never a pass."""
    outcomes = []
    catalog = {item["id"]: item for item in scenarios["catalog"]["products"]}
    scenario_map = {row["id"]: row for row in scenarios["scenarios"]}

    for sid, scenario in scenario_map.items():
        rows = traces["turns"].get(sid, [])
        for index, _ in enumerate(scenario["turns"], 1):
            row = rows[index - 1] if index <= len(rows) else {}
            response = row.get("response") or {}
            outcomes.append(result("execution", sid, index,
                                   bool(row) and bool(response.get("ok")) and not row.get("error"),
                                   row.get("error") or response.get("type"), "ok response"))
            if scenario["turns"][index - 1]["expect"]["purchase_intent"] == "none":
                policy = response.get("policy") or {}
                message = str(response.get("message") or "")
                passed = policy.get("push_purchase") is False and not PRESSURE.search(message)
                outcomes.append(result("no_purchase_boundary", sid, index, passed,
                                       {"push_purchase": policy.get("push_purchase"), "message": message},
                                       "push_purchase=false; no imperative purchase phrase"))
            items = response.get("items", [])
            if items and not isinstance(items, list):
                outcomes.append(result("structured_grounding", sid, index, False,
                                       type(items).__name__, "list of fixture products"))
            elif isinstance(items, list):
                for item in items:
                    fixture = catalog.get(item.get("id")) if isinstance(item, dict) else None
                    facts = item.get("facts") or {} if isinstance(item, dict) else {}
                    passed = fixture is not None and (
                        item.get("title") == fixture["title"]
                        and item.get("price") == fixture["price_cny"]
                        and facts.get("title") == fixture["title"]
                        and facts.get("price") == fixture["price_cny"]
                        and facts.get("material") == fixture["material"]
                        and facts.get("color") == fixture["color"]
                        and facts.get("dimensions") is None
                        and not item.get("promotionUrl")
                    )
                    outcomes.append(result("structured_grounding", sid, index, passed,
                                           item, "exact fixture ID/title/price/material/color; no link or dimensions"))

    def row_at(spec):
        rows = traces["turns"].get(spec["scenario"], [])
        return rows[spec["turn"] - 1] if spec["turn"] <= len(rows) else {}

    for spec in checks["memory"]:
        row = row_at(spec)
        actual = get_path(row.get("post_memory") or {}, spec["path"])
        outcomes.append(result("memory", spec["scenario"], spec["turn"],
                               isinstance(row.get("post_memory"), dict) and compare_value(actual, spec),
                               None if actual is MISSING else actual,
                               {key: spec[key] for key in ("path", "op", "value") if key in spec}))
    for spec in checks["cross_session"]:
        state = traces["boundaries"].get(spec["scenario"], {})
        actual = get_path(state, spec["path"])
        outcomes.append(result("cross_session", spec["scenario"], None,
                               spec["scenario"] in traces["boundaries"] and compare_value(actual, spec),
                               None if actual is MISSING else actual,
                               {key: spec[key] for key in ("path", "op", "value") if key in spec}))
        outcomes.append(result("session_isolation", spec["scenario"], None,
                               spec["scenario"] in traces["boundaries"] and state.get("current_items") == [],
                               state.get("current_items"), "new session has no current products"))
    for spec in checks["emotion_routing"]:
        response = row_at(spec).get("response") or {}
        if "mood" in spec:
            actual = (response.get("emotion") or {}).get("mood")
            outcomes.append(result("emotion_routing", spec["scenario"], spec["turn"],
                                   actual == spec["mood"], actual, {"mood": spec["mood"]}))
        actual = (response.get("policy") or {}).get("action")
        outcomes.append(result("emotion_routing", spec["scenario"], spec["turn"],
                               actual == spec["action"], actual, {"action": spec["action"]}))
    for spec in checks["search_delta"]:
        row = row_at(spec)
        calls = row.get("search_calls")
        delta = len(calls) if isinstance(calls, list) else None
        if spec["op"] == "zero":
            passed = delta == 0
        elif spec["op"] == "positive":
            passed = delta is not None and delta > 0
        else:
            raise ValueError(f"unsupported search delta check: {spec['op']}")
        outcomes.append(result(spec.get("metric", "followup_no_research"), spec["scenario"], spec["turn"],
                               passed, delta, spec["op"]))
    for spec in checks["fact_text"]:
        message = str((row_at(spec).get("response") or {}).get("message") or "")
        if spec["op"] == "unknown":
            passed = bool(UNKNOWN.search(message)) and any(word in message for word in spec["topic_any"])
            expected = {"unknown_marker": True, "topic_any": spec["topic_any"]}
        elif spec["op"] == "contains_all":
            passed = all(word in message for word in spec["values"])
            expected = {"contains_all": spec["values"]}
        else:
            raise ValueError(f"unsupported fact text check: {spec['op']}")
        outcomes.append(result("fact_text", spec["scenario"], spec["turn"],
                               passed, message, expected))
    counts = {}
    for metric in sorted({row["metric"] for row in outcomes}):
        selected = [row for row in outcomes if row["metric"] == metric]
        counts[metric] = {"passed": sum(row["pass"] for row in selected),
                          "failed": sum(not row["pass"] for row in selected),
                          "checked": len(selected)}
    return {"summary": {"scenario_count": len(traces["turns"]),
                        "turn_count": sum(map(len, traces["turns"].values())),
                        "metrics": counts,
                        "failed_checks": sum(not row["pass"] for row in outcomes)},
            "checks": outcomes}


@contextmanager
def without_remote_model():
    prior = os.environ.get("LLM_MODEL")
    os.environ["LLM_MODEL"] = ""
    try:
        yield
    finally:
        if prior is None:
            os.environ.pop("LLM_MODEL", None)
        else:
            os.environ["LLM_MODEL"] = prior


async def run_local_agent(scenarios: dict, checks: dict) -> dict:
    """Run every scenario with mock search and a fresh local agent per session."""
    framework = os.getenv("WIT_FRAMEWORK_PATH")
    if framework:
        sys.path.insert(0, framework)
    sys.path.insert(0, str(ROOT))
    try:
        from wit_agent.agent import ShoppingAgent, normalize_product
    except ImportError as exc:
        raise RuntimeError("Wit agent dependency missing; set WIT_FRAMEWORK_PATH and install wit_agent requirements") from exc

    fixture = {item["id"]: item for item in scenarios["catalog"]["products"]}
    mock_items = [fixture_to_agent_product(item, scenarios["catalog"]["source"])
                  for item in scenarios["catalog"]["products"]]
    traces = {"turns": {}, "boundaries": {}, "setup": {}}
    with tempfile.TemporaryDirectory(prefix="eval-run-", dir=HERE) as temp_dir:
        db_path = Path(temp_dir) / "memory.sqlite3"
        for scenario in scenarios["scenarios"]:
            sid = scenario["id"]
            user_id = f"eval-user-{sid}"
            rows = []
            calls = []

            async def mock_search(query, filters):
                calls.append({"query": query, "filters": copy.deepcopy(filters)})
                return {"ok": True, "items": copy.deepcopy(mock_items)}

            turns = scenario["turns"]
            session_numbers = sorted({turn.get("session", 1) for turn in turns})
            for session_number in session_numbers:
                session_id = f"eval-{sid}-session-{session_number}"
                with without_remote_model():
                    agent = ShoppingAgent(db_path, search=mock_search)
                if session_number == 1:
                    state = agent.memory.load(session_id, user_id)
                    state["preferences"] = copy.deepcopy(checks["seed_preferences"].get(sid, {}))
                    state["current_items"] = [normalize_product(fixture_to_agent_product(
                        fixture[pid], scenarios["catalog"]["source"]))
                        for pid in scenario["setup"]["visible_product_ids"]]
                    agent.memory.save(session_id, state, user_id)
                    seeded = agent.memory.load(session_id, user_id)
                    actual_items = seeded["current_items"]
                    expected_ids = scenario["setup"]["visible_product_ids"]
                    if [item["id"] for item in actual_items] != expected_ids or any(
                        item["facts"]["material"] != fixture[item["id"]]["material"]
                        or item["facts"]["color"] != fixture[item["id"]]["color"]
                        or item["price"] != fixture[item["id"]]["price_cny"]
                        for item in actual_items
                    ):
                        raise RuntimeError(f"visible product fixture injection failed: {sid}")
                    traces["setup"][sid] = {"session_id": session_id, "user_id": user_id,
                                            "memory": copy.deepcopy(seeded)}
                else:
                    traces["boundaries"][sid] = copy.deepcopy(agent.memory.load(session_id, user_id))
                async with agent:
                    for index, turn in enumerate(turns, 1):
                        if turn.get("session", 1) != session_number:
                            continue
                        before = len(calls)
                        pre_memory = agent.memory.load(session_id, user_id)
                        try:
                            response = await agent.chat(session_id, turn["user"], user_id=user_id)
                            error = None
                        except Exception as exc:
                            response = {}
                            error = f"{type(exc).__name__}: {exc}"
                        rows.append({"turn": index, "session": session_number,
                                     "session_id": session_id, "user_id": user_id,
                                     "user": turn["user"], "response": response,
                                     "search_calls": copy.deepcopy(calls[before:]),
                                     "pre_memory": pre_memory,
                                     "post_memory": agent.memory.load(session_id, user_id), "error": error})
            traces["turns"][sid] = rows
            del agent
            gc.collect()
        gc.collect()
    return traces


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=HERE / "reports" / "wit_full.json")
    parser.add_argument("--allow-fail", action="store_true",
                        help="write actual findings but exit 0 even when checks fail")
    args = parser.parse_args(argv)
    output = args.output.resolve()
    if not output.is_relative_to(HERE) or output.suffix.lower() != ".json":
        parser.error("--output must be a .json path inside evaluation/")
    try:
        scenarios, checks = load_inputs()
        traces = asyncio.run(run_local_agent(scenarios, checks))
        report = evaluate(scenarios, checks, traces)
    except (RuntimeError, ValueError, OSError) as exc:
        print(f"evaluation setup failed: {exc}", file=sys.stderr)
        return 2
    source_paths = [HERE / "scenarios.json", HERE / "machine_checks.json",
                    HERE / "run_regression.py",
                    ROOT / "wit_agent" / "agent.py", ROOT / "wit_agent" / "policy.py",
                    ROOT / "wit_agent" / "memory.py", ROOT / "wit_agent" / "llm.py"]
    report["metadata"] = {"adapter": "local_wit_agent", "search": "frozen_mock_catalog",
                          "identity_protocol": "one user_id per scenario; distinct session_id per segment",
                          "catalog_source": scenarios["catalog"]["source"],
                          "source_sha256": {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                                            for path in source_paths},
                          "human_satisfaction_measured": False,
                          "notes": "机器规则仅覆盖显式检查项；失败可能指实现或检查口径不匹配。跨会话使用不同 session_id 和相同 user_id；评测器不复制第二段状态。"}
    report["traces"] = traces
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(output), **report["summary"]}, ensure_ascii=False, indent=2))
    return 0 if args.allow_fail or report["summary"]["failed_checks"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
