# multiagent-town 工程导读：整体架构 / 子系统 / 使用 / 贡献

> 本文档面向第一次阅读本仓库的开发者，目标是用 30 分钟建立完整心智模型。
> 配套文档：
> - 技术方案设计：`docs/ai-town-design.md`
> - 论文机制分析：`docs/agentopia-analysis.md`
> - 赛道 7 研究设计：`docs/competition-track7-analysis.md`
> - AgentSociety² 适配合同：`docs/agentsociety2-migration-contract.md`
> - 外部 AI 接入协议：`skills/town-agent/SKILL.md`
> - 素材许可：`ATTRIBUTION.md`

---

## 1. 这是什么

一个以中文像素小镇为可观察环境的**多智能体社会涌现实验平台**：
- 小镇上生活着 6 位居民（林晚晴、陈默、沈屿、周岚、白露、老周），每位都有自己的作息、记忆、目标、性格；
- 居民会自主移动、工作、使用公共生活物件、感知日常环境、闲聊、经营关系、传播消息、参加公开活动、睡觉；
- 浏览器可实时观察 48×44 小镇（Canvas 2D 像素渲染），也可“扮演”任意 NPC 下达指令；
- 外部 AI（Claude Code / OpenClaw / 任意智能体）可通过 `town-agent` 协议以“访客”身份住进小镇。
- 工作空间按需加载关系记忆开/关与谣言传播三个世界模板中的 1–3 个，支持单世界观察、双组对照、三组并行和结构化社会网络测量。

**核心设计取舍**：
- **零运行时依赖**：不使用 React/Phaser/Fastify 等框架；后端只用 Node 22+ 内置 `node:http`、`node:sqlite`，前端用原生 Canvas + SSE。
- **LLM 可插拔**：默认 `MockProvider` 可离线跑全流程；`DeepSeekProvider` 走 OpenAI 兼容 API（云端），`OllamaProvider` 走本地 Ollama（免费、离线）。
- **认知引擎轻量自研**：记忆流、三因子检索、日/小时计划、反思、对话摘要、关系/谣言/活动全部在 `src/` 内实现，便于二次开发与研究实验。

---

## 2. 技术栈与工程约束

| 项 | 选择 |
|---|---|
| 语言 | TypeScript（严格模式，`strict: true`） |
| 运行时 | Node.js ≥ 22.5 |
| 后端服务 | `node:http` + SSE（无框架） |
| 数据库 | SQLite（`node:sqlite` 内置模块，零依赖） |
| 前端 | 原生 Canvas 2D + DOM，`esbuild` 分别打包研究台、统计页与日志页脚本 |
| LLM | 自研 `LLMGateway`；`mock` / `deepseek` / `ollama` 三种 provider |
| 测试 | `node:test`（内置），`tsx` 直接跑 TS |
| 包管理 | pnpm（`package.json` + `pnpm-lock.yaml`） |

验证入口包括 `pnpm typecheck`、`pnpm test`、AgentSociety² Python 协议测试与真实 SDK/Replay/checkpoint 冒烟。

---

## 3. 整体架构

### 3.1 分层视图

```
┌──────────────────────────────────────────────────────────────────┐
│ 呈现层 (public/ + src/web/client)                                  │
│   浏览器 HUD / Canvas 像素地图 / 建筑内饰 / 昼夜 / 粒子特效 /        │
│   事件流 ticker / 心智面板(详情/档案/记忆/反思/对话/关系)            │
└───────────────┬────────────────────────────────────────────────────┘
                │ SSE: snapshot(200ms) + event / HTTP: /api/*
┌───────────────▼────────────────────────────────────────────────────┐
│ Web 服务层 (src/web/server.ts + snapshot.ts)                        │
│   静态文件 / SSE 事件流 / 世界控制 / 扮演接口 / 访客接口             │
│   /api/state /api/status /api/relationships /api/agents/*/mind      │
│   /api/guest/* /api/player/* /api/broadcast /api/rumor /api/stats   │
│   static: index.html / stats.html / logs.html / client.js / *.js / style.css│
└───────────────┬────────────────────────────────────────────────────┘
┌───────────────▼────────────────────────────────────────────────────┐
│ 模拟引擎层 (src/engine + src/core)                                  │
│   WorldLoop 主循环 → AgentExecutor 状态机 → SocialTicker/Dialogue    │
│   → TownLife 日常环境 / TownModel 公开活动                           │
│   → MindEngine(Planner/Reflection/MemoryWriter)                     │
│   → PartnerChoiceExperiment（预实验，可插拔）                       │
└───────────────┬────────────────────────────────────────────────────┘
┌───────────────▼────────────────────────────────────────────────────┐
│ 认知/LLM 层 (src/llm + src/store)                                   │
│   LLMGateway(优先级/有界队列/世界轮询/背压/超时/计量)             │
│      → Mock | DeepSeek | Ollama                                  │
│   Prompt 模板：决策/重要性/日计划/小时计划/反思/对话/访谈             │
│   MemoryStore(记忆流+三因子检索) / RelationshipStore / RumorTracker   │
└───────────────┬────────────────────────────────────────────────────┘
┌───────────────▼────────────────────────────────────────────────────┐
│ 持久化层 (src/store/db.ts)                                          │
│   world_meta / agents / objects / events / memories / reflections   │
│   plans / conversations / messages / relationships / relationship_evidence / rumors │
└────────────────────────────────────────────────────────────────────┘
```

### 3.2 核心数据流（一个游戏 tick）

