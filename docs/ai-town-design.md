# 多智能体小镇 · 概念设计参考

> 文档角色：机制与规模扩展的概念参考。当前可执行架构、命令和 API 以 `docs/ARCHITECTURE.md` 为准，正式实验合同以 `platform/agentsociety2/` 与 `docs/competition-execution-plan.md` 为准。
> 研究规模：本地可视化世界使用 6 位常驻居民；AgentSociety² 正式矩阵使用 24–30 位 agent。
> 参考：Generative Agents 论文（arXiv:2304.03442）、joonspk-research/generative_agents、a16z-infra/ai-town。

---

## 1. 项目概述

### 1.1 定位
一个**中文场景**的、可二次开发的"AI 小镇"：agent 具有记忆、反思、规划能力，在小镇地图上自主生活；系统提供 2D 呈现与"上帝视角/玩家扮演"两种交互方式。

### 1.2 核心目标（v1）
- 8~25 个 agent 连续运行 ≥ 1 个游戏日而不崩坏；
- 记忆流 / 检索 / 反思 / 规划四大认知机制全部落地；
- 涌现至少两类社会行为：**信息扩散**（谣言/新闻传播）与**关系变化**；
- 玩家可扮演任意 agent 或上帝视角查看任意 agent 的心智状态；
- 单游戏日成本可控（目标：DeepSeek 档位 ≤ ¥100）。

### 1.3 非目标（v1 不做）
- 不做 3D 渲染、不做语音、不做多模态；
- 不做 LangChain/LlamaIndex 级通用 agent 框架（自写轻量编排）；
- 不做万人级规模（那是 OASIS/AgentSociety 的路线，架构不同）。

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────┐
│ 呈现层  Phaser 3 地图场景 + React 心智面板 + WS 实时通道      │
├─────────────────────────────────────────────────────────┤
│ 认知层  Planner（日计划/分解/re-plan）+ ActionExecutor       │
│         + DialogueEngine（对话循环）                        │
├─────────────────────────────────────────────────────────┤
│ 记忆层  MemoryStore（记忆流+重要性缓存）+ Retrieval（检索评分） │
│         + ReflectionTree（反思树）+ MemoryCompactor（压缩）   │
├─────────────────────────────────────────────────────────┤
│ 世界层  TimeEngine（时间引擎）+ WorldMap（地图/寻路/碰撞）      │
│         + ObjectTree（世界对象树）+ EventBus（事件广播）       │
├─────────────────────────────────────────────────────────┤
│ 基建    LLMGateway（多模型路由/重试/计量/缓存）+ SQLite/PG      │
│         + 向量索引（sqlite-vec/pgvector）+ 持久化/回放          │
└─────────────────────────────────────────────────────────┘
```

**核心数据流（每个 agent 每秒都在跑）：**

```
世界事件 ──感知──▶ Observation ──打分──▶ 记忆流 ──检索──▶ 决策上下文
                                                        │
      游戏引擎 ◀──执行── 结构化 Action ◀──规划/执行 LLM ◀─┘
                                          ▲
   反思树 ◀── insight ◀── 反思 LLM ◀── 重要性累计超阈值触发
