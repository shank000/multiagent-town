# AgentSociety² 2.8.4 伙伴选择实验契约

## 1. 因果识别边界

正式主实验的行为链固定为：

`观察候选 → 同一 LLM 选择流程 → 校验/重试/seeded fallback → 记录 choice → 馈礼处理 → 互动 → 关系更新`

关系记忆主效应只操控候选历史的可见内容。配对条件共享智能体档案与 ID、候选集合与顺序、fresh-completion 代理、提示模板、模型参数、输出解析、重试次数和 fallback 规则。模型可见 observation 不含 run、condition、处理标签、亲密度、最近互动或互动次数；`none` 条件也不含摘要或馈礼史。这些客观状态与处理标签只进入研究者审计快照。

本地预实验的“记忆开=代码评分、记忆关=代码随机”属于机制正控，不作为正式平台主因果对照。

## 2. 条件矩阵

主分析采用完整 2×2：

| 条件 | 历史可见性 | 馈礼 |
|---|---|---|
| memory-none__gift-off | 不可见 | 关 |
| memory-none__gift-on | 不可见 | 开 |
| memory-full__gift-off | 全量二元互动历史 | 关 |
| memory-full__gift-on | 全量二元互动历史 | 开 |

`recent_k=3` 的两个馈礼水平构成稳健性扩展，不计入主 2×2。完整参数见 `platform/agentsociety2/experiment-manifest.v1.json`。

## 3. 协议与 Replay

`PartnerChoiceProtocolV1` 为每个 condition × seed 建立唯一运行协议，记录 run、配对区组、处理、种子、参与者、档案哈希、日程和完整 LLM 参数。协议使用递归键排序的 canonical JSON 计算 SHA-256。

`PartnerChoiceReplayV1` 每位参与者每轮一行，核心不变量为：

- 每轮恰 N 条 choice，每位参与者一条；
- 候选恰 N−1、无本人、无重复，且顺序与配对协议一致；
- chosen 必须属于候选集合；
- `none` 的 `visibleHistory` 为空；`recent_k` 每位候选最多 k 条；`full` 记录决策时点前的全部可见历史；
- `preChoiceCandidates` 是馈礼和关系更新前的客观快照；
- 每行记录协议哈希、档案哈希、真实模型参数、输入/提示哈希、原始响应、解析状态、尝试次数和决策来源；只有具完整模型/请求/提示/响应审计的程序化提交可标为 `llm`，普通工具提交标为 `tool_submission`；
- Replay 默认顺序为 `day, round_id, chooser_id, event_seq`，不依赖 JSONL shard 的文件顺序。

叙事前台兼容投影继续提供 `kind/fromId/toId/mode/candidates/chosen`；`candidates` 保持 `id/name/affection/lastInteraction` 字段。

## 4. AgentSociety² 环境边界

正式执行由 observation-only `PartnerChoiceAgent` 与环境模块共同完成。代理每轮建立新的 completion，仅发送稳定档案与受控 observation，不读取跨轮会话、个人 workspace memory 或处理标签。环境模块提供三类工具：

- `observe_partner_round(agent_id)`：返回形状一致的候选观察，仅历史内容按处理条件变化；
- `submit_partner_choice(agent_id, chosen_id, rationale)`：校验并幂等记录选择；
- `get_round_status()`：提供只读统计。

`step(tick, t)` 管理轮次与跨日推进；`to_workspace/restore` 保存当前日、轮次、已提交选择、关系、互动、经济、事件序号和幂等事件 ID。标签派生随机流分别服务候选顺序与 fallback，配对条件不会因执行分支消耗不同数量的随机数而漂移。

馈礼只在 choice 事件落盘后发生。礼物事实写入双方的互动记录，并在下一轮按 `none/recent_k/full` 规则暴露，因此它具有可检验的后续选择通道，同时不会污染本轮处理前快照。

最小 Replay 数据集为：

1. `partner_choice.choice_event`：选择输入、输出与审计；
2. `partner_choice.gift_event`：选择后的馈礼与关系增量；
3. `partner_choice.interaction_event`：互动 started/completed/failed 状态；
4. `partner_choice.relationship_state`：每轮后的有向关系快照。

## 5. 验收门槛

- 清单、协议、条件矩阵和 golden Replay 通过离线契约校验；
- 同一配对区组与种子下，none/full 条件的候选 ID 与顺序一致；
- 受控 checkpoint+resume 的状态一致；append 后、已写集合更新后、checkpoint 后三处故障注入均证明 Replay 无重复事件，才允许正式 run 从崩溃点续跑；
- ReplayReader catalog 可发现四个数据集，列、版本和默认排序正确；
- choice 适配为 `{day, from, to}` 后，与共享测量引擎的结果一致；
- 运行验证器能检出缺轮、重复提交、自选、候选不等、历史泄漏、chosen 越界、哈希不一致和馈礼先于选择。
- 真实 `AgentSociety.init/step/close` 运行至少完成一个在线模型决策，并记录实际模型 ID、请求 ID、采样参数、渲染提示哈希和原始响应。

平台接口依据 AgentSociety² 2.8.4 官方 [`EnvBase/@tool/step` 与 workspace 恢复规范](https://agentsociety2.readthedocs.io/en/latest/env_modules.html)，以及 [append-only Replay 与显式排序规范](https://agentsociety2.readthedocs.io/en/latest/storage.html)。
