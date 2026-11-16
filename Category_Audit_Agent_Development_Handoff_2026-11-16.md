# 品类审核智能体开发与主智能体接入文档

更新时间：2026-11-16  
适用项目：购物智能体 2  
目标读者：接手实现品类审核智能体并完成主智能体联调的开发者

## 1. 开发基线

当前本机运行版本在编写本文档前已经备份到 GitHub。

- GitHub 仓库：`https://github.com/iamroxy-0604/shopping.git`
- 备份分支：`codex/current-agent-backup-20261116`
- 备份提交：`9d2a038`
- 备份范围：`backend/`、`wit_agent/` 中的运行代码与测试
- 未纳入备份：`.env`、日志、SQLite 数据库、缓存、截图、临时目录和原型产物

接手时执行：

```powershell
git fetch origin
git switch codex/current-agent-backup-20261116
git show --stat 9d2a038
```

> 备份时原开发分支 `codex/dingdang-desktop-shopping` 已经存在新的远程提交。后续如需合并回原分支，应先比较分支差异并正常合并，不要强推覆盖。

## 2. 本次开发目标

新增一个独立的 `CategoryAuditAgent`，并把它接入现有 `ShoppingAgent`。

该智能体在一次购物流程中执行两次：

1. **搜索前规划**：接收 Wit 问卷产生的本轮关键词，生成多组正向搜索词，并读取或首次生成当前品类的 `excludeTerms`。
2. **搜索后审核**：接收 `product-source` 返回的候选商品，结合目标品类和 `excludeTerms`，判断商品本体是否属于用户想买的品类。

唯一可以跨用户、跨会话继承的内容是：

```text
excludeTerms
```

不得跨用户继承：

- 搜索词排列
- 问卷答案
- 使用场景
- 风格和材质
- 预算
- 商品结果
- 排序结果

## 3. MVP 范围

### 3.1 必须实现

- 新增独立的 `CategoryAuditAgent`。
- 提供 `plan_search()` 和 `audit_products()` 两个操作。
- 使用 SQLite 保存共享的品类排除词记忆。
- 每次根据本轮 Wit 问卷重新生成搜索词。
- 已经出现过的品类直接读取历史 `excludeTerms`。
- 新品类首次出现时，由 LLM 生成 `excludeTerms` 并写入记忆。
- 淘宝和悦买返回的商品都必须经过最终审核。
- 只有审核通过的商品才能进入现有商品排序与推荐文案模块。
- 审核后不足 3 件时，使用下一组本轮搜索词继续检索。
- 最多检索 3 轮；仍不足时允许少于 3 件，不能用错误商品补齐。

### 3.2 本期不做

- 不引入 MCP。
- 不引入 Skills。
- 不使用向量数据库。
- 不拆成单独部署的微服务。
- 不自动修改系统 Prompt。
- 不因为一次审核失败就永久追加新的排除词。
- 不保存搜索模板或历史搜索词。
- 不修改淘宝、悦买鉴权和签名方式。

## 4. 当前系统架构

当前主链路如下：

```text
前端
  -> Node POST /api/chat 或 /api/chat/stream
  -> backend/src/wit-bridge.mjs
  -> Python POST /internal/wit/chat
  -> wit_agent/agent.py 中的 ShoppingAgent
  -> Node POST /api/products/search
  -> backend/src/product-source.mjs
  -> 淘宝 / 悦买
  -> ShoppingAgent 当前筛选与排序
  -> Node
  -> 前端商品卡片
```

### 4.1 现有模块职责

| 模块 | 当前职责 | 本次调整 |
|---|---|---|
| `backend/src/server.mjs` | 公开 API、Wit 桥接、商品搜索入口 | 不新增公开审核接口 |
| `backend/src/wit-bridge.mjs` | 把 Node 对话请求转发给本机 Wit sidecar | 原则上不改 |
| `backend/src/product-source.mjs` | 调用淘宝、悦买，统一商品来源和 ID | 继续只做检索，不放 LLM |
| `wit_agent/agent.py` | 问卷、搜索循环、筛选、排序和回复生成 | 品类审核智能体的主要接入点 |
| `wit_agent/llm.py` | `interpret`、问卷、`search_plan`、`product_plan` 等模型调用 | 新增排除词生成和商品本体审核 |
| `wit_agent/memory.py` | 用户与会话级 SQLite 记忆 | 新增独立共享品类排除词表 |