```

---

## 3. 技术选型

| 层 | 主选 | 理由 | 备选 |
|---|---|---|---|
| 语言/后端 | **TypeScript + Node.js (Fastify)** | 与前端同构、WS 实时简单、AI Town 验证过 | Python FastAPI（LLM 生态好） |
| 数据库 | **SQLite**（dev）→ **Postgres + pgvector**（prod） | 单机起步零运维，pgvector 平滑迁移 | Convex（托管实时） |
| 向量索引 | **sqlite-vec**（dev）/ **pgvector**（prod） | 免额外服务 | Qdrant / Pinecone |
| Embedding | **bge-m3**（中文强，1024 维） | 中文检索质量 | text-embedding-3-small |
| 前端 | **Phaser 3 + React + Vite**，地图用 **Tiled** | 原版与 AI Town 同路线，2D 生态成熟 | PixiJS 自绘 |
| LLM（大模型层） | **DeepSeek-chat**（默认）/ Qwen-max | 中文强、便宜、OpenAI 兼容 | GPT-4o-mini |
| LLM（小模型层） | Qwen-14B / DeepSeek 蒸馏小模型（本地 vLLM 或 API） | importance 打分、例行决策 | 同一 API 但低档模型 |
| LLM 调用方式 | **直接 fetch OpenAI 兼容 API**，不引重框架 | 可控、可计量 | LangGraph（仅复杂编排时） |
| 实时通道 | **WebSocket**（事件 + 状态增量） | 简单 | Convex/Liveblocks |
| 进程模型 | 单进程起步，世界循环 + LLM 异步池 | 25 agent 规模足够 | 多进程（≥100 agent 再拆） |

**时间模型（关键决策）**：默认**加速时间**——现实 1 秒 = 游戏 1 分钟（60x，可配置）。理由：原版演示即加速时间，否则社会行为太慢无法观察；实时模式（AI Town 路线）作为后续选项。

---

## 4. 核心数据模型

### 4.1 SQL DDL（SQLite 版，PG 版仅类型微调）

```sql
-- 世界元信息（时间、速度、运行状态）
CREATE TABLE world_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 智能体
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,          -- uuid
  name          TEXT NOT NULL,
  persona_json  TEXT NOT NULL,             -- 见 4.2
  home_object   TEXT,                      -- 家（object_id）
  state_json    TEXT NOT NULL DEFAULT '{}',-- 运行时状态（位置/心情/状态机）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 记忆流（核心表）
CREATE TABLE memories (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  kind              TEXT NOT NULL CHECK (kind IN
                     ('observation','reflection','dialogue_summary','plan','insight')),
  content           TEXT NOT NULL,         -- 自然语言，≤200 字
  importance        REAL NOT NULL DEFAULT 5, -- 1~10，写入时 LLM 打分并缓存
  created_game_time INTEGER NOT NULL,      -- 游戏内分钟（自纪元起）
  last_access_game_time INTEGER NOT NULL,
  source_event_id   TEXT,
  embedding         BLOB,                  -- bge-m3 1024 维 float32
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_mem_agent_time ON memories(agent_id, created_game_time);
CREATE INDEX idx_mem_agent_imp   ON memories(agent_id, importance);
-- dev: sqlite-vec 虚拟表 vec_memories(embedding)；prod: pgvector ivfflat/hnsw

-- 反思树
CREATE TABLE reflections (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  parent_id     TEXT,                      -- NULL=根反思
  depth         INTEGER NOT NULL DEFAULT 0,
  questions_json TEXT NOT NULL,            -- 触发时生成的 3 个问题
  insights_json TEXT NOT NULL,             -- 5 条洞察
  evidence_ids_json TEXT NOT NULL,         -- 支撑记忆的 id 列表
  trigger_score REAL NOT NULL,             -- 触发时的重要性累计
  created_game_time INTEGER NOT NULL
);

-- 计划
CREATE TABLE plans (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  day           INTEGER NOT NULL,          -- 第几天
  broad_plan    TEXT NOT NULL,             -- 当天大计划（自然语言）
  hourly_json   TEXT NOT NULL,             -- [{hour, agenda, actions:[...]}]
  status        TEXT NOT NULL DEFAULT 'active', -- active|done|aborted
  created_game_time INTEGER NOT NULL
);

-- 事件日志（世界事实 + 回放）
CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,             -- move|chat|interact|broadcast|system|player
  actor_id      TEXT,
  target_ids_json TEXT,
  description   TEXT NOT NULL,             -- 第三人称客观描述
  location      TEXT,
  game_time     INTEGER NOT NULL,
  payload_json  TEXT
);
CREATE INDEX idx_events_time ON events(game_time);

-- 世界对象树（房间/家具/设施）
CREATE TABLE objects (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT,                         -- 树：小镇→建筑→房间→家具
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,                -- town|building|room|furniture|facility|zone
  x REAL, y REAL, w REAL, h REAL,          -- 地图坐标（像素/瓦片）
  state_json TEXT
);