```
WorldLoop.step()
  ├─ TimeEngine.tick()                    # 推进游戏时间
  ├─ for agent: AgentExecutor.progress()  # idle→thinking→moving→acting
  │     ├─ 需要决策：装配记忆/洞察/议程/玩家指令 → LLMGateway.complete()
  │     ├─ 输出 JSON → validateDecision() 校验
  │     ├─ move_to：A* 寻路 → 逐步移动
  │     └─ interact/idle：持续 actionEndsAt 游戏分钟
  ├─ SocialTicker.tick()                  # 相邻久坐触发对话/招呼
  ├─ MindEngine.tick()                    # 计划/反思/对话 + 距离约束日常事件 + 公开活动
  ├─ 跨天系统事件"第 N 天开始"
  └─ db.setMeta('game_time')              # 落库；通知订阅者（SSE/CLI/记忆写入）
```

事件总线：所有行为统一走 `EventLog.addEvent()`，同时
1. 写入 `events` 表（可回放）；
2. 推送给 Web SSE 客户端（实时画面）；
3. 通知 `MemoryWriter`（把事件变成记忆流）；
4. 通知 `PerceptionEngine`（访客的注意力缓冲）。

### 3.3 选择性多世界单服务模型

- 一个 Web 服务承载当前工作空间选中的 1–3 个独立世界循环；每个已加载世界使用独立 SQLite、事件日志、心智、感知与实验实例；
- REST 读写通过 `worldId` 定址，SSE 快照与事件携带 `worldId`，客户端仅消费当前观察世界；
- LLM 调用全部**异步非阻塞**，agent 处于 `thinking` 状态等待结果，tick 不等待；
- 关闭顺序为停止定时器、等待实时 tick、心智写入与 LLM 请求结算，再关闭数据库；
- 正式 24–30 人实验由 `platform/agentsociety2/` 接入 AgentSociety² 工作区并输出 Replay。

---

## 4. 目录结构

```
multiagent-town/
├── README.md                  # 快速上手总入口
├── ATTRIBUTION.md             # 像素素材许可/署名
├── package.json               # 脚本：test/typecheck/town/replay/interview/town-web/town-agent
├── tsconfig.json              # 严格 TS 配置
├── demo.bat                   # Windows 快速演示（WSL 环境）
├── src/
│   ├── index.ts               # 公共导出（供库方式复用）
│   ├── core/                  # 世界与执行基础
│   │   ├── types.ts           # Agent/Persona/WorldObject/Action/Event 等共享类型
│   │   ├── world.ts           # WorldState：对象树、可走网格、碰撞/A* 查询
│   │   ├── pathfinding.ts     # A* 寻路
│   │   ├── state-machine.ts   # AgentExecutor：4 态状态机 + 异步决策
│   │   ├── time.ts            # TimeEngine：游戏时钟、日/分钟换算
│   │   └── weather.ts         # 逐日确定性天气（每 3 天 1 雨，纯视觉）
│   ├── engine/                # 模拟引擎（行为/认知/社交）
│   │   ├── seed.ts            # 小镇对象树 + 6 位居民 Persona + buildTown()
│   │   ├── loop.ts            # WorldLoop：主循环、跨天事件、runUntil
│   │   ├── mind.ts            # MindEngine：认知子系统门面
│   │   ├── memory-writer.ts   # 事件→观察记忆、重要性打分
│   │   ├── town-life.ts       # 公共物件状态、日常感官事件与附近观察者
│   │   ├── reflection.ts      # 证据约束日记 + importance 累计反思 + 行为指引
│   │   ├── dialogue.ts        # 持久会话/逐轮消息 + 摘要写回记忆/关系
│   │   ├── agent-profile.ts   # 稳定 ID 档案、像素头像、初始心态与指纹
│   │   ├── social-interactions.ts # 观察/帮助/分享/邀请/协作事件与关系证据
│   │   ├── relational-measures.ts # 6+4 时间窗关系测量与缺失语义
│   │   ├── social-relations.ts# 多维社会关系观察投影
│   │   ├── social.ts          # SocialTicker：邻近闲聊触发
│   │   ├── rumors.ts          # 谣言追踪（传播链）
│   │   ├── status.ts          # Weighted PageRank 声望计算
│   │   ├── town-model.ts      # 公开活动预告/前往/到场核验/现场状态
│   │   ├── player.ts          # PlayerDirector：玩家指令覆盖
│   │   ├── interview.ts       # 上帝视角访谈
│   │   └── experiment.ts      # 伙伴选择预实验（研究模式）
│   ├── llm/                   # LLM 层
│   │   ├── types.ts           # Provider/Request/Response/Usage
│   │   ├── gateway.ts         # 重试/超时/JSON 解析/计量
│   │   ├── deepseek.ts        # DeepSeek OpenAI 兼容实现
│   │   ├── ollama.ts          # Ollama 本地 /api/chat 实现（按 tier/居民选模型）
│   │   ├── model-profiles.ts  # Qwen3/DeepSeek-R1 本地推理 profile
│   │   ├── provider-config.ts # 环境变量 → 网关配置（LLM_PROVIDER 等设置）
│   │   ├── mock.ts            # 全模板确定性离线实现
│   │   ├── prompts.ts         # 中文提示词模板库
│   │   ├── planner.ts         # 日计划 + 小时分解
│   │   └── action-validator.ts# 结构化动作校验
│   ├── store/                 # SQLite 持久化
│   │   ├── db.ts              # schema + openDb
│   │   ├── events.ts          # EventLog：事件表 + 订阅
│   │   ├── memory.ts          # MemoryStore：记忆/日记/计划/持久会话与消息
│   │   ├── relationships.ts   # 有向关系状态 + 多维证据账本
│   │   └── agent-profile-config.ts # 桌面版/CLI 居民档案持久配置
│   ├── runtime/
│   │   └── backend-log.ts     # 当前进程 JSONL、内存窗口、控制台采集与凭据脱敏
│   ├── web/                   # Web 服务与客户端
│   │   ├── server.ts          # node:http 服务 + SSE + REST API
│   │   ├── snapshot.ts        # 世界快照序列化
│   │   └── client/            # 浏览器前端
│   │       ├── main.ts        # 入口：SSE、状态同步、交互、扮演
│   │       ├── stats.ts       # 数据统计页客户端（/stats.html，拉取 /api/stats）
│   │       ├── logs.ts        # 后端日志页客户端（/logs.html，只读筛选与保存）
│   │       ├── render.ts      # 地形/建筑/湖水/昼夜
│   │       ├── tiles.ts       # 像素图集加载与瓦片映射
│   │       ├── sprites.ts     # NPC 行走图/姿态
│   │       ├── camera.ts      # 全屏自适应/滚轮缩放
│   │       ├── effects.ts     # 粒子（Zzz/蒸汽/星光/雨）
│   │       ├── hud.ts         # HUD：气泡/横幅/tooltip/动作图标
│   │       ├── panel.ts       # 侧边心智面板
│   │       └── types.ts       # 前端共享类型
│   └── cli/                   # 命令行入口
│       ├── run.ts             # pnpm town：观察台/虚拟快跑
│       ├── town-web.ts        # pnpm town-web：本机网页服务
│       ├── replay.ts          # pnpm replay：事件回放
│       ├── interview.ts       # pnpm interview：访谈
│       ├── experiment.ts      # pnpm experiment：研究预实验
│       └── town-agent.ts      # pnpm town-agent：外部 AI 访客协议
├── platform/agentsociety2/    # 正式平台适配、Replay、运行矩阵与验证器
├── tests/                     # node:test 测试
│   ├── helpers.ts             # 测试通用工具
│   ├── acceptance*.test.ts    # 端到端验收
│   └── *.test.ts              # 单元/子系统测试
├── public/                    # 前端静态资源
│   ├── index.html             # 小镇页面骨架
│   ├── stats.html             # 数据统计与分析页面（/stats.html）
│   ├── logs.html              # 当前后端进程日志页面（/logs.html）
│   ├── style.css
│   ├── client.js              # esbuild 产物 → 小镇页面（.gitignore）
│   ├── stats.js               # esbuild 产物 → 统计页（.gitignore）
│   ├── logs.js                # esbuild 产物 → 日志页（.gitignore）
│   └── assets/                # 像素素材（见 ATTRIBUTION.md）
├── data/                      # 运行时 SQLite（.gitignore）
├── docs/                      # 设计/论文/竞赛文档
└── skills/town-agent/SKILL.md # AI 接入协议手册
```