## 5. 当前问题原因

当前 `wit_agent/agent.py` 中的 `select_products()` 主要根据标题是否包含目标品类词判断品类匹配。

因此：

```text
目标品类：裙子
商品标题：法式小皮鞋女配裙子
```

会因为标题包含“裙子”而被当成裙子候选。

后面的 `product_plan()` 虽然提示模型避免配件，但它不是独立的品类准入边界。并且当模型选出的商品不足时，当前补齐逻辑可能再次从 `select_products()` 的候选中加入错误商品。

本次改造必须保证：

```text
商品本体审核位于 product_plan 之前
```

所有商品来源、悦买 anchor 和商品补齐路径都不得绕过该审核。

## 6. 目标架构

```text
用户输入
  -> Wit 需求理解
  -> Wit 问卷
  -> 形成当前会话 RequirementSnapshot
  -> CategoryAuditAgent.plan_search()
       -> 根据本轮问卷重新生成 queries
       -> 按 targetCategory 查询共享 excludeTerms
       -> 未命中时由 LLM 生成 excludeTerms
       -> 只保存 excludeTerms
  -> 对每个 query 调用 product-source
  -> 商品标准化、去重、预算等基础过滤
  -> 使用 excludeTerms 对标题进行快速标记或初筛
  -> CategoryAuditAgent.audit_products()
  -> 累积 accepted 商品
       -> 不足 3 件：使用下一 query
       -> 达到 3 件：停止搜索
  -> 现有 product_plan 排序
  -> 现有 recommendation_plan 生成推荐说明
  -> 保存 current_items
  -> 返回前端
```

## 7. 模块职责

### 7.1 Wit 问卷

Wit 问卷负责回答：

> 用户这次想买什么，以及这次有哪些偏好？

示例：

```json
{
  "category": "裙子",
  "answers": {
    "scene": "日常通勤",
    "priority": "版型显瘦",
    "detail": "长裙飘逸",
    "budget": null
  }
}
```

问卷不负责保存公共品类规则，也不直接判断商品本体。

### 7.2 CategoryAuditAgent 搜索前阶段

`plan_search()` 负责：

1. 接收当前问卷和目标品类。
2. 根据本轮条件重新生成 2 至 4 组正向搜索词。
3. 查询该品类是否已有 `excludeTerms`。
4. 有记忆时直接读取 `excludeTerms`。
5. 无记忆时调用 LLM 生成 `excludeTerms`，校验后写入 SQLite。
6. 返回本轮搜索计划。

它不保存本轮搜索词，也不继承上一位用户的搜索词。

### 7.3 product-source

`product-source` 继续负责：

- 调用淘宝。
- 调用悦买。
- 统一商品 ID 和来源字段。
- 合并多来源商品。
- 单一商品源失败时保留其他来源结果。

因为淘宝、悦买不一定支持负关键词，所以只把正向 `query` 传给商品源。

以下内容不能拼入外部搜索请求：

```text
-鞋
-保护套
-配裙子
```

`excludeTerms` 应在商品返回后由 Wit 侧使用。

### 7.4 CategoryAuditAgent 搜索后阶段

`audit_products()` 负责回答：

> 这件商品实际销售的主体，是否属于用户要求的目标品类？

它必须区分：

```text
充电宝保护套     -> 商品本体是保护套，reject
充电宝赠保护套   -> 商品本体可能是充电宝，按本体判断

法式小皮鞋配裙子 -> 商品本体是鞋，reject
法式通勤长裙     -> 商品本体是裙子，accept
```

### 7.5 现有排序与推荐模块

现有 `product_plan()` 只负责从已经通过品类审核的商品中选择最符合问卷需求的商品。

它不再承担品类准入职责。

正确顺序：

```text
搜索 -> 品类审核 -> 排序 -> 推荐说明
```

