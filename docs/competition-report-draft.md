# 研究报告（草稿 v2）：关系记忆访问如何塑造智能体社会的伙伴结构

> AI 社会科学家研究挑战赛 · 赛道 7（智能体与计算社会科学探索）
>
> 正式实验平台：AgentSociety² 2.8.4　｜　初筛提交：2026-09-15
>
> 证据状态：本地机制正控与运行基准可复核；平台协议、环境和真实 SDK 合同冒烟可复核；在线 LLM 正式结果尚未采集

## 摘要

大语言模型智能体能否在伙伴选择时使用“与特定伙伴的互动历史”，并由此形成稳定的关系结构？本研究在候选数量与顺序严格相等的每日选择任务中，以**关系历史可见性**与**馈礼交换**构成 2×2 因子设计。正式实验让所有条件使用同一 LLM、fresh-completion 代理、提示模板、模型参数、解析、重试与 seeded fallback；历史处理唯一改变 agent 实际看到的 dyadic history。馈礼在 choice 落盘后发生，并仅通过后续可见的伙伴历史进入下一轮决策。唯一确认性主要结局是第 31—60 天的有向同对重复率均值，其余网络指标用于结构与机制解释。

本地 N=6、20 天×3 seed 的机制正控显示：关系加权代码策略相对 seeded uniform 的平均有向同对重复率为 0.553—0.608，对照为 0.222；平均 7 日伙伴多样性为 2.139—2.317，对照为 3.458。该结果表明测量链能识别代码注入的历史依赖结构，但不估计“LLM 记忆可见性”的因果效应。正式证据预定来自 AgentSociety² 上 N=24、60 天、5 个配对 seed 的完整 2×2 运行，并以 recent-3 条件检验记忆深度稳健性。

本研究的预期贡献是把**关系记忆访问权**定义为可操控、可审计的智能体社会机制变量，并提供从 agent 可见 observation、选择、馈礼、互动到关系状态的 Replay 证据链。

## 1. 研究问题与理论动机