---

## 5. 各子系统架构

### 5.1 `src/core` —— 世界内核

**职责**：不依赖 LLM 的确定性物理世界与执行基础。

| 文件 | 类/函数 | 说明 |
|---|---|---|
| `types.ts` | `Agent`/`Persona`/`WorldObject`/`Action`/`GameEvent` | 全工程共享数据契约；Persona 含作息、性格五维、台词池 |
| `time.ts` | `TimeEngine` | 浮点累计游戏分钟；`day/minutesOfDay/totalMinutes`；格式化 |
| `world.ts` | `WorldState` | 48×44 网格；对象树注册；**可走性计算**（建筑边界为墙、开房门、水域阻挡、房间/家具开口）；A* 查询、对象中心/定位 |
| `pathfinding.ts` | `findPath()` | 4 方向 A*，曼哈顿启发，返回含起点终点路径 |
| `state-machine.ts` | `AgentExecutor` | 4 态（idle/thinking/moving/acting）状态机；异步 LLM 决策不阻塞 tick；移动排队让行 + 死锁解除；动作互斥 Schema、反馈修正与叙事安全回退 |
| `weather.ts` | `weatherForDay()` | 确定性天气，不参与行为决策 |

**关键设计**：
- 世界地图不是 tilemap 位图，而是**对象树**（town→building→room/furniture/zone/water），每个对象有瓦片坐标与尺寸；
- 建筑可走性由 `WorldState.computeWalkable()` 在构造时计算：默认建筑边界为墙，房间/家具开口，门取底边中点，若门被堵则逐步开放边界直到建筑外可达；
- 状态机的 `MOVE_SPEED_TILES_PER_MIN = 1`，决策间隔 `DECISION_INTERVAL_MIN = 10`。

### 5.2 `src/engine` —— 行为与认知引擎

**职责**：把“世界内核”变成“有生活的小镇”。