## 8. 数据契约

### 8.1 RequirementSnapshot

由当前 Wit 会话生成。

```json
{
  "targetCategory": "裙子",
  "goal": "购买适合通勤穿的裙子",
  "preferences": {
    "scene": "通勤",
    "style": "显瘦",
    "length": "长裙",
    "maxPrice": null
  },
  "answers": [
    {"id": "scene", "value": "日常通勤"},
    {"id": "priority", "value": "版型显瘦"},
    {"id": "detail", "value": "长裙飘逸"}
  ]
}
```

### 8.2 AuditSearchPlan

`CategoryAuditAgent.plan_search()` 的返回值。

```json
{
  "targetCategory": "裙子",
  "queries": [
    "通勤显瘦长裙",
    "女士通勤裙子长款",
    "显瘦连衣裙通勤"
  ],
  "excludeTerms": [
    "配裙子",
    "搭裙子",
    "裙子搭配",
    "裙子同款鞋"
  ],
  "excludeTermsSource": "memory"
}
```

规则：

- `queries` 每次根据当前 `RequirementSnapshot` 重新生成。
- `excludeTerms` 可以来自历史共享记忆。
- `excludeTermsSource` 仅允许 `memory` 或 `generated`。
- `excludeTermsSource` 用于日志和测试，不发送给商品接口。

### 8.3 ProductAuditRequest

```json
{
  "targetCategory": "裙子",
  "excludeTerms": [
    "配裙子",
    "搭裙子",
    "裙子搭配"
  ],
  "products": [
    {
      "id": "taobao:001",
      "title": "法式通勤显瘦长裙",
      "source": "taobao",
      "price": 159
    },
    {
      "id": "taobao:002",
      "title": "法式小皮鞋女配裙子",
      "source": "taobao",
      "price": 129
    }
  ]
}
```

### 8.4 ProductAuditResult

```json
{
  "accepted": [
    {
      "id": "taobao:001",
      "primaryCategory": "裙子",
      "confidence": 0.98
    }
  ],
  "rejected": [
    {
      "id": "taobao:002",
      "primaryCategory": "女鞋",
      "reason": "商品本体是鞋，裙子只是搭配对象",
      "confidence": 0.97
    }
  ],
  "uncertain": []
}
```

MVP 中：

- 只有 `accepted` 能进入排序和前端展示。
- `rejected` 不展示。
- `uncertain` 不展示，也不能用于补齐。

## 9. 排除词共享记忆

### 9.1 记忆边界

共享记忆只保存：

```json
{
  "category": "裙子",
  "excludeTerms": [
    "配裙子",
    "搭裙子",
    "裙子搭配",
    "裙子同款鞋"
  ]
}
```

不能保存：

- `queries`
- `preferences`
- `answers`
- `scene`
- `style`
- `budget`
- `products`

### 9.2 SQLite 表

建议在现有 `wit_agent/data/memory.sqlite3` 中新增独立表：

```sql
CREATE TABLE IF NOT EXISTS category_exclusions (
  category_key TEXT PRIMARY KEY,
  exclude_terms_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

该表不绑定 `user_id` 或 `session_id`。

### 9.3 MemoryManager 新增方法

建议增加：

```python
def get_category_exclusions(self, category_key: str) -> list[str] | None:
    ...

def save_category_exclusions(
    self,
    category_key: str,
    exclude_terms: list[str],
) -> None:
    ...
```

不要把共享排除词塞进现有 `chat_sessions.data` JSON。

### 9.4 读取逻辑

```text
当前 targetCategory
  -> 最小标准化为 category_key
  -> 查询 category_exclusions
       -> 命中：直接返回 excludeTerms
       -> 未命中：调用 LLM 生成
                    -> 校验
                    -> 保存 excludeTerms
                    -> 返回
