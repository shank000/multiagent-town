# AgentSociety² 正式实验工作区

本目录承载赛道 7 的正式平台实验，平台版本固定为 AgentSociety² 2.8.4，Python 版本范围为 3.11–3.13。

## 实验设计

- 主实验：N=24，60 天，5 个固定种子，关系记忆 `none/full` × 馈礼 `off/on` 的 2×2 设计。
- 稳健性扩展：每位候选仅暴露最近 3 次互动，分别配对馈礼开/关条件。
- 候选控制：每轮候选均为除本人外的全部参与者，数量固定为 N−1；配对条件使用相同的候选顺序。
- 决策控制：所有主实验条件使用同一 LLM、Skill、提示模板、采样参数、解析器、重试和 seeded fallback。记忆处理只改变候选历史的可见内容，馈礼处理只发生在选择事件落盘之后。
- Replay：伙伴选择事件使用 `partner_choice.choice_event` 数据集，并按 `day/round_id/chooser_id/event_seq` 确定性排序。

规范清单位于 `experiment-manifest.v1.json`；24 人档案和生成后的 30-run 矩阵位于 `protocol/`；TypeScript 协议与离线验证器位于 `src/engine/experiment-contract.ts`。

## 平台环境

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

`agentsociety2==2.8.4` 使用 FastMCP 1.x 模块布局，因此 requirements 同时固定 `mcp>=1.13.1,<2`。平台导入时需要工作区提供 `AGENTSOCIETY_LLM_API_KEY`；离线 smoke 可使用非联网占位值，因为该门只验证模块、Replay 和恢复，不调用模型。

## 工作区内容

- `custom/envs/partner_choice_env.py`：平台可扫描的 `PartnerChoiceEnv`，提供 observe/submit/status 工具与每日 round 调度。
- `custom/agents/partner_choice_agent.py`：无跨轮记忆的 fresh-completion 决策代理；仅把稳定档案和受控 observation 送入模型。
- `custom/partner_choice_core.py`：无 SDK 依赖的处理隔离、标签随机、事件顺序和 checkpoint 状态机。
- `custom/skills/partner-choice/SKILL.md`：所有条件共用的 observation-only 伙伴选择流程。
- `protocol/profiles/cohort-24.json`：固定合成档案目录；每个 seed 使用确定性一一分配。
- `protocol/run-matrix.v1.json`：4 个主条件和 2 个 recent-3 条件各 5 seed 的冻结运行矩阵。
- `analysis/validate_run.py`：逐 run 检查完整轮次、候选配对、历史遮蔽、事件顺序与哈希一致性。
- `analysis/metrics.py`：把 Replay 选择事件投影为与 TypeScript 测量引擎同义的七项网络指标。
- `tests/`：跨语言 golden、处理泄漏、候选配对、事件顺序、恢复、SDK scanner 与 ReplayReader 验收。

## 验证

纯协议测试不需要 AgentSociety SDK：

```bash
python protocol/generate_run_matrix.py
PYTHONPATH=. python -m unittest discover -s tests -p 'test_*.py' -v
```

单次运行完成后，将该 run 的冻结 protocol 写入运行目录，并使用 validator 作为进入统计分析的硬门：

```bash
PYTHONPATH=. python analysis/validate_run.py \
  --protocol run/protocol.json \
  --replay-dir run/replay
```

真实 SDK 冒烟门需要 Python 3.11—3.13：

```bash
export AGENTSOCIETY_LLM_API_KEY=offline-contract-smoke
export WORKSPACE_PATH="$PWD"
export PYTHONPATH="$PWD"
python tests/real_sdk_smoke.py
```

该门验证 `PartnerChoiceAgent`/`PartnerChoiceEnv` 扫描、`@tool` 注册、净化提示、四个 Replay dataset 的 schema/写入/DuckDB 读取，以及受控 checkpoint/restore。固定值提交在此门中明确记录为 `tool_submission`，不冒充 LLM 决策。

## 正式采集硬门

- 在线工作区固定实际模型标识，并完成至少一次真实 `AgentSociety.init/step/close` 决策链；Replay 中实际模型 ID、请求 ID、采样参数、渲染提示哈希、原始响应与解析结果完整。
- 完成互动的摘要与馈礼事实进入下一轮 dyadic history；`none` observation 仍不含任何历史派生信息或处理标签。
- 24-agent×2 天×4 主条件容量标定记录 completion 数、token、失败率、fallback 率、墙钟时间与 checkpoint 大小。
- append 后、已写集合更新后、checkpoint 后三处故障注入均通过 exactly-once 对账。该门通过前，崩溃 run 使用同一 manifest 整块重跑。
- validator 要求每天恰 N 个选择、fallback≤5%、零 `late_or_skipped_round`、连续 eventSeq、唯一 eventId 与一致的配对候选顺序。
