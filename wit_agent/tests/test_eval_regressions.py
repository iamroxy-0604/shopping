"""User-facing regressions from the read-only full evaluation report."""

import asyncio

from wit_agent.agent import ShoppingAgent


def product(pid, title, price, *, material=None, color=None, dimensions=None, url=""):
    return {
        "id": pid, "title": title, "price": price, "promotionUrl": url,
        "facts": {"title": title, "price": price, "material": material,
                  "color": color, "dimensions": dimensions},
    }


def seed(agent, session, items, *, user=None, preferences=None):
    agent.memory.save(session, {"preferences": preferences or {}, "current_items": items}, user)


def run(coro):
    return asyncio.run(coro)


def test_emotion_and_search_boundaries(tmp_path):
    async def scenario():
        calls = []

        async def search(query, filters):
            calls.append(query)
            return {"ok": True, "items": [product("lamp", "原木桌面灯", 89)]}

        async with ShoppingAgent(tmp_path / "emotion.db", search) as agent:
            lamp = [product("lamp", "原木桌面灯", 89)]
            seed(agent, "e02", lamp)
            seed(agent, "s08", lamp)
            seed(agent, "p34", [product("box", "塑料收纳盒", 49)])
            seed(agent, "p33", [product("one", "桌面灯甲", 89), product("two", "桌面灯乙", 99)])
            cases = [
                ("e02", "这盏灯我先收藏，今天不买", "stop_selling", "explore"),
                ("e04", "累了，不想做选择，就想随手逛逛", "bored", "explore"),
                ("p33", "这两盏都不喜欢", "frustrated", "change_direction"),
                ("p34", "这个塑料收纳盒不喜欢", "frustrated", "change_direction"),
                ("s08", "先看这盏原木桌面灯", "search", "current_detail"),
                ("s09", "帮我找个桌上的东西", "explore", "clarify"),
            ]
            for session, message, mood, action in cases:
                result = await agent.chat(session, message)
                assert result["emotion"]["mood"] == mood, message
                assert result["policy"]["action"] == action, message
            assert calls == []
            assert agent.memory.load("e02")["feedback"][-1]["type"] == "saved"
            assert agent.memory.load("s08")["preferences"] == {}

    run(scenario())


def test_current_comparisons_do_not_research(tmp_path):
    async def scenario():
        calls = []

        async def search(query, filters):
            calls.append(query)
            return {"ok": True, "items": []}

        async with ShoppingAgent(tmp_path / "compare.db", search) as agent:
            seed(agent, "c13", [product("a", "原木桌面灯甲", 89, material="木、玻璃"), product("b", "黑色金属桌面灯乙", 139, material="金属")])
            first = await agent.chat("c13", "这两盏灯哪个便宜？")
            assert first["type"] == "comparison" and "89" in first["message"] and "139" in first["message"]
            second = await agent.chat("c13", "便宜的是什么材质？")
            assert "木、玻璃" in second["message"]
            seed(agent, "c16", [product("white", "白色收纳盒", 39, material="塑料"), product("bamboo", "竹制收纳盒", 59, material="竹")])
            comparison = await agent.chat("c16", "左边这个白色收纳盒和竹制的怎么选？")
            assert comparison["policy"]["action"] == "compare_current"
            assert "塑料" in comparison["message"] and "竹" in comparison["message"]
            followup = await agent.chat("c16", "我更喜欢后者的材质。")
            assert followup["policy"]["action"] == "current_detail"
            seed(agent, "c17", [product("cup1", "玻璃杯", 49), product("cup2", "陶瓷杯", 69)])
            cups = await agent.chat("c17", "这两个杯子哪个便宜？")
            assert "49" in cups["message"] and "69" in cups["message"]
            seed(agent, "small-home", [product("t1", "日式餐桌甲", 899), product("t2", "日式餐桌乙", 999), product("t3", "日式餐桌丙", 1099)])
            small_home = await agent.chat("small-home", "这三款哪一款更适合小户型？")
            assert small_home["policy"]["action"] == "compare_current"
            assert "缺少可核对的尺寸" in small_home["message"]
            reference = await agent.chat("c17", "知道了，我现在只是做搭配参考。")
            assert reference["policy"]["action"] == "explore"
            assert calls == []

    run(scenario())


