# 会话存档 · Session Archive

> 本文件完整记录本次会话内容，与项目文件一同归档于 `multiagent-town/`。

## 会话元信息

| 项 | 值 |
|---|---|
| 模型 | deepseek-v4-pro（DeepSeek Harness 编码代理） |
| 主题 | 斯坦福小镇式多智能体交互系统：调研 + 技术方案 |
| 产物 | `docs/ai-town-design.md`（技术方案文档，开发蓝图） |
| 状态 | 调研与技术方案已完成，待决定是否启动 M0 骨架开发 |

---

## 对话记录

### ① 用户：你现在是什么模型？

**回答**：我是 deepseek-v4-pro 模型，运行在 DeepSeek Harness 环境中，作为编码代理工作。

### ② 用户：我想做一个类似斯坦福小镇的多智能体交互系统，帮我深入分析并调研一下

**调研报告全文**：

---

#### 0. 一句话结论

这类系统的本质是 **「世界模拟引擎（时间/空间/对象）+ 认知架构（记忆→反思→规划）+ LLM 编排 + 前端呈现」** 四层叠加。原论文最值钱的不是"画小人"，而是那套认知栈；2023 年的官方工程已经老旧，今天的正确姿势是参考其架构，在 **a16z AI Town** 这类现代骨架上起步，或者自研内核。

#### 1. 起源与核心思想

- **论文**：Generative Agents: Interactive Simulacra of Human Behavior（Park et al., Stanford + Google Research, 2023.4，arXiv:2304.03442）
- **规模**：25 个 agent 在名为 Smallville 的小镇自主生活两天，涌现出信息扩散（Isabella 的派对口口相传）、关系网络、协同行动（选举候选协调人）、规律作息等社会行为。
- **设计目标不是"智能"，而是 believability（可信度）**：行为"看起来像真人"。论文的评估方式是访谈 + 25 道自省/回忆/计划/反应题 + 受控对照实验。
- 三个真正的突破点：**观察→记忆→反思→规划的闭环**、**长期记忆的检索机制**、**社会行为的涌现**。

#### 2. 认知架构（论文核心）

**2.1 记忆流 Memory Stream**
- 每条 observation = {自然语言描述, 创建时间戳, 最近访问时间戳}；
- 每个 agent 每天产生**数百条**记忆，两天就是数千条，全塞进 prompt 不可能 → 必须检索。

**2.2 检索 Retrieval（三种打分加权）**
```
score = α_recency · recency + α_importance · importance + α_relevance · relevance
```
- recency：指数衰减（论文衰减因子 ≈ 0.995 / 游戏小时）；
- importance：记忆写入时就由 LLM 打 1–10 分（"这事会不会长期重要"），缓存复用；
- relevance：embedding 余弦相似度，min-max 归一化；
- 取 top-k（论文约 10~20 条）拼进 prompt。

**2.3 反思 Reflection（把记忆提炼成抽象认知）**
- 触发：最近事件 importance 之和 > 阈值（150）；
- 步骤：基于最近 100 条记忆生成 3 个问题 → 检索证据 → 生成 5 条 insight → 挂上反思树；
- 低层 insight 可继续成为高层反思的素材，形成金字塔。

**2.4 规划 Planning（自上而下拆解）**
- 每天早晨生成 broad plan → 递归拆成 5~8 小时段 → 每小时 agenda 拆成 5~15 分钟的具体动作；
- 规划时注入：persona 摘要 + 前一天总结 + 当日检索的记忆；
- 执行中遇突发事件 → re-planning 改计划。

**2.5 对话与行为落地**
- 对话是独立生成循环：双方围绕各自目标产出 utterances；对话内容作为 observation 写回双方记忆流——这正是谣言/信息传播的机制，也是污染源；
- 动作以自然语言描述 + 结构化动作树落到游戏引擎。

#### 3. 原版工程架构（joonspk-research/generative_agents）
- 双服务器："reverie" 环境服务器（Phaser 前端 + 模拟 tick + BFS 寻路 + 碰撞）+ "backend" LLM 服务器（Flask/Django）；
- Tiled 瓷砖地图 + 树状 world object schema + agent 碰撞排队；
- 游戏内加速时间；用户可扮演一个 agent，或用上帝视角查看任意 agent 的记忆/计划（体验精髓）；
- 缺点：学术味重、耦合紧、绑定 2023 年的 OpenAI API、无成本治理、部署麻烦 → 不建议直接魔改，建议参考架构重写或 fork 现代实现。

#### 4. 开源实现对比

| 项目 | 特点 | 适合谁 |
|---|---|---|
| generative_agents（官方） | 论文原版，Python + Phaser | 研究复现 |
| a16z AI Town | Convex 实时后端 + Pinecone 向量 + Phaser 游戏前端，多 LLM 提供商、MIT、一键部署，引擎 cron 循环 | 最快起步/产品化 |
| GenerativeAgentsCN | 官方重构 + 深度汉化，支持通义/本地模型，面向二次开发 | 中文社区定制 |
| stanford_town | llama2 70B 本地化移植 | 本地模型研究 |
| LangChain / LlamaIndex 教程 | 认知架构的教学实现 | 学原理 |
| CAMEL OASIS | 百万级 agent 社交媒体模拟，Redis + 动态激活/休眠，环境可与现实互联 | 规模化研究 |
| MetaGPT / AgentSociety | 角色 SOP 流水线 / 大规模社会仿真框架 | 协作型而非社交型，可借鉴消息机制 |