| 文件 | 类 | 职责 |
|---|---|---|
| `seed.ts` | `buildTown()` / `createGuestAgent()` | 小镇对象树（约 50 个对象）+ 6 个居民 Persona；访客角色生成 |
| `loop.ts` | `WorldLoop` | 主循环；`step()`/`runUntil()`/`start()`/`stop()`；跨天事件；依赖注入 Social/Mind |
| `mind.ts` | `MindEngine` | 认知门面：组合 MemoryStore/Planner/Reflection/MemoryWriter/RelationshipStore/RumorTracker/Dialogue/TownModel；定时 5:00 日计划、整点小时分解、跨日证据日记、累计反思、对话与活动 |
| `memory-writer.ts` | `MemoryWriter` | 订阅 EventLog；把事件转成观察记忆；调用 LLM 打重要性 1–10 |
| `reflection.ts` | `ReflectionEngine` | 每日生成职业视角日记、心境、信念/修订与明日指引；重要性累计 >150 时补充模式洞察；日记由事件原文、模型心态和人物价值分层投影，替代信念退出决策上下文 |
| `dialogue.ts` | `DialogueEngine` | 多轮会话持久化 conversation/turn/speaker/listener；日常会话要求相邻，实验会面显式 arranged；活跃/收尾期间锁住移动，摘要写回双方记忆与关系证据 |
| `relational-measures.ts` / `social-relations.ts` | 关系测量与投影 | 按时间窗生成原六项与新增四项连续测量、缺失状态、方向和 dyad 证据；旧六维状态画像仅作探索性兼容层；只读观察结果不进入实验决策 |
| `social.ts` | `SocialTicker` | 清醒、站定、相邻累计 3 游戏分钟后，按人格、社交需求、关系与现场观察形成自发会话意图；正式伙伴选择实验运行时关闭自然接触 |
| `rumors.ts` | `RumorTracker` | 谣言 seed/spread/传播链查询；会话中按关系门槛沿一次性有向链传播并规范化转述内容 |
| `status.ts` | `computeStanding()` | Weighted PageRank + 互惠加成（Agentopia/Sociometer），输入全量关系输出声望分 |
| `analyze.ts` | `analyzeTown()` | 数据统计与分析核心：只读聚合 events/memories/reflections/plans/messages/relationships/rumors，产出 TownReport（`/api/stats` 数据源） |
| `town-model.ts` | `TownModel` | 公开活动目录轮换（湖边派对/读书会/集市）；按人格形成参与意向，居民沿 A* 路线前往对应场景；19:30 以实际位置核验到场，少于 2 人取消，达到 2 人才启动物件现场状态并为真实共同参与者写入关系证据 |
| `town-life.ts` | `TownLifeEngine` | 每天四个时段轮换自然/商业/照料/邻里事件；更新物件短期状态，按距离生成居民观察记忆 |
| `player.ts` | `PlayerDirector` | 玩家自然语言指令覆盖某个 agent 决策，60 游戏分钟内最高优先级 |
| `interview.ts` | `interviewAgent()` | 上帝视角访谈：检索记忆+洞察 → 第一人称回答 |
| `experiment.ts` | `PartnerChoiceExperiment` | 每晚 19:30 伙伴选择预实验；historyAccess on/off 对照；用于研究分析 |

**认知流**：

```
事件 → MemoryWriter → memories(importance)
  跨日边界 → ReflectionEngine → diary + mind_state + beliefs/revisions + guidance
  记忆累计 >150 → ReflectionEngine → evidence-bound insights
  5:00/整点 → Planner → daily_plan + hourly agenda
  决策时 → MemoryStore.retrieve(recency+importance+关键词Jaccard)
         + recentInsights + currentAgendaLine → AgentExecutor 决策上下文
  对话 → DialogueEngine → conversations/messages → dialogue_summary → 双方 memories + relationship evidence
```

### 5.3 `src/llm` —— LLM 网关与提示词

**职责**：所有“需要智能”的地方统一走 `LLMGateway`，便于计量、重试、换模型。

- `LLMGateway.complete()`：按模板计量、指数退避重试（默认 2 次）、jsonMode 解析失败自动重试。
- `MockProvider`：离线确定性输出，支持全部模板；适用于测试、CI、无 Key 演示。
- `DeepSeekProvider`：OpenAI 兼容 `chat/completions`，价格按 ¥2/M 入、¥8/M 出估算。
- `prompts.ts`：中文系统提示词 + 统一 `<M0_CONTEXT>` JSON 注入，模板常量（action_decision/importance/daily_plan/hour_plan/reflection_*/dialogue*/interview）。
- `action-validator.ts`：对 LLM 输出的动作 JSON 做结构、对象存在性和时长校验；`idle` 的冗余目标安全规范为 `null`，其余无效结果进入携带原因的修正请求。
- `planner.ts`：日计划（自然语言 3–5 句）+ 小时计划（HH:MM 动作清单）写入 `plans` 表；`currentAgendaLine()` 供决策注入。

### 5.4 `src/store` —— SQLite 持久化

**职责**：全部可观察状态落库，支持回放与实验分析。

| 表 | 用途 |
|---|---|
| `world_meta` | KV：游戏时间等元信息 |
| `agents` | 居民/访客名册（WorldLoop 构造与访客登录时由 `hydrateWorld` 幂等写入内存世界） |
| `objects` | 世界对象树（启动时水合同步） |
| `events` | 事件日志（回放源） |
| `memories` | 记忆流（observation/reflection/dialogue_summary/plan/insight） |
| `reflections` | 反思树、结构化日记、心境、信念修订与行为指引 |
| `plans` | 日/小时计划 |
| `conversations` | 会话参与者、状态、起止时间、轮数与摘要 |
| `messages` | 带会话 ID、轮次、说话者与听者的逐轮消息 |
| `relationships` | 有向关系状态与 knowledge 叙事层 |
| `relationship_evidence` | 关系维度变化的事件证据账本 |
| `rumors` | 谣言传播链 |

**MemoryStore 三因子检索**（不引向量库）：
```
score = 0.25 * 0.995^(now-createdGameTime) # recency（证据年龄）
      + 0.35 * importance/10               # importance
      + 0.40 * Jaccard(中文双字shingle)    # relevance
```

`lastAccessGameTime` 只记录记忆最近一次进入 top-k 的时刻，供审计与活跃度统计使用，不参与检索评分。