-- 关系
CREATE TABLE relationships (
  id         TEXT PRIMARY KEY,
  agent_a    TEXT NOT NULL,
  agent_b    TEXT NOT NULL,
  knowledge_json TEXT,                     -- 双方对彼此的认知（双向）
  affinity   REAL NOT NULL DEFAULT 0,      -- -1..1 好感度
  updated_game_time INTEGER NOT NULL,
  UNIQUE(agent_a, agent_b)
);

-- 对话消息
CREATE TABLE messages (
  id        TEXT PRIMARY KEY,
  event_id  TEXT,
  from_agent TEXT, to_agent TEXT,
  content   TEXT,
  game_time INTEGER NOT NULL
);
```

### 4.2 persona_json 结构

```json
{
  "name": "林晚晴",
  "age": 32,
  "occupation": "咖啡馆老板",
  "background": "五年前从大城市回到小镇开了间咖啡馆，喜欢观察客人。",
  "traits": ["温和", "健谈", "有点理想主义"],
  "daily_routine_hint": "9 点开门，下午常去书店，晚上散步",
  "goals": ["把咖啡馆经营成小镇的公共客厅", "写一本关于小镇人物的小说"],
  "relationships_hint": { "陈默": "老同学，关系不错" },
  "speech_style": "语气轻柔，爱用比喻",
  "secrets": ["暗恋着常来喝咖啡的画家"]
}
```

---

## 5. 核心流程设计

### 5.1 世界主循环（tick loop）

```
tick 间隔 0.5s（现实），每次推进 game_minutes_per_tick 游戏分钟（默认 0.5 → 60x）
for agent in agents:
  executor.progress(agent)          # 状态机推进
world 广播: world:tick / 位置变化 / 状态变化（节流）
```

**Agent 状态机**：

```
idle ──需要决策──▶ thinking（异步 LLM，现实 1~10s，显示"思考中"）
thinking ──产出 Action──▶ moving（A* 寻路）
moving ──到达──▶ acting（执行持续 N 游戏分钟，如"煮咖啡 30 分钟"）
acting ──完成──▶ idle
任意状态 ◀──被搭话/突发事件── re-plan 决策
```

要点：**LLM 调用全部异步**，绝不阻塞 tick；一个 agent 同时最多 1 个 LLM 决策在飞。

### 5.2 感知 → 记忆（Perception → Observation）

每个 tick，对每个 agent 收集其"可感知事件"：
- 同房间/视野半径（如 3 瓦片）内其他人的动作；
- 与自己相关的事件（被搭话、收到消息）；
- 系统广播（天气、钟声、新闻）。

事件 → 转成**第一人称 observation**（如 `“14:30，林晚晴在咖啡馆擦杯子时，看到常客陈默走进来。”`）→ 异步调小模型打 importance 分 → 写入记忆流 + 向量索引。

### 5.3 检索（决策前的记忆召回）

需要 LLM 决策时（规划/执行/对话），按评分取 top-k=20 条：

```
score = α_recency·recency + α_importance·importance + α_relevance·relevance
recency    = 0.995^(now - last_access_game_time)        # 指数衰减
importance = 写入时缓存的 1~10 分
relevance  = min-max 归一化后的 embedding 余弦相似度
初始权重建议：α_recency=0.25, α_importance=0.35, α_relevance=0.40（必须实测调优）
```

检索后按时间排序拼入 prompt（最近的在前）。另取 3 条**最近反思 insight** 作为"自我认知"注入。

### 5.4 规划（Planning）

```
每天 5:00（游戏内）醒来时：
  输入 = persona 摘要 + 前一天总结 + 当天检索记忆
  输出 = broad plan（一段话）
每 1 小时：
  输入 = broad plan + 当前状态 + 检索记忆
  输出 = 该小时 agenda，拆成 5~15 分钟粒度动作
  写入 plans.hourly_json
触发 re-plan 的条件：
  被搭话且对话重要 / 发生广播大事件（派对、事故）/ 连续 3 个动作执行失败