#### 5. 关键难点（踩坑清单）

1. **成本爆炸**：每个 tick × 每个 agent 多次 LLM 调用。参考量级：原版 2 天 25 agent，GPT-3.5 约数百美元级，GPT-4 达数千美元级。对策：例行决策用小模型/本地模型、反思对话用大模型，加缓存、批量反思、上下文压缩、token 预算。
2. **人格漂移**：长期记忆检索偏差会让 agent 行为走样 → persona 锚定 + 摘要注入。
3. **对话污染**：对话细节原样写回记忆流会膨胀失真 → 对话先摘要再入记忆，并限流。
4. **检索质量**：纯 embedding 相关度不够，recency/importance 权重必须实测调优；中文场景 embedding 要选 bge-m3 / text-embedding-3 并做中文评估。
5. **幻觉与越界**：agent 走出地图、行为越界 → 动作 schema 约束 + 结构化输出（JSON schema / function calling）。
6. **时间与并发**：LLM 秒级延迟 vs 游戏 tick → 异步行动队列 + "思考中"状态；实时 vs 加速时间模型要早定。
7. **评估难**：believability 靠人评；建议同时建自动化指标（计划完成率、访谈一致性、行为合法性）。
8. **伦理**：论文有专门 ethics 声明；模拟真人、传播虚假信息有风险，产品化要注意。

#### 6. 自研技术方案建议（分层）

```
呈现层    Phaser 3 / PixiJS 2D 前端（MVP 可先做纯卡片/聊天 UI）
认知层    prompt 编排：观察→检索→规划→执行→反思，结构化输出
记忆层    事件日志(DB) + 向量检索 + 反思树
世界层    地图/对象/agent 状态、时间引擎、tick 循环、寻路碰撞
基建      LLM 网关(多模型路由/成本计量) + 实时通道 + 持久化/回放
```
- 后端：Python FastAPI（生态好）或 TypeScript（Convex 实时性好）；小规模 SQLite + sqlite-vec/Chroma，规模化 pgvector/Qdrant/Pinecone；
- LLM：中文场景 DeepSeek / Qwen 性价比高；本地可用 vLLM 跑 Qwen 中尺寸；
- 交互：玩家控制一个 agent + 上帝视角查看任意 agent 的心智状态。

#### 7. 建议路线图

- **P0 验证（1~2 天）**：fork AI Town 或跑通 GenerativeAgentsCN，3~5 个 agent，把 LLM 换成 DeepSeek/Qwen，实测成本与效果；
- **P1 自研内核（1~2 周）**：世界状态 + 时间循环 + 记忆流/检索/反思/规划，终端或极简 Web UI；
- **P2 空间与呈现**：2D 地图、移动寻路碰撞、物品交互、对话 UI；
- **P3 社交涌现**：关系网络、信息扩散、事件广播（派对/选举）、性格多样性；
- **P4 规模化**：多模型分层、成本治理、持久化/回放、自动化评估、可选真人接入。

---

### ③ 用户选择：出完整技术方案文档

**回答要点**：已在工作区生成 `docs/ai-town-design.md`（技术方案文档，开发蓝图），包含：
- 五层架构与核心数据流；
- 技术选型表（TypeScript + Node、SQLite→pgvector、bge-m3、Phaser 3 + React、DeepSeek/Qwen 分层）；
- 完整 SQL DDL 与 persona JSON 结构；
- 五大核心流程（tick 主循环、感知→记忆、检索评分、规划、反思、对话）；
- 9 个 Prompt 模板；
- LLM 网关设计与成本预算（每 agent 每小时 35k~50k token；25 agent 单游戏日 DeepSeek 档位约 ¥40~90）；
- REST/WS/内部模块接口；
- 前端呈现设计；
- 评估方案（自动化指标 + 访谈）；
- M0~M4 分阶段实施计划与验收标准；
- 8 项风险与对策。

**关键设计决策**：
1. 时间采用 60x 加速（原版路线，社会行为才可观察）；
2. 对话摘要回写记忆流而非原样回写（修原版污染问题）；
3. LLM 全部异步、结构化输出加对象树校验（治幻觉越界）；
4. 不引 LangChain 等重框架，直接走 OpenAI 兼容 API 以便计量。

### ④ 用户：把这个会话以及其所产生的项目文件放入此目录（dsh）中的新文件夹中，新文件夹命名为"multiagent-town"

**执行**：创建 `multiagent-town/`，项目文件移入其中，并生成本会话存档（SESSION.md）与 README.md。

---

## 下一步（待用户决定）

✅ **M0 骨架已完成**（4 个 agent：林晚晴/陈默/沈屿/周岚）。40 个测试全绿，验收通过：4 agent 虚拟时钟连续跑 1 游戏日不崩、日志可回放（`pnpm town` 观察、`pnpm replay --day 1` 回放）。实现经 10 任务逐项评审 + 终审，已合并回 main。

下一步按 `docs/ai-town-design.md` 的 **M1 认知核心** 开工：记忆流/检索/打分、日计划/分解/执行、反思树、对话摘要回写；验收标准为计划-执行-反思闭环跑通、访谈能答出"昨天做了什么"。