**RelationshipStore**：有向（A→B 与 B→A 分存）；`affection`/`respect` 各 -1..1，单次变化量 ±0.2 封顶；证据账本记录 trust/support/tension/frequency 代理的事件来源，并提供闭区间全量读取、双人读取与 SQL 精确计数。只读测量层按时间窗生成 6+4 连续观察量与双人证据；有向、dyad、actor 层分别映射为箭头、无向线与节点外环，不把任何观察代理写回因果处理。

### 5.5 `src/web` —— Web 服务与浏览器

**服务端**（`server.ts`）：
- 静态文件：`/`、`/stats.html`、`/logs.html`、`/client.js`、`/stats.js`、`/logs.js`、`/style.css`、`/assets/*`；
- SSE：`GET /events`，200ms 推 `snapshot`，实时推 `event`；
- 世界控制：`POST /api/world/control`（pause/resume/speed）；
- 实验工作空间：`GET /api/workspace` 返回当前初始配置、模板与安全状态；`POST /api/workspace` 在暂停、无正式实验、无在途认知时创建全新数据库/日志并替换当前 1–3 个世界；`POST /api/workspace/reset` 校验当前 workspaceId 后以同配置创建第 1 天暂停运行，并保留文件研究档案；
- 数据统计：`GET /api/stats?worldId=w1[&day=N]`（按世界定址，日级口径一致）；
- 后端日志：`GET /api/runtime-logs` 只读筛选当前进程的有界内存日志，`GET /api/runtime-logs/download` 下载本次运行的完整脱敏 JSONL；服务端持有唯一文件路径，不接受浏览器路径参数；
- 声望/关系：`GET /api/status`、`GET /api/relationships/:id`；
- 居民档案：`PUT /api/agents/:id/profile`，按稳定 ID 同步当前工作空间已加载世界并记录 `profile_set_hash`；
- 社会互动：`POST /api/social/interact`，作为当前世界的显式研究者干预写入事件、记忆范围与关系证据；
- 心智面板：`GET /api/agents/:id/mind`（记忆/反思/计划/对话）；
- 扮演：`POST/DELETE /api/player/:id/act`；
- 广播/谣言：`POST /api/broadcast`、`POST /api/rumor`；
- 访客协议：`POST /api/guest/login`、`GET /api/guest/look`、`POST /api/guest/act`、`GET /api/guest/map`、`GET /api/guest/status`。

**客户端**（`src/web/client/*`）：
- `main.ts`：SSE 接收快照与事件；相机/交互/扮演；
- `stats.ts`：统计页客户端——独立选择观察世界，拉取 `/api/stats?worldId=...`，并以请求序号避免旧响应覆盖新选择；
- `logs.ts`：后端日志客户端——级别/全文筛选、自动刷新、最新记录跟随、路径复制和完整文件保存；
- `render.ts` + `tiles.ts` + `sprites.ts`：Canvas 像素世界（多图集回退链、程序化 fallback、屋顶剖切、昼夜、河光）；
- `effects.ts`：粒子系统（Zzz/蒸汽/星光/信件/炊烟/萤火/雨丝/水花）；
- `panel.ts`：侧边六标签面板（详情/档案/记忆/反思/对话/关系）；
- `avatar.ts`：零外部素材的可编辑像素头像组件，供名册、档案、会话和时间线复用；
- `hud.ts` + `camera.ts`：HUD/tooltip/气泡/缩放。

### 5.6 `src/cli` —— 命令行入口

| 命令 | 等价脚本 | 用途 |
|---|---|---|
| `pnpm town [--until-minutes N] [--speed S] [--db PATH]` | `src/cli/run.ts` | 无界面观察台/虚拟时钟快跑 |
| `pnpm town-web [--port P] [--speed S] [--db PATH] [--worlds KINDS] [--workspace-name NAME] [--seed N]` | `src/cli/town-web.ts` | 启动选择性世界浏览器小镇 |
| `pnpm replay --day N [--db PATH]` | `src/cli/replay.ts` | 回放某天事件时间线 |
| `pnpm interview -- --agent 名字 --question "问题"` | `src/cli/interview.ts` | 上帝视角访谈 |
| `pnpm experiment [--days N] [--seeds N]` | `src/cli/experiment.ts` | 伙伴选择预实验（研究） |
| `pnpm town-agent <cmd> [args]` | `src/cli/town-agent.ts` | 外部 AI 访客协议 CLI |

### 5.7 `tests` —— 测试体系

- 用 Node 内置 `node:test` + `tsx`；
- 覆盖：路径/世界/时间/天气、状态机、记忆/检索/反思、对话/关系/谣言/社交/活动/声望、LLM 网关/校验/提示词、Web API/SSE/快照/访客/扮演、CLI、前端渲染（render/panel/hud/tiles/effects/camera）、数据统计（`analyze.ts` + `/api/stats` + 统计页渲染）等；
- 验收测试（`acceptance*.test.ts`）验证“连续跑 1 天不崩、事件可回放”等端到端行为。

---

## 6. 快速使用说明

### 6.1 安装

```bash
corepack enable              # 启用 pnpm（或先安装 pnpm）
pnpm install
```

> 需要 Node.js ≥ 22.5（`node:sqlite` 要求）。

### 6.2 运行浏览器小镇（默认 mock LLM，离线可用）

```bash
pnpm town-web --port 8787
# 浏览器打开 http://127.0.0.1:8787
```

浏览器里可以：
- 看小镇实时画面、事件流；
- 滚轮缩放、双击复位、点击 NPC/建筑查看档案；
- 点击“🎮 扮演”后输入自然语言指令指挥该 NPC；
- 暂停/恢复/1x/60x 变速；高速档采用认知采样并在模型积压时暂缓虚拟时钟；
- 点顶栏「📊 数据统计」打开 `/stats.html` 数据统计与分析页。