[社会嵌入性理论](https://doi.org/10.1086/228311)把持续关系结构视为行动的重要条件；[重复博弈实验综述](https://doi.org/10.1257/jel.20160980)显示未来互动条件会改变合作行为。LLM 智能体研究则已把记忆、反思与检索用于生成持续行为（例如 [Generative Agents](https://doi.org/10.1145/3586183.3606763)），并发展出大规模社会模拟平台（例如 [AgentSociety](https://arxiv.org/abs/2502.08691)）。本研究不假定这些智能体等同于人类，而把“伙伴特定历史的访问权”单独操控，检验其对智能体选择结构的作用。由此产生核心问题：

> 当每位 agent 面对相同数量、相同顺序的候选伙伴时，伙伴特定互动历史的可访问性，是否会把离散选择转化为历史依赖模式，并逐日形成重复互动对、枢纽和低传递性的持久关系结构？

馈礼是第二个机制因子：礼物事实在选择完成后写入双方互动记录；只有具历史访问权的 agent 能在后续轮次读取这一关系信号。该设计检验馈礼是否放大“互动—记忆—再选择”的正反馈。

## 2. 假设与结局

- **H1 历史依赖**：full-history 条件的同对重复率高于 none-history。
- **H2 关系集中**：full-history 条件具有更高伙伴 HHI、更低伙伴多样性和更高枢纽集中度。
- **H3 时间持久性**：full-history 条件的相邻非重叠双 7 日有向选择矩阵持续性更高，且差异在后期扩大。
- **H4 馈礼交互（次要）**：馈礼对历史依赖与关系集中的强化在 full-history 下强于 none-history。
- **鉴别性诊断**：机会校正互惠性用于区分重复选择、相互选择和偶然基线，不预先规定零效应。

唯一确认性主要结局在查看正式结果前固定为第 31—60 天的有向同对重复率均值。第 31—60 天的 7 日伙伴 HHI、伙伴多样性、加权入度 Freeman 枢纽集中度、聚类系数与机会校正互惠性，以及有效终点为第 14—60 天的相邻非重叠双 7 日矩阵 Pearson 相关，均为次要结构结局。关系值、馈礼链和解析失败率为机制或操控结局。

## 3. 设计与方法

### 3.1 正式实验单位与因子

实验单位是一个独立的 condition×seed AgentSociety² 世界运行。每个 seed block 内四个主条件共享完全相同的 24 个 agent 档案及 ID：

| 条件 | 历史 observation | 馈礼 |
|---|---|---|
| memory-none__gift-off | 无伙伴历史 | 关 |
| memory-none__gift-on | 无伙伴历史 | 开 |
| memory-full__gift-off | 截至选择前的完整伙伴历史 | 关 |
| memory-full__gift-on | 截至选择前的完整伙伴历史 | 开 |

`memory-recent3__gift-off/on` 是记忆深度稳健性条件。每个运行 60 天，每日 19:30 一轮，每位 agent 从其余 23 人中独立选择 1 人。基础矩阵为 6 条件×5 seed=30 个运行、43,200 次选择。

### 3.2 因果隔离

所有条件遵循同一链条：

`observe_partner_round → fresh LLM completion → parse/retry → submit_partner_choice → choice Replay → gift → interaction → relationship state`

配对臂固定 agent 档案、候选 ID 与顺序、Skill、提示模板、模型与采样参数、工具签名、解析器、最大尝试数和 fallback。none 组 observation 不包含亲密度、最近互动、互动次数、摘要或礼物史。研究者审计用的 `preChoiceCandidates` 不进入 LLM 输入。候选快照在整轮馈礼与关系更新前冻结。

本地控制台中的 memory-on 使用关系加权代码策略，memory-off 使用 seeded uniform，因此它是机制正控与展示，不是正式历史可见性处理。

### 3.3 Replay 与可复现协议

每次运行由 `partner-choice.protocol/v1` 唯一描述，并记录 run、condition、seed、配对 block、档案哈希、模型参数与处理。标签派生随机流按 seed/block/day/chooser/用途生成候选顺序与 fallback，避免不同条件因随机数消费量不同而漂移。

四个 append-only 数据集分别记录：

1. `partner_choice.choice_event`：精确 observation、处理前审计快照、原始响应、解析状态和决策来源；
2. `partner_choice.gift_event`：choice 后的馈礼及关系增量；
3. `partner_choice.interaction_event`：互动状态、摘要和对应 choice；
4. `partner_choice.relationship_state`：有向 dyad 的关系快照。

Replay 通过显式 `day/round_id/chooser_id/event_seq` 排序，不依赖 shard 文件顺序；workspace checkpoint 保存轮次、提交、关系、历史、经济、事件序号与已写事件 ID。受控 checkpoint/restore 已通过合同测试；append 后崩溃的 exactly-once 对账属于正式续跑前的硬门，未通过时整次 run 从冻结 manifest 重跑。

### 3.4 分析原则

处理被独立施加在世界运行层，因此 seed-block 配对运行是独立重复；60 天、24 个 agent 与 dyad 是运行内重复。主结果展示每个 seed 的配对效应与不确定性，不把 agent-day 计作独立样本。

每个 run 先在预定时间窗汇总为一个 seed×condition 值。seed 内历史主效应定义为 `0.5×[(full,on−none,on)+(full,off−none,off)]`；馈礼主效应对两个历史水平边际化；交互定义为 `(full,on−full,off)−(none,on−none,off)`。报告五个配对差值、均值、中位数、范围和 leave-one-seed-out 范围。

5 个配对的双侧精确符号置换只有 32 种分配，最小双侧 p 值为 0.0625，因此基础设计不能在 α=.05 下给出确认性拒绝。若容量允许，追加 3 个 seed 的决定在查看正式处理效应前登记。通过门槛且 fallback 比例不超过 5% 的运行纳入 ITT 主分析；排除 fallback 的结果仅作敏感性分析。任何 `late_or_skipped_round` 使整次运行失效。

每个 run 先通过完整性 validator：每日恰 N 条 choice、候选恰 N−1、无自选/重复、chosen 合法、配对候选顺序一致、history 暴露合法、choice 早于 gift、哈希可重算、eventId 唯一。未通过的 run 不进入分析。

## 4. 本地机制正控（N=6，20 天×3 seed，mock LLM）

| 指标 | 记忆关/无礼 | 记忆关/馈礼 | 记忆开/无礼 | 记忆开/馈礼 |
|---|---:|---:|---:|---:|
| 有向同对重复率 | 0.222±0.041 | 0.222±0.041 | 0.553±0.033 | 0.608±0.036 |
| 7 日伙伴多样性 | 3.458±0.038 | 3.458±0.038 | 2.317±0.131 | 2.139±0.111 |
| 7 日伙伴 HHI | 0.380±0.004 | 0.380±0.004 | 0.614±0.040 | 0.683±0.033 |
| 双 7 日矩阵持续性 | −0.043±0.105 | −0.043±0.105 | 0.561±0.013 | 0.593±0.127 |
| 加权入度枢纽集中度 | 0.253±0.009 | 0.253±0.009 | 0.340±0.088 | 0.370±0.099 |
| 机会校正互惠性 | 0.994±0.075 | 0.994±0.075 | 1.462±0.075 | 1.623±0.124 |
| 聚类系数 | 0.129±0.039 | 0.129±0.039 | 0.053±0.043 | 0.049±0.017 |

表中为“先在每个 seed 的有效日内求均值，再对 3 个独立 seed 求均值±总体标准差”；逐 seed 原值见 `docs/data/local-reference-pilot-20d-3seed.v1.json`。这些描述量表明测量系统能识别关系加权策略产生的重复与集中结构；由于本地历史条件同时改变选择政策，数值不用于估计正式 LLM 历史可见性效应。馈礼与记忆条件的差异仅作机制线索，不作推断声明。

## 5. AgentSociety² 实现状态

- 版本固定：`agentsociety2==2.8.4`、Python 3.11—3.13、FastMCP 1.x 兼容约束 `mcp<2`。
- `PartnerChoiceEnv` 与 observation-only `PartnerChoiceAgent` 通过 Python 3.12.13、`agentsociety2==2.8.4`、`mcp==1.29.0` 的模块扫描、工具注册、ReplayWriter/ReplayReader 与受控 checkpoint/restore 冒烟门。
- 24 人平衡档案、5 个 seed、4 个主条件与 2 个 recent-3 条件已展开为可哈希的 30-run 矩阵。
- TypeScript/Python 对 canonical JSON、协议哈希、候选顺序和七项指标使用共同 fixture 与 parity 门。
- 本地 60 天×5 seed×4 条件参考压力基准耗时 2:41.96、峰值 RSS 170,680 KB、退出码 0；它验证本地运行边界，不代表平台成本。
- 在线工作区仍需固定真实模型标识、运行一次真实 `AgentSociety.init/step/close` 决策链、接入完成互动摘要、通过崩溃恢复故障注入，并执行 24-agent 容量标定。

## 6. 正式结果（平台数据回填区）

本节仅接收通过 validator 的 AgentSociety² Replay 输出：

1. run/round 完整性、LLM/fallback/失败率与操控检查；
2. 唯一主要结局与全部次要结局的逐 seed 配对差值和时间曲线；
3. history×gift 交互与 recent-3 剂量模式；
4. 网络快照、枢纽稳定性与低传递性证据；
5. 模型/温度/提示扰动的稳健性结果。

任何未采集的平台数值保持空缺，不使用本地 pilot 补位。

## 7. 平行世界叙事与展示边界

控制台三个世界分别展示 memory+gift 联合处理、零处理参考与谣言传播。选择场景卡保留 `mode/candidates/chosen`，关系网络和 7 个指标小多图提供微观事件到宏观结构的可视路径。该层用于解释研究机制与复现实验流程；正式报告的因果表格只来自平台完整 2×2。

## 8. 预期理论与方法贡献

1. **机制变量**：将关系记忆访问权从系统能力转化为可干预、可随机化、可审计的社会机制。
2. **涌现解释**：检验“互动记录可见→历史依赖选择→重复 dyad/枢纽→低传递性关系结构”的微观—宏观链。
3. **测量框架**：联合选择重复、sender 集中、跨日持续与 receiver 枢纽化，区分稳定关系、简单互惠和偶然热门。
4. **可复现基础设施**：提供条件矩阵、跨语言协议、精确 observation、Replay validator 与恢复语义，可迁移到信任、合作、信息披露与组织记忆研究。

## 9. 局限与伦理边界

- LLM 行为是模型、提示与平台版本的联合产物，不外推为人类关系规律。
- 5 个配对 seed 的双侧精确检验最小 p 值为 0.0625；基础设计只能提供估计性与方向一致性证据，不能支持 α=.05 的确认性拒绝。
- agent 档案可能影响枢纽形成；档案在配对臂内固定，并需在跨 seed/模型稳健性中检验。
- 真 LLM 输出不保证逐字重演；可复现性定义为精确记录配置、输入、实际输出、失败与 fallback，而不是宣称生成完全确定。
- 使用合成档案与模拟关系，不处理真实个人数据；结论明确限定为智能体社会模拟。

## 附：代码与复现入口

- 本地机制正控：`pnpm experiment --days 20 --seeds 3`
- 正式协议：`src/engine/experiment-contract.ts`
- 平台工作区：`platform/agentsociety2/`
- 运行矩阵：`platform/agentsociety2/protocol/run-matrix.v1.json`
- 平台环境：`platform/agentsociety2/custom/envs/partner_choice_env.py`
- 执行计划：`docs/competition-execution-plan.md`
- 本地逐 seed 数据：`docs/data/local-reference-pilot-20d-3seed.v1.json`
- 验证证据：`docs/runtime-validation.md`

## 资料依据与提交前人工确认

- 赛事日期、团队规模、提交物、平台绑定、额度和评审维度依据[赛事发布页](https://www.leiphone.com/category/industrynews/CbroiTWerVTsMc8i.html)；团队在提交前以赛事官网最终规则复核。
- AgentSociety² 环境模块与恢复接口依据[官方 Environment Modules 文档](https://agentsociety2.readthedocs.io/en/latest/env_modules.html)；Replay 结构与读取依据[官方 Storage 文档](https://agentsociety2.readthedocs.io/en/latest/storage.html)。
- 正式稿补齐作者署名与 CRediT 贡献、资金来源、利益冲突、生成式 AI 使用披露和数据/代码可用性声明。
