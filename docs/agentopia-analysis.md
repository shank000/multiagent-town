# Agentopia 论文解析与 M3 关系系统映射

> 论文：**Agentopia: Long-Term Life Simulation and Learning in Agent Societies**（arXiv: 2606.07513）
> 团队：miHoYo / Anuttacon（蔡浩宇），Xintao Wang 等 13 位作者
> 规模：3 个世界 × 100 agents × 10 个模拟年
> 解析日期：2026-08-20（全文 HTML 已读至附录 D.3；案例研究 E 与 D.4-D.12 仅有目录条目，未能获取）

## 1. 论文概要

Agentopia 把「AI 社会」当作长期生命模拟 + 学习系统：100 个 agent 在同一世界生活 10 个模拟年，关系、地位、幸福感随时间自然演化，并有一个外部计算的 **life reward**（人生成就）作为学习信号。它不是单次对话 demo，而是把「关系与人生轨迹」本身变成可测量、可优化的对象。

## 2. 机制清单 → 我们的落地建议（M3）

### 核心哲学：关系 = 记忆，而非显式边
论文不显式存关系：每个 agent 自管自由文本 `characters/<who>.txt`（对他人的认知），**单向、可不对称**。落地：我们的 `relationships.knowledge_json` 直接充当该文件——对话后由 MemoryWriter 向**双方** knowledge_json 追加「我对 TA 的认知」叙事层；数值 affinity 只是其低维投影；A→B 与 B→A 分存。

### 双维关系：affection + respect
基于 Warmth-Competence 模型，对社交圈每人打 喜欢/尊重 两个 0-100 分（私下），构成两张有向加权图。落地：把单一 `affinity` 拆为 `affection` 与 `respect` 两列（-1..1）；affection 由陪伴/亲密度驱动，respect 由能力/成就/助人驱动；二者可分叉（「讨厌但尊重」）。

### 社会地位 = Weighted PageRank + 互惠加成
`S'_i = Σ_j w_ji·(1+α·w_ij)·S_j`（我重视的人重视我更值钱，Sociometer 理论）。落地：每日对两张关系图各算一次 PageRank → `social_standing`，作为传闻可信度与选举权重输入；25 节点计算成本可忽略。

### fulfillment 四维 + 每周衰减（动态动机）
mood/material/social/esteem 各 0-100；每周 mood/social/esteem 衰减 15%，material 不衰减——形成「必须持续社交」的内在动机环。落地：needs 状态表；衰减值喂给 importance 打分（未满足需求 → 记忆更重要）；低 fulfillment 触发生成「求安慰/求认可」计划。

### 生命奖励 = 社会 + 主观 + 经济（外部计算）
`r = λ_social·z_social + λ_subj·z_subj + λ_econ·z_econ`（z-score 归一，非自报）。落地：作评估指标用——先取 social+subjective 两维做「福祉分数」用于回归测试；life reward 的拒绝采样训练思路可借鉴为「筛选高质量记忆/exemplar」（我们不改模型权重）。

### 事件广播 = 公开活动 + 偶遇
公开活动由环境模型生成（名称/描述/时间/资格名单），agent 按兴趣独立报名；偶遇为「当天空闲」者随机配对撮合。落地：直接对应 M3 的派对/选举——新增轻量 TownModel 生成活动 → 按人格/兴趣匹配报名 → 报名足额则成行；偶遇用于扩充关系网。

### 环境模型（无状态 LLM 编排器）
一个 stateless LLM 承担：行为反馈、可行性判定、选下一说话人、生成公开/偶遇活动、职位申请排名、响应过滤。落地：新增轻量 `TownModel`（复用现有 LLM，独立 prompt），统一生成广播事件、解决排期冲突、给活动结果环境反馈、过滤违规响应。

### 16 条 roleplay 原则过滤（最值得抄）
逐条检验每个 agent 响应，违规即过滤。最相关两条：**自然关系推进**（陌生人→密友要有过程 → affinity 每次变动设上限、需多轮累积）；**选择性披露**（陌生人不掏心窝 → 关系越浅，传闻泄露越少）。其余：无幻觉、角色一致性、认知边界、情绪连续性、实质对话、独立自我、口语化。落地：做进 DialogueEngine 后置 guardrail + importance 启发式。

### 记忆文件 read-before-write
`general.txt`(自传) / `characters/<who>.txt`(他人认知) / `others/<topic>.txt`(话题)；读后才准写。落地映射：general→自传记忆、characters→relationships.knowledge_json、others→话题记忆；我们已有的「改写基于旧摘要」模式即 read-before-write。

### 人格数值化（性格多样性）
9 维天赋 + 10 维人格（confidence/control/curiosity/empathy/extraversion/feeling/intuition/judging/patience/responsibility）+ skills + core_motivation/values/conflicts。落地：给每个 NPC 加 10 维人格向量（profile），用于 prompt 注入、传闻传播偏见（高 extraversion 爱传、低 honesty 易扭曲）、活动报名兴趣匹配、affinity 敏感度。

### 社会评估指标集（M3 验收直接抄）
`n_liked_by / n_likes / n_respected_by / n_respects / n_mutual_like / n_mutual_respect`（≥60 计一次）、`active/passive_contacts`、`joint_proposed / joint_participated / public_participated`、`fulfillment_*`、`skill_improvement_count`。`n_mutual_like` 与 `n_mutual_respect` 是「关系网络真的长出来」的黄金指标。

## 3. M3 设计启示优先级

1. **P0**：双维关系（affection+respect）+ PageRank 声誉——替换单薄 affinity，收益最大代价最小。
2. **P0**：「自然关系推进 + 选择性披露」guardrail——决定 affinity 更新速率与传闻质量，防关系/谣言突变。
3. **P0**：公开/偶遇活动机制（事件广播）——直接复用为派对/选举（SocialTicker 可扩展）。
4. **P1**：fulfillment 四维 + 衰减——给 importance 与计划注入动态动机，25 agent 不呆滞。
5. **P1**：关系=记忆+显式边混合——与现有 relationships 表无缝衔接。
6. **P1**：人格 10 维向量——低成本性格多样性。
7. **P2**：社会指标集、life reward 评估——M4 评估期。

## 4. 评估指标建议（M3 自动化）

- 关系网络：n_mutual_like / n_mutual_respect、入度均值与方差（识别明星与孤岛）、PageRank 声誉基尼系数
- 信息传播：传闻传播深度/覆盖率/时延、失真率（原文 vs 末次转述语义距离）、被选择性披露截断比例
- 事件广播：活动成行率、报名→参与转化、跨小圈子参与率（打破信息茧房）
- 动机/福祉：四维 fulfillment 周均值趋势、衰减后恢复速度
- 行为相关性：行为指标与福祉 Pearson 相关（验证「多社交→高福祉」因果链）

## 5. 引用信息

- Xintao Wang et al., *Agentopia: Long-Term Life Simulation and Learning in Agent Societies*, arXiv:2606.07513, 2026.
- 注意：arXiv 元数据未标注许可证；本项目仅作学术引用与机制参考，不复制其文本/代码/数据。

## 6. 无法获取的部分（诚实说明）

- 案例研究（附录 E）与 D.4-D.12 仅存目录条目（HTML 渲染截断）；
- 论文无显式谣言/选举机制——信息传播靠 contact + 选择性披露隐式发生（最接近选举的是「年度职位申请」）；我们的 M3 仍按 spec 设计显式广播。