def test_explicit_dislike_excludes_matching_later_product(tmp_path):
    async def scenario():
        async def search(query, filters):
            return {"ok": True, "items": [
                product("black", "黑色金属桌面灯", 89),
                product("wood", "原木桌面灯", 99),
            ]}

        async with ShoppingAgent(tmp_path / "dislikes.db", search) as agent:
            await agent.chat("first", "我不喜欢黑色金属感。", user_id="same")
            result = await agent.chat("second", "找桌面灯", user_id="same")
            assert [item["id"] for item in result["items"]] == ["wood"]

    run(scenario())


def test_fact_questions_use_only_current_product_evidence(tmp_path):
    async def scenario():
        async def no_search(query, filters):
            raise AssertionError(f"unexpected search: {query}")

        async with ShoppingAgent(tmp_path / "facts.db", no_search) as agent:
            seed(agent, "f27", [product("lamp", "原木桌面灯甲", 89, material="木、玻璃", color="米白、木色")])
            seed(agent, "f28", [product("white", "米白桌面灯丙", 99, color="米白")])
            seed(agent, "f30", [product("black", "黑色金属桌面灯乙", 139, material="金属", color="黑色")])
            seed(agent, "f31", [product("bamboo", "竹制桌面收纳盒乙", 59, material="竹", color="原竹色")])
            seed(agent, "f32", [product("steel", "不锈钢杯乙", 69, material="不锈钢")])
            pairs = [
                ("f27", "这盏灯现在有现货吗？", ("现货", "未知")),
                ("f27", "那价格是多少？", ("89",)),
                ("f28", "米白这盏是什么材质？", ("材质未知",)),
                ("f28", "那它颜色和价格确定吗？", ("米白", "99")),
                ("f27", "为什么你觉得这盏灯适合原木风桌面？", ("木、玻璃", "风格判断")),
                ("f27", "它的尺寸是多少？", ("尺寸未知",)),
                ("f30", "这盏灯今天会降价吗？", ("降价", "未知")),
                ("f30", "那夹具里标价多少？", ("139",)),
                ("f31", "你说它有原木感，依据是什么？", ("竹", "观感描述")),
                ("f31", "有商品来源链接吗？", ("来源链接未知",)),
                ("f32", "这个不锈钢杯保温多久？", ("保温时长未知",)),
                ("f32", "至少材质和价格知道吗？", ("不锈钢", "69")),
            ]
            for session, question, expected in pairs:
                result = await agent.chat(session, question)
                assert result["type"] == "comparison", question
                assert all(fragment in result["message"] for fragment in expected), question

    run(scenario())


def test_negative_forget_and_temporary_user_budget(tmp_path):
    async def scenario():
        async def search(query, filters):
            return {"ok": True, "items": [product("lamp", "桌面灯", 139)]}

        async with ShoppingAgent(tmp_path / "memory.db", search) as agent:
            seed(agent, "m20", [], user="u20", preferences={"category": "桌面灯"})
            negative = await agent.chat("m20", "我不喜欢黑色金属感。", user_id="u20")
            assert "黑色金属" in " ".join(negative["memory"]["preferences"]["dislikes"])
            seed(agent, "m22", [], user="u22", preferences={"category": "桌面灯", "maxPrice": 100})
            temporary = await agent.chat("m22", "这次买灯可以到150元。", user_id="u22")
            assert temporary["memory"]["preferences"]["maxPrice"] == 150
            assert agent.memory.load("m22", "u22")["preferences"]["maxPrice"] == 100
            assert agent.memory.load("fresh", "u22")["preferences"]["maxPrice"] == 100
            regular = await agent.chat("m22", "下次再找桌面灯时，按我平常预算来。", user_id="u22")
            assert regular["memory"]["preferences"]["maxPrice"] == 100
            assert agent.memory.load("m22", "u22")["temporary"] == {}
            seed(agent, "m23", [], user="u23", preferences={"style": "原木", "category": "桌面灯"})
            forgotten_style = await agent.chat("m23", "忘掉我喜欢原木风这件事。", user_id="u23")
            assert "style" not in forgotten_style["memory"]["preferences"]
            seed(agent, "m24", [], user="u24", preferences={"style": "日系", "maxPrice": 100})
            forgotten_all = await agent.chat("m24", "把之前记住的购物偏好都忘掉。", user_id="u24")
            assert forgotten_all["memory"]["preferences"] == {"memoryTags": []}
            assert agent.memory.load("other", "u24")["preferences"] == {}

    run(scenario())