```

`category_key` 可以复用项目已有的明确同义词归一化，例如：

```text
胭脂 -> 腮红
日式 -> 日系
```

品类归一化只用于找到同一品类的排除词，不代表可以继承任何搜索条件。

### 9.5 排除词校验

MVP 建议规则：

- 必须是字符串数组。
- 建议 3 至 12 项。
- 每项 2 至 20 个汉字。
- 去除空白和重复项。
- 禁止 URL、脚本和完整商品标题。
- 禁止保存用户隐私数据。
- 不允许混入场景、风格和预算。
- 未生成有效排除词时不要写入空记忆。

### 9.6 用户清除记忆的行为

用户的“忘记偏好”或“清除全部记忆”只清除用户和会话级记忆，不删除共享 `category_exclusions`。

如果以后需要维护共享排除词，应单独提供管理操作，不与普通用户的记忆操作混用。

## 10. CategoryAuditAgent 最小接口

建议新增：

```text
wit_agent/category_audit.py
```

最小结构：

```python
class CategoryAuditAgent:
    def __init__(self, memory: MemoryManager, model):
        self.memory = memory
        self.model = model

    async def plan_search(
        self,
        invocation,
        requirement: dict,
    ) -> dict:
        ...

    async def audit_products(
        self,
        invocation,
        target_category: str,
        exclude_terms: list[str],
        products: list[dict],
    ) -> dict:
        ...
```

### 10.1 plan_search 处理顺序

1. 读取当前 `targetCategory`、`preferences`、`answers` 和 `goal`。
2. 根据当前数据生成 2 至 4 个正向 `queries`。
3. 每个 query 必须包含目标品类或允许的明确同义词。
4. 查询 `category_exclusions`。
5. 命中时直接读取 `excludeTerms`。
6. 未命中时调用 LLM 生成 `excludeTerms`。
7. 校验并保存有效 `excludeTerms`。
8. 返回 `AuditSearchPlan`。

### 10.2 audit_products 处理顺序

1. 接收一批已经标准化的候选商品，建议每批最多 20 件。
2. 只向模型传递商品 ID、标题、来源、价格，以及接口真实提供的类目或描述摘要。
3. 检查标题是否命中 `excludeTerms`。
4. 将命中的排除词作为审核信号传给模型。
5. 让模型判断商品的 `primaryCategory`。
6. 输出 `accept`、`reject` 或 `uncertain`。
7. 严格验证所有返回 ID 都来自输入候选。
8. 未知 ID、重复 ID、字段缺失商品均不能进入 `accepted`。

## 11. 排除词本地过滤策略

由于外部商品接口不支持负关键词，商品返回后再处理 `excludeTerms`。

推荐的 MVP 默认策略是：

```text
命中 excludeTerms
  -> 标记 exclusionMatched=true
  -> 记录 matchedTerms
  -> 交给 audit_products 最终判断
```

示例：

```json
{
  "id": "taobao:002",
  "title": "法式小皮鞋女配裙子",
  "exclusionMatched": true,
  "matchedTerms": ["配裙子"]
}
```

这样可以避免纯字符串过滤误杀：

```text
充电宝保护套     -> 应拒绝
充电宝赠保护套   -> 可能仍是充电宝本体
```

如果开发者选择对非常明确的完整短语直接过滤，也必须保证其他候选仍经过最终审核，并为误杀场景增加测试。

## 12. 搜索重试流程

```python
accepted_by_id = {}

for query in audit_plan["queries"][:3]:
    payload = await product_api_search(query, filters)
    candidates = normalize_and_basic_filter(payload)
    candidates = deduplicate(candidates, accepted_by_id)

    result = await category_auditor.audit_products(
        invocation,
        audit_plan["targetCategory"],
        audit_plan["excludeTerms"],
        candidates,
    )

    for item in result["accepted"]:
        accepted_by_id[item["id"]] = merge_original_product(item)

    if len(accepted_by_id) >= 3:
        break
```

完成搜索后：

```text
accepted_by_id
  -> 现有 product_plan
  -> 最多选择 3 件
```

三轮后：

- 3 件以上：排序后取最多 3 件。
- 1 至 2 件：只展示合格的 1 至 2 件。
- 0 件：告诉用户暂时没有找到可靠匹配。

禁止从 `rejected`、`uncertain` 或未审核的原始候选中补齐。

## 13. 与现有代码的具体接入点

### 13.1 `wit_agent/llm.py`

建议新增：

```python
async def generate_exclude_terms(
    model,
    invocation,
    target_category: str,
) -> list[str]:
    ...