### 6.3 用真机 LLM（DeepSeek / Ollama）

云端 DeepSeek（OpenAI 兼容）：

```bash
LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=sk-xxx pnpm town-web --port 8787
```

本地 Ollama（先 `ollama pull qwen3:4b` 并保持 `ollama serve` 运行，无需 API key）：

```bash
LLM_PROVIDER=ollama OLLAMA_PROFILE=qwen3-single pnpm town-web --port 8787
```

支持的环境变量：
- `LLM_PROVIDER=mock|deepseek|ollama`（默认 mock）；
- `DEEPSEEK_API_KEY`（provider=deepseek 必填）；
- `OLLAMA_BASE_URL`（默认 `http://127.0.0.1:11434`）；
- `OLLAMA_PROFILE=qwen3-single|qwen3-tiered|deepseek-tiered`（默认 `qwen3-single`）；
- `OLLAMA_MODEL` / `OLLAMA_SMALL_MODEL`（可选，覆盖 profile 对应层）；
- `OLLAMA_AGENT_MODELS`（可选，居民 ID 到模型名的 JSON 映射）；
- `OLLAMA_KEEP_ALIVE`（默认 `10m`）；
- `OLLAMA_NUM_CTX`（默认 `8192`，作为每次请求的上下文窗口，保证不同启动方式下条件一致）；
- `OLLAMA_TIMEOUT_MS`（默认 `120000`，只接受正整数毫秒）；
- `LLM_MAX_CONCURRENCY`（Ollama 默认 `1`，共享 provider 最大并发）；
- `LLM_MAX_QUEUE`（Ollama 默认 `96`，有界等待容量）；
- `TOWN_URL`（仅 `town-agent` 使用，默认 `http://127.0.0.1:8787`）

Ollama 按居民覆盖和任务层级路由模型：`OLLAMA_AGENT_MODELS` 可为指定居民选模型；否则 small 层处理动作、对话、规划和后台评分，large 层处理深度日记反思。居民共享模型服务与权重，persona、记忆、关系、日记和心智状态在应用层独立。网关按“对话—动作—规划—反思—后台”调度，同级请求按世界轮询；等待队列默认在容量的 75% 进入背压、降到 50% 后恢复。当前加载的 1–3 个世界按同一批次推进或等待，避免条件组时钟偏移。动作、规划、对话、摘要与日记使用请求级 JSON Schema；反思以有界结构化输出配合证据投影，在保留心态和信念更新的同时避免长思考阻塞与新增事实。本地推理的 `costYuan` 恒为 0。

Web 研究台通过同一个 `LLMGateway` 运行时切换 `MockProvider`、`OllamaProvider` 与 API provider。切换是共享网关上的原子操作，不重建居民、记忆库、关系库或已加载世界。服务端仅在人物对话完整结束、世界暂停、正式实验停止、居民思考已结算且活动请求与等待队列均为空时接受变更，并同步重设 provider 对应的并发、队列与吞吐样本。候选配置先执行独立 structured-output 探针；探针不进入世界状态。每次生效配置以 `llm_runtime_config_changed` 事件写入当前工作空间的全部世界，payload 记录模式、模型、上下文窗口和配置修订号，不记录 API Key。API Key 仅保存在当前服务进程内存，GET 状态只返回 `hasCredential`。

动作 Schema 将 `idle + target:null` 与 `move_to/interact + 已知对象 id` 建模为互斥分支。`action-decision/v3` 在应用层继续执行可执行性校验：安全清理 `idle` 的冗余目标；`interact` 动词必须来自目标 affordance、居民针对同一目标的明确作息或当前玩家指令。模型返回的紧凑谓词只有在规范化后被一个声明动词完整包含且映射唯一时才会执行，并以完整声明动词落库；歧义、反向扩写、无关动词和编辑距离近似均拒绝。其他错误把校验原因与允许动词加入低温修正请求；两次无效时生成不含技术文本的短时休息动作。真实本地/API 请求同时记录运行模式、游戏时间、日期、地点、作息槽与玩家指令；返回时任一上下文变化或请求年龄超过 15 游戏分钟，结果标记为 `stale_rejected` 并在当前上下文重取。重取期间的局部时间屏障保证即使没有外层时间治理器，粗粒度 tick 也不会使替代响应连续过期。确定性 Mock 采用既有的下一 tick 离散结算轨迹，不以模拟 tick 间隔判定墙钟过期；真实异步模型的快速响应则在请求时刻同刻结算。异常状态以 `action_decision_quality` 结构化事件留存，并从人物记忆、叙事接口和现场气泡中隔离；人物 `thought` 的 `decisionQuality` 字段提供 `valid/normalized/repaired/safe_fallback`、尝试次数、校验器版本、规范化证据和模型信息，支持按世界与居民计算动作修复率。

对话在持久化前经过 `dialogue-turn/v2`：研究审计记录、日记、计划、反思、关系元摘要与居民口语属于不同语义层，内部材料只用于理解和事实核验。质量门用当前发言、4–6 句有界会话前文、类型化记忆、关系摘要和谣言载荷检查语用承接、会话推进、近义/意象循环、作品内容、个人阅读经历、第三方身份与世界事实边界；“我能确认的是”、日期编号、证据标签和“双方情感升温”等研究口吻只进入摘要与诊断。首个候选不合格时执行一次低温重写；第二个候选仍不合格时，首句从可说出口的观察发起话题，中段用无新增事实的追问承接，第 4 句后的非问题场景自然收束，事件 payload 标记 `safe_fallback` 并保存尝试次数与拒绝原因。该门只控制叙事质量，不改写实验处理标签或伙伴选择。

