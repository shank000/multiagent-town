# 赛道 7 执行计划与验收门槛

> 状态日期：2026-08-23　｜　初筛提交：2026-09-15　｜　内部封包截止：2026-09-13

## 研究边界

正式研究只检验一个核心问题：在候选伙伴数量与顺序相等时，LLM agent 能否访问特定伙伴的互动历史，以及这种访问能否将离散互动转化为持续的伙伴选择结构。AgentSociety² 运行结果是正式证据；本地 TypeScript 平行世界用于机制正控、演示和协议对照，不替代平台实验。

实验采用按 seed 配对的完整 2×2：历史 `none/full` × 馈礼 `off/on`。`recent_k=3` 是稳健性扩展。所有条件使用相同 agent 档案、候选集合与顺序、Skill、提示模板、模型、采样参数、解析器、重试和 seeded fallback。比较历史主效应时，唯一直接变化是 observation 中的历史内容；比较馈礼主效应时，馈礼只在 choice 事件落盘后生效。

独立重复单位是一次 condition×seed 世界运行。日、agent 与 dyad 是运行内重复测量，不作为独立处理重复。

## 第一阶段：本周平台移植准备（8/23—8/30）

| 工作包 | 最终产物 | 通过门槛 |
|---|---|---|
| 协议冻结 | `partner-choice.protocol/v1`、study manifest、24 人档案、30-run 基础矩阵 | 4 个主条件×5 seed + 2 个 recent-3 条件×5 seed；配对臂档案哈希和候选顺序一致 |
| 环境模块 | `PartnerChoiceEnv(EnvBase)` 与 observe/submit/status 工具 | AgentSociety² 2.8.4 scanner 接受；无参构造；合法/重复/越界提交均结构化响应 |
| 数据与恢复 | choice/gift/interaction/relationship 四个 Replay 数据集；workspace checkpoint | ReplayReader 可发现并读取；choice 默认顺序为 day/round/chooser/seq；受控 checkpoint/restore 状态一致；append 后故障注入与 Replay 对账通过后才允许正式续跑 |
| 因果隔离 | observation-only fresh completion、none 组零历史派生字段 | 抽查完整提示与工具日志；none 组不含亲密度、次数、时间、摘要或礼物史 |
| 在线接入 | 在线工作区导入、真实模型配置、24 agent 初始化、互动完成摘要接线 | 1 seed×2 天 dry-run 无缺轮；choice 历史只来自已完成互动；实际模型 ID/请求 ID 可审计 |
| 容量标定 | 24 agent×2 天×4 主条件的小规模基准 | 记录调用数、token、失败率、墙钟时间和 checkpoint 大小；据此冻结并发与批次计划 |

本阶段的硬性 go/no-go：在线互动摘要没有进入下一轮 dyadic history、none 组出现上下文泄漏、真实 `AgentSociety.init/step/close` 链路未完成、实际模型与请求 ID 不可审计、append 后崩溃恢复不能证明无重复，或任一轮 choice 数不等于 N 时，正式采集不启动。

## 第二阶段：实验与稳健性（8/31—9/6）

1. 先执行 4 主条件×1 seed×5 天的预飞行；只检查完整性、成本和操控，不读取处理效应方向。
2. 主实验执行 N=24、60 天、4 条件×5 个预定 seed，共 20 个运行、28,800 次伙伴选择。运行顺序在每个 seed block 内随机化，避免平台负载或模型漂移与处理条件重合。
3. recent-3 扩展执行 2 条件×5 seed，共 10 个运行、14,400 次伙伴选择。全矩阵合计 30 个运行、43,200 次选择；最大两次尝试时容量上界为 86,400 次选择 completion，另计互动调用。
4. 每个运行结束立即执行 validator：60 轮、每轮 N 条 choice、候选 N−1、无自选、chosen 合法、配对顺序一致、history 暴露合法、choice 早于 gift、哈希可重算、eventId 无重复。
5. 唯一确认性主要结局是第 31—60 天的有向同对重复率均值。次要结构结局为第 31—60 天的 7 日伙伴 HHI、伙伴多样性、加权入度 Freeman 枢纽集中度、聚类系数和机会校正互惠性，以及有效终点为第 14—60 天的相邻非重叠双 7 日有向矩阵 Pearson 持续性。HHI 的前 6 天启动窗口不进入后期估计。
6. 每个 run 先在预定时间窗内汇总为一个 seed×condition 值。seed 内历史主效应为 `0.5×[(full,on−none,on)+(full,off−none,off)]`；馈礼主效应对两个历史水平边际化；交互为 `(full,on−full,off)−(none,on−none,off)`。报告全部配对差值、均值、中位数、范围和 leave-one-seed-out 范围，不把 agent-day 当独立样本。5 个配对下双侧精确符号置换的最小 p 值为 0.0625，因此基础设计不作 α=.05 的确认性拒绝声明；容量标定后若资源允许，在查看正式结果前登记 3 个追加 seed。
7. 通过运行门槛且 fallback 比例不超过 5% 时，fallback 选择纳入 ITT 主分析；排除 fallback 的 per-protocol 结果仅作敏感性分析。任何 `late_or_skipped_round` 使整次 run 失效。缺失轮次不插值；恢复链通过故障注入门后才从 checkpoint 续跑，否则使用同一 manifest 整块重跑。
8. 稳健性优先级：recent-3；模型/温度复跑；提示措辞扰动。长度匹配的 masked-history placebo 仅在容量允许且在查看主结果前登记时执行，用于区分关系内容与上下文长度效应。