async def audit_product_categories(
    model,
    invocation,
    target_category: str,
    exclude_terms: list[str],
    products: list[dict],
) -> dict:
    ...
```

现有 `search_plan()` 可以复用或重构进 `CategoryAuditAgent.plan_search()`，但必须保留以下原则：

- 查询词按本轮问卷生成。
- 查询词必须保留核心品类。
- 查询词不得来自历史共享记忆。

### 13.2 `wit_agent/memory.py`

改动：

- 初始化 `category_exclusions` 表。
- 增加共享排除词的读取和保存方法。
- 保持现有 `users` 和 `chat_sessions` 行为不变。
- `forget()` 不删除共享排除词。

### 13.3 `wit_agent/agent.py`

当前搜索阶段大致执行：

```text
search_plan
  -> product_api_search
  -> select_products
  -> product_plan
  -> select_products 补齐
```

应调整为：

```text
CategoryAuditAgent.plan_search
  -> product_api_search
  -> normalize_product
  -> 基础过滤和去重
  -> CategoryAuditAgent.audit_products
  -> 累积 accepted
  -> product_plan
  -> 只能从 accepted 池补齐
```

建议把 `select_products()` 的职责缩小为：

- 预算过滤
- 风格证据判断
- 重复商品处理
- 基础字段质量判断

它不再拥有最终品类准入权。

可以重命名为：

```python
basic_filter_products()
```

### 13.4 `backend/src/product-source.mjs`

MVP 原则上不需要修改业务逻辑。

它继续接收：

```json
{
  "query": "通勤显瘦长裙",
  "filters": {
    "end_price": 300
  },
  "source": "taobao"
}
```

它不接收 `excludeTerms`，也不调用 LLM。

### 13.5 `backend/src/server.mjs`

不需要新增公开的品类审核接口。

保持：

- `/api/chat`
- `/api/chat/stream`
- `/api/products/search`
- `/internal/wit/chat`

CategoryAuditAgent 作为 Wit 内部模块运行。

### 13.6 淘宝、悦买和悦买 anchor

当前流程中：

- 淘宝商品通常标记为 `refined_preferences`。
- 悦买可能按首次品类生成 `initial_request` anchor。

两类商品都必须经过 `audit_products()`。

正确顺序：

```text
召回商品
  -> 最终品类审核
  -> 审核通过
  -> 再设置 selectionScope 和 matchPolicy
```

悦买 anchor 不能因为是首次需求匹配而绕过审核。

### 13.7 `product_plan()` 与补齐逻辑

`product_plan()` 只接收审核通过的商品。

如果模型只选择 1 至 2 件，可以从 `accepted` 商品池按现有基础分数补齐。

禁止从以下集合补齐：

- 原始 `candidates`
- `rejected`
- `uncertain`
- 只通过旧 `select_products()` 的商品

## 14. LLM Prompt 约束

### 14.1 首次生成 excludeTerms

目标：只生成当前品类容易混入的关联商品词组。

Prompt 必须要求：

- 只输出 JSON。
- 只输出 `excludeTerms`。
- 不生成搜索词。
- 不读取或复用用户偏好。
- 不输出品牌、预算和风格。
- 排除词应描述配件、保护物、搭配物或关联商品。

示例：

```json
输入：
{
  "targetCategory": "裙子"
}