```

### 5.5 执行（Action Executor）

每 5~15 游戏分钟（或上一动作完成时）请求一次决策，输出**严格 JSON**：

```json
{
  "thought": "该准备开店了，先去柜台把咖啡机打开",
  "action": { "type": "interact", "target": "object:cafe_counter", "verb": "打开咖啡机" },
  "duration_minutes": 10,
  "speak": null
}
```

- 动作类型：`move_to` / `interact` / `chat` / `idle` / `broadcast`；
- target 必须存在于对象树，由**校验器**拦截幻觉（校验失败 → 重试一次 → 降级为 `idle`）；
- 执行产生事件 → 广播 → 成为他人的 observation。

### 5.6 反思（Reflection）

```
触发：自上次反思起新记忆 importance 之和 > 150
步骤：
  1. 取最近 100 条记忆，LLM 生成 3 个开放问题（如"林晚晴对画家反复提到什么？"）
  2. 每个问题用检索召回证据（≥5 条）
  3. LLM 基于证据生成 5 条 insight（≤1 句话，禁止编造证据外内容）
  4. 写入 reflections（挂父节点），insight 也作为记忆写入记忆流
  5. 已有 insight 可再次参与高层反思（depth+1）
```

### 5.7 对话（DialogueEngine）

```
发起：A 移动到 B 附近并选择 chat，或 B 主动搭话
循环：
  1. 双方各自组装上下文（对方是谁 + 关系认知 + 检索到的相关记忆 + 各自当前目标）
  2. 轮流生成 utterance（2~4 句以内），最多 12 轮
  3. 每轮判断是否结束（话头尽了/有事要离开）
结束：LLM 生成 ≤100 字对话摘要 → 以 dialogue_summary 写回**双方**记忆流
     （原样回写会污染记忆，摘要回写是改进点）
