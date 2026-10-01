# 购物智能体评测包

本目录包含评测场景、评分模板和本地 agent 的实际机器回归记录；没有人类满意度数据或效果提升结论。依据仓库根目录的《导师要求下的购物智能体研究实施方案.md》第五至七节和《购物智能体_Wit3迭代任务图.md》的 P2.1、P2.2、P3.2、P4.1 编写。

## 文件

- `scenarios.json`：36 个中文多轮场景、逐轮期望状态/策略/行为、8 个冻结的合成商品夹具。
- `score_sheet_template.csv`：A/B/C/D 的空白人工评分行；复制为每个场景 × 组别 × 评审员各一行。
- `rubric.md`：运行控制、人工打分锚点、硬性失败和汇总口径。
- `machine_checks.json`：可自动核验的定点断言；只编码客观状态、调用与夹具字段。
- `run_regression.py`：离线调用本地 Wit agent，并注入固定商品搜索，输出逐轮证据与机器指标。
- `test_regression.py`：评测脚本自身的单元测试。

## 使用

1. 固定同一模型版本、提示词以外的生成参数、商品夹具及场景顺序；四组仅按 `rubric.md` 的模块开关变化。每个场景从独立测试用户开始。
2. 按 `turns` 顺序发送 `user` 文本。`session` 未写时默认为 1；数字增大时开启新会话并清空聊天上下文。只有启用记忆的组可从记忆存储恢复显式偏好。`setup.memory` 仅注入启用记忆的组；`visible_product_ids` 按数组顺序展示给系统，表示当前可比较商品。
3. 商品仅来自 `catalog.products`。`source=synthetic_eval_fixture` 表示人工编写的固定样本；`null` 是未知，不可补写。真实商品链路可另做外部有效性检查，不与本表混算。
4. `expect` 是隐藏评分金标，不送入被测系统。`mood`、`intent`、`purchase_intent`、`policy` 为本轮主要标签；`must` 与 `forbid` 为可观察判据。它们不是唯一合格措辞，评审按语义判定。
5. 保存每轮系统回复、商品 ID、状态/策略日志（若可用）及记忆快照。按 `rubric.md` 填 CSV；无可观察证据不能按成功计。

快速结构检查：`python -m json.tool evaluation/scenarios.json`。这一步不运行 agent，也不产生实测分数。

## 离线自动回归

从仓库根目录运行。需要项目虚拟环境及本地 Wit 3.0 源码；脚本会禁用远程 LLM，并把搜索替换为 8 个固定商品，因此不需要淘宝客或网络。下面的 Wit 路径仅为示例，请换成自己的安装路径。

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
$env:WIT_FRAMEWORK_PATH='D:\chrome download\wit-main\wit-main'
.venv\Scripts\python.exe -m unittest evaluation.test_regression -v
.venv\Scripts\python.exe evaluation\run_regression.py --allow-fail
```

报告写入 `evaluation/reports/wit_full.json`，含每轮输入、回复、搜索调用、记忆快照、每条断言及代码/夹具文件 SHA-256。去掉 `--allow-fail` 后，任何机器断言失败使进程返回 1；环境或配置错误返回 2；全通过返回 0。`--allow-fail` 仅用于留存当前基线，不改变报告中的失败数。输出路径可用 `--output` 指定，但须位于 `evaluation/` 内。

脚本运行全部 36 个场景。每个场景固定一个 `user_id`，不同 `session` 使用不同 `session_id`；调用当前 Wit API 的 `load(session_id, user_id)`、`save(session_id, state, user_id)` 与 `chat(session_id, text, user_id=user_id)`。仅首段注入已有偏好与按顺序可见的商品，并核对注入后的 ID、价格、材质和颜色。跨会话时重建本地 agent，第二段只调用 `load` 观察自然继承的用户偏好与隔离的当前商品，不覆写状态。`machine_checks.json` 指定记忆写入/覆盖/遗忘、跨会话取回、明显情绪提示到策略、澄清后搜索与当前商品追问不重搜，以及若干已知/未知事实回复。脚本还检查每个返回商品的结构化字段是否与夹具一致，并对无购买意图轮次检查显式催购标志与固定施压词。无返回商品时不会凭空给结构化事实得分；事实文本断言也只覆盖已列出的问句。

这些数值是本地 agent 对固定断言的通过次数，不是推荐质量、人格表现或满意度的完整评分。未编码的 `must`/`forbid` 仍按 `rubric.md` 人工评审。若将来做 A/B/C/D，对每组分别运行相同夹具与检查，并保留人工评分；当前脚本只运行完整本地 agent，不冒充四组消融结果。