网关保留最近 120 个成功请求的 provider 原生生成时序、应用端到端延迟、排队等待、模板与优先级。吞吐快照给出生成 tok/s、有效 tok/s、全体 p50/p90、对话 P90、排队 P90、样本置信度和 `0.05×..60×` 建议持续倍速。`POST /api/llm/calibrate` 提供冷启动探针；时间治理器在智能模式下每 2 秒重估全部已加载世界的统一速度，降速立即生效，提速经过连续稳定窗口并逐档恢复。真实 provider 的对话、行动、规划与反思在生成或排队期间构成认知同步屏障，世界循环只结算已经完成的结果。每次实际调速以 `timeline_speed_adjusted` 事件和后端结构化日志记录，支持实验回放与时序审计。完整规则见 `docs/adaptive-timeline-governor.md`。

### 6.4 无界面观察/快跑

```bash
pnpm town                            # 实时观察台，Ctrl+C 停止
pnpm town --until-minutes 1440 --speed 60   # 虚拟时钟快跑 1 个游戏日
pnpm replay --day 1                  # 回放第 1 天事件
pnpm interview -- --agent 林晚晴 --question "今天做了什么"
```

命令行参数：
- `--speed`：游戏分钟/现实秒（默认 1，即 60x；`town-web`/`town` 中 `TimeEngine` 按 `speed*0.5`/tick 实现）；
- `--db`：SQLite 路径（默认 `data/town.sqlite`）；
- `--until-minutes`：快跑到的总游戏分钟；
- `--port`：Web 服务端口。

### 6.5 让外部 AI 住进小镇（town-agent）

先启动 `pnpm town-web`，然后用：

```bash
pnpm town-agent login --name 爱丽丝                 # 登录/创建访客
pnpm town-agent map                                # 地点目录
pnpm town-agent look --name 爱丽丝                  # 环顾 + 环境感知
pnpm town-agent walk --name 爱丽丝 --target 湖边公园
pnpm town-agent interact --name 爱丽丝 --target 林间咖啡馆
pnpm town-agent say --name 爱丽丝 --text 大家好！
pnpm town-agent status --name 爱丽丝
```

完整协议见 `skills/town-agent/SKILL.md`。

### 6.6 数据统计与分析（Web 界面）

```bash
pnpm town-web --port 8787       # 启动后浏览器打开 http://127.0.0.1:8787
# 再打开 http://127.0.0.1:8787/stats.html（或小镇顶栏「📊 数据统计」）
```

统计页从 `GET /api/stats?worldId=...` 拉取指定世界的报告，展示：

- **概览**：已模拟天数、居民名单、events/memories/reflections/plans/messages/relationships/rumors 各表计数与日均事件；
- **事件**：按 type（move/chat/interact/broadcast/system/player）与 payload.kind 分布、每日趋势、2 小时档时段分布（作息节律）、最活跃居民/地点；
- **记忆**：按 kind（observation/reflection/dialogue_summary/plan/insight）与按居民分布、importance 均值与直方图、从未被检索比例（记忆活跃度）、日均新增；
- **反思 / 计划**：次数、平均触发分、洞察数、计划覆盖天数与小时条目密度；
- **对话**：消息量、会话数、平均轮数、字数、对话最多的配对；
- **关系**：有向记录/双向对、affection/respect 均值与极值、最紧密/最疏远配对、knowledge 叙事层条目；
- **声望榜**：Weighted PageRank 排序（复用 `engine/status.ts`）；
- **谣言**：记录数、去重内容、最大传播链、传播链长度分布、源头排行；
- **公开活动**：预告、出发、现场到场核验、开始/取消时间表，真实参与人数与观察者范围。

支持「全部天数 / 第 N 天」筛选；日级事件、消息、配对、会话和平均字数采用同一时间窗，关系与声望等结构状态明确标记为当前世界全时段口径。自动刷新不会改变服务端活跃世界。

### 6.7 研究/预实验模式

```bash
pnpm experiment --days 30 --seeds 3
```

用内存 SQLite + mock LLM 跑“伙伴选择（关系记忆开/关）”对照，输出同对重复率、互惠性、聚类系数、伙伴多样性等指标。详见 `docs/competition-track7-analysis.md`。

### 6.8 验证开发改动

```bash
pnpm typecheck     # tsc --noEmit
pnpm test          # node:test 全量
pnpm build:web     # 重新打包研究台、统计页与日志页脚本
```

---