重要信息（如受邀参加派对）额外以 insight 级 importance 写入，保证传播。
```

---

## 6. Prompt 模板库

> 通用约定：temperature 0.7（对话 0.9）；全部要求严格 JSON 输出；每个模板带 1~2 个 few-shot 示例（此处略示例，实现时补）。`{{}}` 为变量。

### 6.1 观测重要性打分（小模型，高频）
```
系统：你是记忆筛选器。给智能体的一条新记忆的重要性打分 1~10。
打分标准：1~3 日常琐事；4~6 有信息量的事件；7~8 与目标/人际相关；9~10 改变人生的事件。
智能体：{{persona_summary}}
记忆：「{{observation}}」
只输出 JSON：{"importance": <int>}
```

### 6.2 每日计划生成（大模型，每天 1 次/agent）
```
系统：你是 {{persona_summary}}。你在一个 2D 小镇生活，需要安排今天。
提供：当前时间、你昨天做过什么、最近发生的事、你关心的事。
最近记忆（按时间）：
{{top_memories}}
自我认知（反思）：
{{recent_insights}}
生成你今天的大计划（3~5 句，覆盖上午/下午/晚上，自然语言，不要列表）。
只输出 JSON：{"broad_plan": "..."}
```

### 6.3 每小时计划分解（大模型，每小时 1 次/agent）
```
系统：你是 {{persona_summary}}。当前 {{game_time}}，你在 {{location}}。
当天大计划：{{broad_plan}}
当前状态：{{state_summary}}（包括正在做的事）
相关记忆：{{top_memories}}
把接下来 1 小时拆成 5~15 分钟的具体动作清单，动作必须是在小镇可执行的
（地点用对象名，如 "咖啡馆柜台"、"中央广场"）。
只输出 JSON：{"agenda": [{"time": "14:00", "action": "...", "location": "..."}]}
```

### 6.4 动作决策（小/大模型，每 5~15 游戏分钟/agent，最高频）
```
系统：你是 {{persona_summary}}。当前 {{game_time}}，你在 {{location}}，正在 {{current_action}}。
近期记忆：{{top_memories}}
今日计划（当前时段）：{{current_agenda}}
决定接下来 5~15 分钟做什么。若有人与你互动，优先回应。
只输出 JSON：
{"thought": "...", "action": {"type": "move_to|interact|chat|idle", "target": "<object_id或agent_id>", "verb": "..."}, "duration_minutes": <int>, "speak": null}
```

### 6.5 re-plan 判断（小模型）
```
系统：给定智能体正在执行的动作和一个突发事件，判断是否需要改变计划。
正在做：{{current_action}}　事件：{{event}}
只输出 JSON：{"replan": true|false, "reason": "..."}
```

### 6.6 反思·问题生成（大模型，触发时）
```
系统：你是 {{persona_summary}}。下面是最近发生在你身上的事（按时间）：
{{recent_100_memories}}
提出 3 个关于你自己的开放式问题（关于你的目标、人际关系、重复出现的主题）。
只输出 JSON：{"questions": ["...", "...", "..."]}
```

### 6.7 反思·洞察生成（大模型，触发时）
```
系统：你是 {{persona_summary}}。问题：{{question}}
证据（只能使用以下内容，禁止编造）：
{{retrieved_evidence}}
基于证据给出 5 条对自己的洞察，每条 ≤ 1 句，用"我"开头。
只输出 JSON：{"insights": ["...", ...]}
```

### 6.8 对话（大模型，按需）
```
系统：你是 {{persona_summary}}。你正在和 {{other_summary}} 在 {{location}} 对话。
你对他/她的了解：{{relationship_knowledge}}
与此人相关的记忆：{{related_memories}}
你现在的目标/在做的事：{{current_goal}}
规则：每次只说 1~3 句；口吻为 {{speech_style}}；不要替对方说话。
只输出 JSON：{"utterance": "...", "end_dialogue": false}
```
结束后追加：
```
总结以上对话（≤100 字，客观，含双方达成的约定/传递的信息）。
只输出 JSON：{"summary": "..."}
```

### 6.9 persona 摘要锚定（启动时生成，缓存）
```
系统：把以下人物设定压缩成 150 字以内的"我是谁"摘要，用于每次决策的锚定。
{{persona_json}}
只输出 JSON：{"summary": "..."}
```

---

## 7. LLM 网关与成本预算

### 7.1 LLMGateway 职责
```ts
interface LLMRequest {
  tier: 'small' | 'large';        // 路由依据
  template: string;               // 用于缓存与计量分组
  messages: ChatMessage[];
  jsonMode: boolean;
  maxTokens: number;
}
interface LLMGateway {
  complete(req: LLMRequest): Promise<LLMResponse>;
}
```
- 路由：small → 本地小模型（当前实现 `OllamaProvider` 的 `smallModel`，如 Qwen2.5-1.5B）或低价 API；large → DeepSeek-chat 或本地大模型（`OllamaProvider` 的 `model`，如 Qwen2.5-7B）；
- 重试（指数退避 ×2，超时 30s）；JSON 解析失败自动重试一次；
- **计量**：按 template 聚合 token 消耗与成本 → `/api/cost` 实时查看；
- **缓存**：persona 摘要等静态前缀缓存；对话摘要只算一次写两方。

### 7.2 调用量估算（每 agent 每游戏小时）

| 调用 | 频率 | 单次 token（in+out） | 模型层 |
|---|---|---|---|
| importance 打分 | ~10 次 | ~0.7k | small |
| 动作决策 | ~6 次 | ~2.5k | small（大事 large） |
| 计划分解 | ~1 次 | ~3k | large |
| 反思 | ~0.5 次 | ~5k | large |
| 对话 | 0~10 次 | ~2k | large |

**合计 ≈ 15~25 次 ≈ 35k~50k token / agent·游戏小时**

### 7.3 单游戏日成本（25 agent × 16 活跃小时 = 400 agent·小时）

- token 量 ≈ 14M~20M；
- **DeepSeek-chat**（参考价：输入 ¥2/M、输出 ¥8/M，命中缓存更低）→ **约 ¥40~90 / 游戏日**；
- GPT-4o-mini（$0.15/$0.60 每 M）→ 约 $4~9 / 游戏日；
- 若 small 层全部走**本地模型**，可再降 50%+。

### 7.4 省钱清单（按优先级）
1. importance 打分与例行动作决策下沉到本地小模型；
2. 前缀缓存命中（persona、few-shot 固定部分）；
3. 记忆压缩：超 90 天或 3000 条的旧记忆批量摘要归档；
4. 反思批量触发（每天固定 2 次窗口，代替实时触发）；
5. 对话摘要双写（只花一次生成的钱）；
6. 全局并发上限（同一时刻最多 8 个 LLM 请求，超限排队）。

---

## 8. 接口设计

### 8.1 REST API

| 方法/路径 | 说明 |
|---|---|
| `POST /api/agents` | 创建 agent，body = persona_json |
| `PATCH /api/agents/:id` | 修改 persona/位置 |
| `GET /api/agents` | 列表 + 概要状态 |
| `GET /api/agents/:id` | 完整心智状态（当前计划/动作/位置/心情） |
| `GET /api/agents/:id/memories?limit=&kind=` | 记忆流（时间线） |
| `GET /api/agents/:id/reflections` | 反思树 |
| `POST /api/events` | 注入外部事件（新闻、天气、剧情、玩家的行动） |
| `POST /api/world/control` | `{action: pause\|resume\|speed, value}` |
| `POST /api/player/:agentId/act` | 玩家扮演：输入自然语言指令 |
| `GET /api/cost` | 成本计量 |
| `POST /api/export` / `POST /api/import` | 世界快照（存档/回放） |

### 8.2 WebSocket 通道
- `world:tick` → `{game_time, speed}`
- `event` → 事件对象（前端渲染气泡/动画/新闻条）
- `agent:state` → 位置/状态机变化（节流 200ms）
- `agent:thought` → 思考气泡（agent thinking 时展示 thought 字段）
- `chat` → 对话消息流（对话 UI 实时显示）

### 8.3 内部模块接口（TypeScript）

```ts
interface MemoryStore {
  add(mem: NewMemory): Promise<Memory>;                    // 含 embedding 计算
  retrieve(agentId: string, query: string, now: number, k?: number): Promise<Memory[]>;
  recentReflections(agentId: string, n?: number): Promise<Reflection[]>;
  compact(agentId: string): Promise<void>;                 // 旧记忆归档
}
interface Planner {
  dailyPlan(agent: Agent, now: number): Promise<Plan>;
  decomposeHour(agent: Agent, hour: number): Promise<Agenda>;
  shouldReplan(agent: Agent, event: Event): Promise<boolean>;
}
interface Executor {
  nextAction(agent: Agent, ctx: DecisionCtx): Promise<Action>; // 输出已校验
  progress(agent: Agent): void;                                // 状态机推进
}
interface DialogueEngine {
  start(a: Agent, b: Agent, reason: string): Promise<void>;
}
interface WorldEngine {
  tick(): void;
  moveAlong(agentId: string, path: Tile[], speed: number): void;
  broadcast(event: Event): void;
}
```

---

## 9. 前端呈现设计

### 9.1 Phaser 场景
- Tiled 地图：小镇约 40×40 瓦片（咖啡馆、书店、广场、住宅、公园、湖边）；
- 角色：精灵 + 名字标签 + **状态气泡**（💭 thought / 💬 对话 / ⏳ thinking）；
- 移动：A* 寻路 + 平滑插值；碰撞与排队（两个 agent 同时过门自动让行）；
- 事件动画：对话冒泡、广播事件顶部横幅（"今晚 7 点湖边派对！"）。

### 9.2 React 面板（右/下侧）
- **Agent 列表**：头像、当前动作、位置，点击选中；
- **心智面板**（上帝视角核心，原版体验精髓）：
  - 记忆流时间线（可滚动、按 kind 过滤、显示 importance 星标）；
  - 反思树（树形展示 insight 层级）；
  - 今日计划 + 当前时段 agenda；
  - 关系网（对每个熟人的认知与好感度）；
- **玩家模式**：选中"扮演"后输入自然语言指令（"去告诉陈默今晚派对的事"）；
- **时间控制条**：暂停 / 1x / 10x / 60x + 当前游戏时间；
- **成本面板**：token/成本曲线。

---

## 10. 评估方案

### 10.1 自动化指标（每次运行自动产出）
- **行为合法性**：JSON 校验通过率、动作 target 命中率（幻觉率 < 2%）；
- **计划完成率**：agenda 中动作实际执行比例（目标 > 60%）；
- **记忆健康度**：每 agent 记忆量增长曲线、重要性分布、压缩触发次数；
- **信息传播**：注入一条 seeded 信息（如"湖边有宝藏"），统计 1/3/6 小时内知晓人数与传播路径（目标：6 小时内 ≥ 50% agent 知晓）；
- **反思质量**：触发次数、insight 平均长度、与证据的一致性（LLM-as-judge 抽检）。

### 10.2 访谈评估（参照论文，抽样进行）
- 用论文的 25 题框架（自省/回忆/计划/反应/对他人看法）对 agent 访谈；
- LLM-as-judge 评分 + 每周人工抽检 3 个 agent；
- **一致性测试**：对同一 agent 不同时间问同一问题，答案不应矛盾。

---

## 11. 分阶段实施计划

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M0 骨架（0.5~1 周）** | 世界状态 + 时间引擎 + LLMGateway + 事件日志；4 个 agent 命令行观察 | 4 agent 连续跑 1 游戏日不崩，日志可回放 |
| **M1 认知核心（1~2 周）** | 记忆流/检索/打分、日计划/分解/执行、反思树、对话摘要回写；极简 Web 面板 | 计划-执行-反思闭环跑通；访谈能答出"昨天做了什么" |
| **M2 空间呈现（1~2 周）** | Phaser 地图/寻路/碰撞/气泡、心智面板、时间控制条、玩家扮演 | 浏览器可视运行；玩家指令可执行 |
| **M3 社交涌现（1~2 周）** | 关系网络、信息传播、事件广播（派对/选举）、8~25 agent 压力测试 | 信息传播测试达标；单日成本 ≤ 预算 |
| **M4 生产化（持续）** | 持久化/回放/存档、成本治理面板、评估自动化、多人观察 | 外部用户可自建小镇并导入 persona |

---

## 12. 风险与对策

| 风险 | 表现 | 对策 |
|---|---|---|
| 成本失控 | token 超预算 | 7.4 省钱清单 + 全局并发上限 + 计量告警 |
| 人格漂移 | agent 行为前后矛盾 | persona 摘要每次注入 + 一致性测试兜底 |
| 检索退化 | 决策上下文全是近事，失大局 | 权重实测调优 + 强制混入反思 insight |
| 对话污染 | 记忆流被琐碎对话淹没 | 摘要回写 + 限流（同类对话记忆合并） |
| 幻觉越界 | 动作 target 不存在 / 走出地图 | 结构化输出 + 对象树校验 + 降级策略 |
| 中文检索质量差 | bge-m3 不达预期 | 自建小评测集（50 条记忆/问题对）实测选型 |
| 延迟堆积 | LLM 排队导致行为停滞 | 异步池 + 超时降级（小模型兜底决策） |
| 伦理风险 | 模拟真人/谣言传播被滥用 | persona 仅限虚构角色；文档声明；事件溯源可审计 |

---

## 附录 A：参考实现

- 论文：Generative Agents: Interactive Simulacra of Human Behavior（arXiv:2304.03442）
- 官方代码：github.com/joonspk-research/generative_agents
- 现代骨架：github.com/a16z-infra/ai-town（Convex+Pinecone+Phaser）
- 中文重构：github.com/x-glacier/GenerativeAgentsCN
- 规模化参考：CAMEL OASIS（百万 agent 社交媒体模拟）
- 综述：Large Language Models Empowered ABM（arXiv:2312.11970）

## 附录 B：术语表

| 术语 | 含义 |
|---|---|
| 记忆流 Memory Stream | agent 全部记忆的时间序列库 |
| 检索 Retrieval | 按 recency/importance/relevance 加权取 top-k 记忆 |
| 反思 Reflection | 记忆 → 问题 → 证据 → 洞察的抽象过程 |
| 反思树 | insight 层层向上抽象的树结构 |
| believability | 可信度，行为的"像人"程度 |
| 游戏时间 | 模拟世界内的时钟，可与现实时间解耦 |
