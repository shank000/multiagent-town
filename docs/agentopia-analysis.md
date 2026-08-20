# Agentopia 论文解析与 M3 关系系统映射

> 论文：**Agentopia: Long-Term Life Simulation and Learning in Agent Societies**（arXiv: 2606.07513）
> 团队：miHoYo / Anuttacon（蔡浩宇），Xintao Wang 等 13 位作者
> 规模：3 个世界 × 100 agents × 10 个模拟年
> 解析日期：2026-08-20（全文 HTML 已读至附录 D.3；案例研究 E 与 D.4-D.12 仅有目录条目，未能获取）

## 1. 论文概要

Agentopia 把「AI 社会」当作长期生命模拟 + 学习系统：100 个 agent 在同一世界生活 10 个模拟年，关系、地位、幸福感随时间自然演化，并有一个外部计算的 **life reward**（人生成就）作为学习信号。它不是单次对话 demo，而是把「关系与人生轨迹」本身变成可测量、可优化的对象。

## 2. 机制清单 → 我们的落地建议（M3）

| # | 论文机制 | 论文做法 | 我们的落地建议（映射现有架构） |
|---|---|---|---|
| 1 | **关系 = 记忆** | 无显式关系边；每个角色一个自由文本 `characters/<who>.txt`，单向记录对他人的看法 | `relationships.knowledge_json` 已有该字段——保持「单向、按对话/互动增量更新」，不建双向强一致边 |
| 2 | **双维关系** | affection（喜欢/温暖）+ respect（尊重/能力），源自 Warmth-Competence 模型 | 把 spec 的单一 `affinity` 拆成 `affection` 与 `respect` 两列；对话引擎结束摘要时由 LLM 输出 `{affectionDelta, respectDelta}` 更新 |
| 3 | **社会地位 = Weighted PageRank + 互惠** | 谁被高地位者重视，谁的 PageRank 就高 | M3 事件广播后按「声望图」计算 4 agent 的地位榜（PageRank 一次/游戏日）；「互惠加成」= 双向高 affection 加权 |
| 4 | **fulfillment 四维 + 衰减** | mood / material / social / esteem，每周衰减（Maslow 分层） | agents 表加 `fulfillment_json`；周衰减 + 事件更新（对话+social、派对+social/esteem）；心智面板展示 |
| 5 | **life reward = 社会 + 主观 + 经济** | 外部计算（非 agent 自报） | M4 评估期引入：社会分（PageRank 相关）、主观分（反思 insight 情绪词）、经济分（职业相关事件） |
| 6 | **公开/偶遇活动** | 事件广播驱动社交 | 直接对应 M3 的「派对/选举」广播机制（我们已有 POST /api/broadcast 先行版 + 全员记忆写入） |
| 7 | **roleplay 原则过滤** | 16 条原则，最关键：「自然关系推进」「选择性披露」 | 对话提示词加 2 条约束：关系推进要渐进（每次摘要只动 ±1-2 分）；秘密按关系强度选择性透露 |
| 8 | **记忆 read-before-write** | 写记忆前先读旧记忆，保持一致性 | MemoryWriter 写「他人看法」类记忆时，先 retrieve 该人旧记忆，合并而非追加（避免矛盾） |
| 9 | **人格 10 维向量** | 性格可数值化，驱动行为差异 | 现有 `traits` 扩展为 10 维（开放性/尽责/外向/宜人/神经质 + 5 项自定义），决策提示词注入数字画像 |
| 10 | **社会评估指标集** | 关系密度/社群分化/地位流动性等 | M3 验收指标：关系密度（每对 agent 平均 affection 绝对值）、地位流动性（排名变化）、信息传播速度 |

## 3. M3 设计启示优先级

1. **P0（最值得抄）**：双维关系（affection/respect）+ 对话摘要增量更新 + 渐进原则——低成本、直接让「关系变化」可观察。
2. **P0**：公开活动广播（对应派对/选举验收）+ 全员记忆写入（已具雏形）。
3. **P1**：fulfillment 四维 + 周衰减——给「幸福感」一个可展示的仪表。
4. **P1**：Weighted PageRank 地位榜——4 agent 规模也可见（周岚的信息枢纽地位会自然浮现）。
5. **P2**：life reward、人格 10 维、read-before-write——M4 评估期引入。

## 4. 评估指标建议（M3 自动化）

- 关系密度：Σ|affection| / 对数，随天数单调上升且不爆炸（-1..1 区间夹紧）
- 地位流动性：连续两日 PageRank 排名的肯德尔 τ（<1 说明不僵化）
- 信息传播：seeded 信息 N 小时内知晓人数（沿用 spec 10.1）
- 关系一致性：访谈「你觉得 X 怎么样」与 affection 符号一致率 > 80%

## 5. 引用信息

- Xintao Wang et al., *Agentopia: Long-Term Life Simulation and Learning in Agent Societies*, arXiv:2606.07513, 2026.
- 注意：arXiv 元数据未标注许可证；本项目仅作学术引用与机制参考，不复制其文本/代码/数据。

## 6. 无法获取的部分（诚实说明）

- 案例研究（附录 E）与 D.4-D.12 仅存目录条目（HTML 渲染截断）；
- 论文无显式谣言/选举机制——信息传播靠 contact + 选择性披露隐式发生（最接近选举的是「年度职位申请」）；我们的 M3 仍按 spec 设计显式广播。