## 7. REST API 速查

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 当前世界快照 JSON |
| GET | `/events` | SSE：snapshot/event |
| POST | `/api/world/control` | `{action:"pause"|"resume"|"speed", value?}` |
| GET | `/api/worlds` | 平行世界元数据与当前活跃世界 |
| POST | `/api/world/switch` | 切换主控制台观察世界 |
| GET | `/api/workspace` | 当前工作空间初始配置、世界模板与安全状态 |
| POST | `/api/workspace` | 从初始配置创建并加载新的 1–3 世界小镇 |
| POST | `/api/workspace/reset` | 以当前工作空间配置安全创建第 1 天暂停运行 |
| GET | `/api/stats?worldId=w1[&day=N]` | 指定世界的数据统计报告 |
| GET | `/api/runtime-logs?level=all&q=&limit=500` | 当前进程的脱敏后端日志 |
| GET | `/api/runtime-logs/download` | 保存本次运行的完整 JSONL 日志 |
| GET | `/api/status` | 声望榜（Weighted PageRank） |
| GET | `/api/relationships/:id` | 某 agent 的关系 + 声望 |
| PUT | `/api/agents/:id/profile` | 同步更新已加载世界的居民档案、初始状态、头像与档案指纹 |
| POST | `/api/social/interact` | 在指定世界记录观察/帮助/分享/邀请/协作干预 |
| GET | `/api/agents/:id/mind` | 记忆/反思/计划/对话 |
| POST | `/api/player/:id/act` | 扮演指令（`{instruction}`） |
| DELETE | `/api/player/:id/act` | 退出扮演 |
| POST | `/api/broadcast` | 全镇广播 `{text}` |
| POST | `/api/rumor` | 谣言种子 `{text, sourceId?}` |
| POST | `/api/guest/login` | 访客登录 `{name}` |
| GET | `/api/guest/look?name=` | 访客环顾 |
| POST | `/api/guest/act` | 访客动作 `{name, action:walk\|interact\|say, target?, text?}` |
| GET | `/api/guest/map` | 地点目录 |
| GET | `/api/guest/status?name=` | 访客状态 |

---

## 8. 贡献说明

### 8.1 开发流程建议

1. 先读 `docs/ai-town-design.md` 了解设计蓝图，再读本架构文档；
2. 从一个小改动开始：例如给某位居民加一条 `routine`、加一个对象、加一种事件类型；
3. 改动后跑 `pnpm typecheck` 与 `pnpm test`；
4. 前端改动后运行 `pnpm build:web` 并重新打开页面验证；
5. 涉及协议/命令时同步更新 `skills/town-agent/SKILL.md` 与 `README.md`；
6. 新增素材必须更新 `ATTRIBUTION.md`（本项目混用 CC0/CC-BY 素材，需保留署名）。

### 8.2 扩展点

- **新增居民**：在 `src/engine/seed.ts` 添加 `Persona`（含 `routine`、`greetingPool`、`personality`），在 `TOWN_OBJECTS` 添加家/床/沙发等对象，并加入 `HOME_BY_NAME`。
- **新增地点/建筑**：在 `TOWN_OBJECTS` 添加 `building/room/furniture/zone/water` 对象；可走性由 `WorldState.computeWalkable()` 自动处理；如需前端渲染新的样式，扩展 `client/tiles.ts`/`render.ts`。
- **新增行为/机制**：优先以“事件”为接口——写 `EventLog.addEvent(...)`，再在 `MemoryWriter`/`DialogueEngine`/`PerceptionEngine` 里订阅消费；若是对外 API，在 `web/server.ts` 增加路由。
- **新增 LLM 能力**：在 `llm/prompts.ts` 增加模板与消息构建函数，在 `llm/mock.ts` 增加确定性分支，在 `llm/deepseek.ts` / `llm/ollama.ts`（通常无需改）复用 OpenAI 兼容 / Ollama 调用；新增 provider 时同步改 `gateway.ts` 与 `provider-config.ts`。
- **新增研究实验**：参考 `engine/experiment.ts` + `cli/experiment.ts` 的模式：独立环境/种子/指标文件，保持“可复现、可对照”。
- **新增测试**：在 `tests/` 下按子系统命名 `*.test.ts`，用 `node:test` + `assert/strict`；端到端行为放 `acceptance*.test.ts`。

### 8.3 代码约定

- TypeScript 严格模式；文件头写清楚职责注释（现有代码风格）；
- 目录边界：`core` 不放 LLM/记忆逻辑；`engine` 编排认知/社交；`store` 只做持久化；`web/server.ts` 不写业务模拟；
- 中文命名与中文事件描述保持一致（居民名、地点名、verb 用中文）；
- 事件 payload 用 `kind` 字段区分事件子类型，便于前端/记忆/感知过滤；
- 不引入新的运行时依赖（如需必须先在文档说明理由）。

### 8.4 文档与素材

- 主要文档集中在 `docs/`，入口是 `README.md`；
- 任何用户可见行为变化都应更新 `README.md`；
- 外部 AI 协议变化必须同步 `skills/town-agent/SKILL.md`；
- 素材必须遵守 `ATTRIBUTION.md` 中的许可要求（尤其 CC-BY 需署名、CC0 可选署名）。

### 8.5 运行边界

- 运行数据库/JSONL 与 `public/client.js`、`public/stats.js`、`public/logs.js` 由运行/构建生成，已加入 `.gitignore`；
- 当前地图约 50 个对象、6 位常驻居民；更多居民/对象可直接由 seed 扩展；
- 本地 TypeScript 小镇承担机制正控与可视化；正式比赛数据由 AgentSociety² 在线工作区生成，二者的证据范围分别记录在 `docs/runtime-validation.md`。

---

## 9. 常见问题

**Q：没有 DeepSeek Key 能跑吗？**
能。默认 `LLM_PROVIDER=mock`，所有模板都有确定性离线输出，可用于演示、测试与预实验；也可以 `LLM_PROVIDER=ollama` 接本地模型，同样不需要 API key。

**Q：为什么用 SQLite 而不是内存？**
`data/town.sqlite` 保留事件/记忆/关系，支持 `pnpm replay` 回放和后续研究分析；测试可以用 `:memory:`。

**Q：前端改了但页面没变化？**
`pnpm town-web` 会先 `pnpm build:web`，手动运行 `pnpm build:web` 重新生成三个页面的浏览器脚本。

**Q：`thinking` 状态看起来卡住？**
LLM 调用是异步的；mock 下几乎立即返回，deepseek 下受网络/API 限流影响。若使用真机，建议设置 `DEEPSEEK_API_KEY` 并检查网络。