## 第三阶段：报告与提交（9/7—9/14）

| 日期 | 交付 |
|---|---|
| 9/7—9/9 | 冻结 Replay；生成主结果、逐 seed 效应、演化曲线、网络图、操控与失败率附表 |
| 9/9—9/11 | 报告 v2：方法、AgentSociety² 实现、正式发现、理论贡献、稳健性、局限与伦理边界 |
| 9/11—9/12 | 平行世界叙事作为机制演示；本地 mock pilot 明确标注为正控，不与正式因果估计混表 |
| 9/12—9/13 | 代码、报告、工作区、manifest、profile/run 哈希、Replay validator 输出和复现说明封包；全新目录恢复演练 |
| 9/13—9/14 | 团队交叉复核与提交回执；9/15 仅作故障缓冲 |

报告按评审五维组织：社会科学问题与关系嵌入理论；“关系记忆访问权”这一机制变量；配对因子设计与防泄漏协议；持续关系结构的实证发现；可复用环境、Replay 契约和扩展潜力。

## 风险登记

| 风险 / 触发线 | 应对与停止规则 |
|---|---|
| 在线工作区/API 权限在 8/26 前未到位 | 当日联系队伍与赛事支持；离线契约继续验证；正式证据必须来自 AgentSociety²，不采用平台外结果替代 |
| 队伍人数未达到 3—5 人 | 8/28 前锁定成员与职责；未满足报名规则则优先完成组队 |
| SDK 依赖漂移 | 固定 `agentsociety2==2.8.4`、Python 3.11—3.13、`mcp<2`；工作区保存 lock/安装日志和真实 SDK smoke 输出 |
| 模型调用量超过额度或墙钟窗口 | 先做容量标定；按 seed block checkpoint；主 2×2 优先于 recent-3，再优先于模型/提示扩展 |
| 条件上下文泄漏 | 强制 fresh completion；保存渲染提示哈希和工具调用；发现泄漏的 run 作废并修正后整块重跑 |
| LLM 非确定性与解析失败 | 固定参数并记录原始响应；统一两次解析尝试；标签派生的 paired fallback；分条件报告失败率 |
| 5 seed 无法支持双侧 α=.05 精确拒绝 | 报告配对差值、估计范围与 leave-one-seed-out 稳健性；容量允许时在看结果前扩至 8 seed；不使用 agent-day 扩大名义样本量 |
| Replay shard 顺序、重复写或恢复异常 | 依赖显式 default order 和确定性 eventId；validator 对重复行 fail-closed；append 后/状态更新后/checkpoint 后三处故障注入通过前，正式 run 不从崩溃点续跑 |
| 本地平行世界混合了记忆与馈礼 | UI 明示“联合处理展示/零处理参考”；正式结论只引用平台完整 2×2 |
| 长运行内存或事件查询增长 | API 使用有界最近事件与按 kind 索引；60 天×5 seed 本地压力测试；监控 RSS、事件数与 checkpoint 大小 |
| 提交网络或压缩包故障 | 9/13 完成可恢复封包与校验和；两台环境解压复跑；保留提交回执和备用网络窗口 |

## 提交前唯一判定表

- AgentSociety² 工作区可由压缩包独立恢复，且正式 run 的 platform/version/config hash 可查。
- 每个报告数字可追溯到 Replay 数据集、分析脚本版本和 run 列表。
- 主结论不依赖本地评分策略正控，也不依赖处理后的候选快照。
- 主要/次要/稳健性分析与缺失、fallback、追加 seed 规则在查看正式结果前固定。
- 图表展示原始 seed 点和不确定性，不用 pooled agent-day 误导精度。
- 素材均在 `ATTRIBUTION.md` 中具 CC0/CC-BY 可验证来源。
- 团队人数、报告、代码、工作区压缩包与提交回执均满足赛事要求。
- 团队在提交前人工确认作者署名与贡献、资金/利益冲突、生成式 AI 使用披露，以及赛事官网的最终版本规则。