输出：
{
  "excludeTerms": [
    "配裙子",
    "搭裙子",
    "裙子搭配",
    "裙子同款鞋"
  ]
}
```

### 14.2 最终商品审核

Prompt 必须强调：

- 判断主要售卖对象。
- 不能因为标题中出现目标品类词就判定通过。
- 配件、保护套、搭配商品和关联用品通常不是目标商品本体。
- 商品本体正确但赠送配件时，仍按商品本体判断。
- 只能返回输入商品 ID。
- 证据不足时返回 `uncertain`。
- 不生成商品事实。

## 15. 降级和异常处理

| 失败点 | 降级行为 |
|---|---|
| 本轮查询词生成失败 | 使用现有 `search_plan()` 的有效结果；仍失败则使用包含目标品类的基础 query |
| 排除词记忆未命中且 LLM 生成失败 | 本轮 `excludeTerms=[]`，仍执行最终商品审核；不写空记忆 |
| 最终审核超时 | 本批商品全部按 `uncertain` 处理，继续下一 query |
| 最终审核 JSON 非法 | 本批商品全部按 `uncertain` 处理，继续下一 query |
| 淘宝或悦买单源失败 | 沿用现有单源降级；存活来源的商品仍必须审核 |
| 三轮后不足 3 件 | 返回实际合格数量，不使用错误商品补齐 |
| 三轮后 0 件 | 返回明确的“暂未找到可靠匹配”提示 |

## 16. 日志和可观测性

建议增加以下结构化事件：

### `category_audit_plan`

```json
{
  "sessionId": "...",
  "category": "裙子",
  "queryCount": 3,
  "excludeTermCount": 4,
  "excludeTermsSource": "memory"
}
```

### `category_audit_batch`

```json
{
  "sessionId": "...",
  "category": "裙子",
  "query": "通勤显瘦长裙",
  "candidateCount": 20,
  "acceptedCount": 2,
  "rejectedCount": 15,
  "uncertainCount": 3
}
```

### `category_audit_retry`

```json
{
  "sessionId": "...",
  "category": "裙子",
  "acceptedTotal": 1,
  "nextQueryIndex": 1
}
```

日志中禁止记录：

- LLM API Key
- 淘宝和悦买密钥
- 完整用户身份信息
- 未脱敏的隐私数据

## 17. 测试计划

### 17.1 排除词记忆测试

1. 第一次请求“裙子”：
   - SQLite 未命中。
   - 调用 LLM 生成 `excludeTerms`。
   - 写入 `category_exclusions`。

2. 第二次请求“裙子”：
   - 直接读取相同 `excludeTerms`。
   - 不调用排除词生成 LLM。
   - 根据第二次问卷重新生成不同的 `queries`。

3. 用户清除个人偏好：
   - `chat_sessions` 对应数据被清理。
   - `category_exclusions` 仍然存在。

### 17.2 商品本体审核测试

| 目标品类 | 商品标题 | 预期 |
|---|---|---|
| 裙子 | 法式小皮鞋女配裙子 | `reject`，本体为女鞋 |
| 裙子 | 法式通勤显瘦长裙 | `accept` |
| 充电宝 | 充电宝保护套 | `reject` |
| 充电宝 | 充电宝赠保护套 | `accept`，前提是本体确为充电宝 |
| 餐桌 | 防水餐桌布 | `reject` |
| 餐桌 | 小户型实木餐桌 | `accept` |
| 台灯 | 台灯灯罩配件 | `reject` |
| 台灯 | 阅读护眼桌面台灯 | `accept` |

### 17.3 输出安全测试

- 模型返回未知商品 ID：未知 ID 被丢弃。
- 模型返回重复 ID：去重。
- 模型遗漏候选：遗漏商品不能默认通过。
- 模型返回非法 `decision`：按 `uncertain` 处理。
- 模型没有返回 `primaryCategory`：不得进入 `accepted`。

### 17.4 搜索循环集成测试

- 第一轮通过 1 件、第二轮通过 2 件，最终返回 3 件。
- 第一轮已经通过 3 件，不执行第二轮。
- 三轮总共只通过 2 件，最终只返回 2 件。
- 三轮 0 件，不从原始候选补齐。
- 淘宝和悦买商品均经过审核。
- 悦买 anchor 经过审核。
- `product_plan()` 的输入中不存在 rejected ID。

### 17.5 回归测试

必须保证以下现有功能继续工作：

- Wit 问卷逐题展示。
- 问卷答案写入当前会话。
- 用户偏好记忆。
- 新会话不沿用上一轮商品。
- 淘宝和悦买单源失败降级。
- 桌面端商品卡片字段。
- 推荐文案失败后的现有处理。
- 内容推荐和链接转接不受影响。

## 18. 建议测试命令

Node 测试：

```powershell
cd backend
npm test
```

Python 测试：

```powershell
cd ..
$env:PYTHONPATH="D:\chrome download\wit-main\wit-main;$PWD"
.venv\Scripts\python.exe -m pytest wit_agent/tests -q
```

启动完整系统：

```powershell
cd backend
npm run start:wit
```

健康检查：

```text
http://127.0.0.1:3000/health
http://127.0.0.1:8765/health
```

## 19. 验收标准

满足以下全部条件才算完成：

- 搜索“裙子”时，“配裙子的鞋”不会出现在最终商品卡。
- 搜索“充电宝”时，“充电宝保护套”不会作为充电宝推荐。
- 同一品类第二次出现时，日志显示 `excludeTermsSource=memory`。
- 同一品类第二次出现时，不调用排除词生成 LLM。
- 同一品类使用不同问卷答案时，会得到不同的本轮 `queries`。
- 共享记忆中只有 `excludeTerms`，没有历史搜索词和问卷答案。
- 淘宝商品、悦买商品和悦买 anchor 都经过最终审核。
- 只有 `accepted` 商品进入 `product_plan()`。
- 审核不足时允许少于 3 件，绝不使用错误商品补齐。
- 审核服务失败时采取保守策略，不把未审核商品展示给用户。
- Node 和 Python 现有测试及新增测试全部通过。

## 20. 推荐开发顺序

1. 切换到备份分支并运行现有测试，建立基线。
2. 在 `memory.py` 新增 `category_exclusions` 表和读写测试。
3. 在 `llm.py` 新增排除词生成函数及严格校验。
4. 在 `llm.py` 新增最终商品本体审核函数及严格校验。
5. 新建 `category_audit.py`，实现 `plan_search()` 和 `audit_products()`。
6. 修改 `agent.py` 的搜索循环，接入搜索前规划。
7. 在每次商品召回后接入最终审核。
8. 删除或改造所有从未审核候选补齐商品的路径。
9. 确保淘宝、悦买和悦买 anchor 使用同一审核入口。
10. 增加结构化日志。
11. 完成单元测试和集成测试。
12. 更新 `backend/README.md` 与 `wit_agent/README.md`。

## 21. 交接检查清单

- [ ] 当前分支包含备份提交 `9d2a038`。
- [ ] 未提交 `.env`、日志、SQLite 数据库或商品源密钥。
- [ ] `category_exclusions` 只存 `category_key` 和 `excludeTerms`。
- [ ] `queries` 每次根据本轮问卷生成。
- [ ] `product-source` 仍然只是商品源适配层。
- [ ] 所有来源商品进入统一的 `audit_products()`。
- [ ] 最终审核失败时采取保守拒绝。
- [ ] rejected 和 uncertain 商品不会进入排序。
- [ ] 任何补齐逻辑都只使用 accepted 商品池。
- [ ] 日志能够区分记忆命中、首次生成、批次审核和重试。
- [ ] README 已更新。
- [ ] 新增和现有测试全部通过。

## 22. 最终架构摘要

```text
主购物智能体 ShoppingAgent
  |
  |-- Wit 需求理解与问卷
  |
  |-- CategoryAuditAgent.plan_search
  |     |-- 本轮生成 queries
  |     |-- 查询共享 excludeTerms
  |     `-- 新品类首次生成并保存 excludeTerms
  |
  |-- product-source
  |     |-- 淘宝
  |     `-- 悦买
  |
  |-- CategoryAuditAgent.audit_products
  |     |-- accepted
  |     |-- rejected
  |     `-- uncertain
  |
  |-- product_plan
  |
  |-- recommendation_plan
  |
  `-- 前端展示
```

这个 MVP 构成一个明确的多智能体协作项目：

- `ShoppingAgent` 负责对话、问卷、流程编排、排序和推荐。
- `CategoryAuditAgent` 负责搜索前的品类安全规划，以及搜索后的商品本体审核。
- `product-source` 仍是工具层，不是智能体。
- SQLite `category_exclusions` 是品类审核智能体的共享长期记忆，并且只继承 `excludeTerms`。
