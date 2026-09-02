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

AgentSociety 2.8.4 的 wheel 元数据没有声明其生命周期实际导入的 Ray，本工作区因此在 requirements 中显式补充 `ray>=2.9,<3`。正式 runner 在创建 run 目录前检查包元数据版本（不用包内残留的 `__version__`）、Python 范围、Ray、模型与 API 环境；缺 Ray 会以 `SDK_RAY_UNAVAILABLE` 失败，不会退回替代 runner。

## 工作区内容

- `custom/envs/partner_choice_env.py`：平台可扫描的 `PartnerChoiceEnv`，提供 observe/submit/status 工具与每日 round 调度。
- `custom/agents/partner_choice_agent.py`：无跨轮记忆的 fresh-completion 决策代理；仅把稳定档案和受控 observation 送入模型。
- `custom/partner_choice_core.py`：无 SDK 依赖的处理隔离、标签随机、事件顺序和 checkpoint 状态机。
- `custom/skills/partner-choice/SKILL.md`：所有条件共用的 observation-only 伙伴选择流程。
- `protocol/profiles/cohort-24.json`：固定合成档案目录；每个 seed 使用确定性一一分配。
- `protocol/run-matrix.v1.json`：4 个主条件和 2 个 recent-3 条件各 5 seed 的冻结运行矩阵。
- `analysis/validate_run.py`：逐 run 检查完整轮次、候选配对、历史遮蔽、事件顺序与哈希一致性。
- `analysis/metrics.py`：把 Replay 选择事件投影为与 TypeScript 测量引擎同义的七项网络指标。
- `execution/stage_bundle.py`：只读地从冻结 manifest、矩阵和 cohort 派生带哈希的执行 bundle。
- `execution/run_formal.py`：真实调用 `AgentSociety.init/step/close` 的单 run 生命周期入口，逐模拟日推进并 checkpoint。
- `execution/quality.py`：输出完成率、调用/attempt、token、fallback、墙钟、Replay/checkpoint 大小与错误分类的 formal gate。
- `tests/`：跨语言 golden、处理泄漏、候选配对、事件顺序、恢复、SDK scanner 与 ReplayReader 验收。

## 执行 bundle 与正式入口

五个 stage 均为确定性派生且不改写 `experiment-manifest.v1.json` 或 `protocol/run-matrix.v1.json`：`online-smoke` 为 2 人×1 日×1 run；`capacity` 为 24 人×2 日×4 核心条件；`preflight` 为 24 人×5 日×4 核心条件（首个 seed）；`main` 为 4 条件×5 seed×60 日；`robustness` 为 2 条 recent-3 条件×5 seed×60 日。bundle 冻结实际模型 ID、三个源文件的内容/文件哈希、每个 staged protocol 哈希、seed-block 顺序和统计单位。

```bash
export AGENTSOCIETY_LLM_API_KEY='...'
export AGENTSOCIETY_LLM_API_BASE='https://workspace.example/v1'
export AGENTSOCIETY_LLM_MODEL='actual/workspace-model-id'
export WORKSPACE_PATH="$PWD"

PYTHONPATH=. python -m execution.stage_bundle \
  --stage online-smoke \
  --model-id "$AGENTSOCIETY_LLM_MODEL" \
  --output /new/path/online-smoke.bundle.json

PYTHONPATH=. python -m execution.run_formal \
  --bundle /new/path/online-smoke.bundle.json \
  --run-id memory-full__gift-off__seed-101__online-smoke \
  --run-dir /new/empty/path/run-001
```

正式入口拒绝 placeholder model、SDK/Python/Ray 不符、关键环境缺失、已存在的非空 fresh run 目录和与 bundle 不一致的 resume。API key 只由 SDK 从环境读取，不进入 bundle、run metadata 或质量报告。恢复使用同一 `--bundle/--run-id/--run-dir --resume`；`formal-run.json` 的 bundle hash 必须匹配。

故障注入仅允许 `test/preflight/online-smoke`，且必须显式设置 `AGENTSOCIETY_ALLOW_FAULT_INJECTION=1`。三个点分别为 `after_replay_append`、`after_written_set`、`after_checkpoint_write`；marker 为持久化 fail-once，恢复时先用真实 ReplayReader 对账 event ID。不要在 main/robustness 启用。

`quality-report.json` 的 `formalGatePassed` 是进入分析的必要条件：迟到/跳过、重复 event ID、缺 choice/interaction、事件序列不完整、真实模型审计字段缺失或 choice+interaction 合计 fallback>5% 均失败。报告只存数值容量信息和错误类别，不存 key；raw model response 只在正式 Replay 的受控事件审计字段中保存。

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

`tests/sdk_lifecycle_fixture.py` 使用随机 localhost 端口的受控 OpenAI-compatible server 尝试真实 SDK lifecycle；它不会访问 Ollama 或 8898。它只属于工程门：若 Ray 可用则必须形成 2-agent×1-day 的真实 AgentSociety/Replay 闭环；若 Ray 缺失则只接受明确 `SDK_RAY_UNAVAILABLE` 硬失败。此 fixture、离线 smoke 和本地 Ollama 均不是正式比赛证据。正式证据只能来自在线工作区冻结的真实模型 ID、真实 request ID 与正式 Replay。

正式独立分析单位始终是 condition×seed world-run；day、agent、dyad 都是 run 内嵌套重复测量。确认性主估计量是 day 31–60 的 directed-edge repeat。5 个 paired seeds 的双侧精确检验最小 p=.0625，不能宣称达到 alpha=.05 显著；若扩至 8 seed，必须在查看任何正式结果方向前冻结。

## 正式采集硬门

- 在线工作区固定实际模型标识，并完成至少一次真实 `AgentSociety.init/step/close` 决策链；Replay 中实际模型 ID、请求 ID、采样参数、渲染提示哈希、原始响应与解析结果完整。
- 完成互动的摘要与馈礼事实进入下一轮 dyadic history；`none` observation 仍不含任何历史派生信息或处理标签。
- 24-agent×2 天×4 主条件容量标定记录 completion 数、token、失败率、fallback 率、墙钟时间与 checkpoint 大小。
- append 后、已写集合更新后、checkpoint 后三处故障注入均通过 exactly-once 对账。该门通过前，崩溃 run 使用同一 manifest 整块重跑。
- validator 要求每天恰 N 个选择、fallback≤5%、零 `late_or_skipped_round`、连续 eventSeq、唯一 eventId 与一致的配对候选顺序。
