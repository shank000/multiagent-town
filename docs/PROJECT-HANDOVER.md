# 项目交接手册（multiagent-town → 涌现观测台）

> 本文档供接手 agent 完整理解项目现状与后续任务。状态日期：2026-08-30；当前提交以 `git rev-parse HEAD` 为准，验收基线为 `pnpm typecheck`、262 项 `node:test`、前端构建与 AgentSociety² SDK 冒烟。

## 一、项目是什么

一个**多智能体社会涌现实验平台**：LLM 驱动的智能体在一个微观社会中进行重复互动（伙伴选择/对话/馈礼/传言），研究者通过平行世界对照、叙事流、网络与指标视图观察社会结构的涌现。

**最初形态**是像素小镇（Generative Agents / Smallville 风格），随后演进为涌现控制台、叙事层与平行世界。当前主形态是**三视窗社会研究台**：小镇现场、社会关系/伙伴选择网络、人物心智/对话/世界状态同时可见，叙事时间线贯穿三者。

**核心研究问题（赛道 7 参赛主线，不可偏离）**：
> 在候选伙伴数量相等的前提下，agent 能否访问与特定伙伴相关的互动历史记录？关系回忆能否将原本离散的互动行为转化为依赖历史记录的伙伴选择模式，并随时间形成持久的关系结构？

## 二、技术栈与运行

- TypeScript strict、Node 22（`node:sqlite` DatabaseSync）、tsx、esbuild、node:test。**零运行时依赖**。
- 常用命令：
  - `pnpm test`｜`pnpm typecheck`｜`pnpm build:web`
  - `pnpm town-web --port 8787` → http://127.0.0.1:8787（平行世界控制台+酒馆叙事）
  - `pnpm experiment --days 20 --seeds 3`（2×2 因子预实验 CLI，输出四格指标表）
  - `pnpm town-agent login/look/map/status/walk/interact/say`（AI 接入协议，需要服务在跑）
- LLM 网关：`LLM_PROVIDER=mock`（默认，确定性离线）、`deepseek`（OpenAI 兼容）或 `ollama`（本地免费推理）；Ollama 提供 Qwen3 单模型、Qwen3 分层与 DeepSeek-R1/Qwen3 分层 profile，并支持按居民覆盖模型。

## 三、架构（五层）

```
src/core/      world(48×44网格/A*/walkable) · time(时钟) · types · state-machine(执行器) · pathfinding
src/engine/    seed(6居民persona+对象树) · mind(记忆/日记反思/规划/会话/关系/谣言/活动门面)
               social(邻近闲聊) · town-model(公开活动) · rumors(选择性披露) · loop(主循环)
               economy(金币/物品/赠礼) · experiment(伙伴选择实验·候选快照) · experiment-runner(实时挂载)
               metrics(重复率/互惠/聚类/多样性/HHI/矩阵持续性/枢纽集中度) · perception(Alicization式感知缓冲)
               world-factory(平行世界装配：mem-on/mem-off/rumor) · player(玩家指令) · dialogue/reflection/social-relations/memory-writer
src/llm/       gateway(路由/重试/计量) · prompts(模板) · mock(确定性决策) · deepseek · ollama/model-profiles
src/store/     db(sqlite schema: world_meta/agents/objects/events/memories/reflections/plans/conversations/messages/relationships/relationship_evidence/rumors)
src/web/       server(node http: /api/* 路由+SSE) · snapshot(快照序列化)
src/web/client camera(相机) · console(社会关系/选择网络/指标曲线/实验控制)
               effects(粒子) · hud/panel(气泡/结构化心智与会话卡) · main(三视窗编排)
               render/tiles/sprites(程序化场景、四向步态、坐卧/睡眠/对话姿态)
src/cli/       town-web · experiment(2×2 CLI) · town-agent(协议) · run/replay/interview
tests/         node:test 262 项（验收、单元、server、UI、会话、关系、反思、实验合同与 runtime）
public/        index.html(小镇/结构/检查器三视窗) · style.css(深色仪器风) · assets/(许可素材)
skills/town-agent/SKILL.md   外部 AI 接入文档
docs/          交接/研究文档（见下）
```

## 四、平行世界（当前主形态）

`world-factory.ts` 创建三个独立世界（各自数据库/引擎/日志/循环）；默认使用带时间戳与 PID 的新 run 路径，测试可用 `:memory:`。显式 `--db` 及其 w1/w2/w3 派生文件必须全部不存在，启动门禁会保护旧 run：
- `w1` mem-on：伙伴选择可访问历史（亲密度+近因打分）+ 馈礼交换；**关闭邻近闲聊**，隔离实验变量
- `w2` mem-off：随机选择、无馈礼（零模型对照）
- `w3` rumor：注入秘密（`seedRumor`），观察传播链（保留社交邻近闲聊）

服务端：`/api/worlds`（列表+active）、`/api/world/switch`；所有 `/api/state|narrative|experiment/*|guest/*|world/control` 作用于**当前活跃世界**；SSE 事件带 `worldId`（客户端 `activeWorldId` 过滤）。
客户端：三视窗同时呈现小镇、关系结构与人物/世界检查器；世界切换重拉叙事、关系与指标，视窗均可独立聚焦。

## 五、实验机制（核心）

### 伙伴选择实验（`engine/experiment.ts`）
- 每日 19:30 轮次（`CHOICE_MINUTE=1170`）：每位参与者从**等价伙伴集合**独立选 1 位开展一对一对话
- 因子1 `historyAccess`：off=均匀随机；on=按 `亲密度 + 0.5×近因(40游戏小时衰减) + 0.3×扰动` 打分
- 因子2 `giftExchange`：每日工资 10 → 在花店服务台购买鲜花(5) → 订单配送至所选伙伴当前位置 → 收礼方库存入账（A→B 情感+0.1，B→A +0.05）；`gift` 事件保留来源、配送地点与 `fulfilled` 状态
- 选择事件 payload 含 `mode/candidates[{id,name,affection,lastInteraction}]/chosen`——叙事「选择场景」卡依赖此数据（**删减会破坏前台**）
- `experiment-runner.ts`：实时主循环挂载；运行天数按实际完成的 19:30 轮次结算，跨速、跨多日和 19:30 后启动均保证 N 天=N 轮

### 世界事实契约（`engine/town-model.ts` / `engine/dialogue-quality.ts`）
- 公开活动状态固定为 `planned → en_route → active | cancelled`；预告不构成参与，19:30 以居民相对场景物件的实际位置核验到场
- `active` 事件、物件现场状态、居民动作与 `shared_activity` 关系证据共享同一参与者集合；少于 2 位实际到场者时只记录取消
- 对话提示动态注入当前实际地点、附近可交互物件和小镇功能；功能存在只表示可执行条件
- 对话入库质量门要求已完成的活动、馈礼及一般共同经历具有对应完成证据；两次修复仍不满足时使用不新增事实的保守回答

### 测量（`engine/metrics.ts`，CLI/服务端共用）
`repeat / recip / clus / div / hhi / persistence / hub` 由 `metricsOf()` 统一汇总：有向边重复率、机会校正互惠性、无向聚类、7 日 sender 伙伴多样性/HHI、相邻非重叠双 7 日有向矩阵 Pearson 持续性、加权入度 Freeman 枢纽集中度。TypeScript/Python 由同一 16 日 fixture 校验完整序列。
CLI 输出 2×2 四格表；`/api/experiment/metrics` 输出逐日序列+配对计数；前台按各指标量纲绘制小多图。

### 本地机制正控（20 天 × 3 种子，mock）
- seed 内汇总后，关系加权策略的平均有向重复率为 0.553/0.608，对照为 0.222；7 日伙伴多样性为 2.317/2.139，对照为 3.458
- 这些值验证本地代码策略与测量链，不估计正式 LLM 历史可见性效应；互惠、馈礼交互和其余结构指标均只作描述
- 逐 seed 数据见 `docs/data/local-reference-pilot-20d-3seed.v1.json`；60 天×5 seed 压力数据与环境记录见 `docs/runtime-validation.md`

### 社会会话与关系投影
- 每次对话持久化 `conversationId`、参与者、来源、开始/结束时间、状态、摘要与逐轮消息；每轮记录 `turnIndex/fromAgent/toAgent/eventId/gameTime`，人物面板按完整会话呈现双方承接关系。
- 日常对话只由相邻居民触发；伙伴实验使用显式 `arranged` 会面。会话活跃及摘要落库期间，参与者的移动与新决策均被锁定；客户端将双方摆放在同一会面点、互相朝向，并只给当前发言者显示说话姿态。
- 社会关系视窗按统计层级呈现 6+4 测量：A→B 方向量使用可点击箭头，互惠/依赖不对称/嵌入性使用单条 A↔B 无向线，伙伴集中度使用人物节点外环。视图支持 7/30 日与全历史、全网/Ego、最低值、鼠标/键盘定位；点击关系进入“互动→关系→结构”dyad 检查器，读取连续会话 turn、伙伴选择、精确时间区间关系证据与测量来源。缺失观察保持 `null`，choice-only 方向不会伪造关系状态，旧六维画像单独标注为探索性代理；全部结果只读，不进入伙伴选择处理、agent 决策或确认性指标。
- 模型依据与解释边界见 `docs/social-relationship-projection.md`。

### 日记反思与行为修正
- 每个跨日边界为每位居民生成一次有证据约束的结构化日记，记录职业视角、心境、信念、信念修订、明日行动指引和证据 ID；同日生成幂等。
- 心境包含效价、精力、压力、社交需求与职业专注；计划、动作决策和访谈均接收最新反思指引。新证据可以修订旧信念，已被替代的洞察不会继续进入决策上下文。
- 重要性累计反思继续补充日内模式发现；反思生成物不反向累加触发分数，避免递归反思。

## 六、比赛上下文（必须延续）

- **赛事**：AI 社会科学家研究挑战赛（清华 FIB Lab），赛道 7「智能体与计算社会科学探索」
- **硬约束**：所有研究类投稿须基于 AgentSociety² 平台实验（`pip install agentsociety2`，在线工作区有免费 LLM API）；提交=研究报告+代码+工作区压缩包（agentsociety.fiblab2025@gmail.com）；**初筛 2026-09-15**；现场 10-25；组队 3-5 人；评审五维（社科价值/问题创新/方法严谨/理论贡献/影响潜力）
- **我方策略**：本仓库作机制正控+演示台 → AgentSociety² 正式 2×2（N=24、5 seed、60 天）+ recent-3 稳健性 → 报告成稿
- **分析文档**：`docs/competition-track7-analysis.md`（策略）、`docs/research-narrative.md`（总纲）、`docs/competition-report-draft.md`（报告 v2 草稿）、`docs/competition-execution-plan.md`（三阶段计划与风险）、`docs/alicization-study.md`（Alicization 对照）

## 七、未完成任务（按优先级）

1. **在线平台运行**：工作区已具协议、fresh-completion agent、环境、Replay、受控 checkpoint、24 人档案和随机化 30-run 矩阵；Python 3.11.16 + `agentsociety2==2.8.4` 的 scanner/Replay/checkpoint 冒烟和 22 项协议测试通过。在线阶段固定真实模型，跑通真实 `AgentSociety.init/step/close` 决策链，接入互动摘要，完成崩溃恢复故障注入与容量标定，再执行 60 天运行
2. **报告 v2 正式结果**：方法与证据边界已成型，待回填平台结果、稳健性图表与理论讨论
3. **平台长期运行验证**：本地 60 天×5 seed 基准峰值 RSS 170,680 KB；在线容量标定继续记录 token、失败率、Replay 与 checkpoint 大小
4. **提交封包**：报告、代码、AgentSociety² 工作区、manifest/hash、validator 输出与恢复演练
5. **GitHub 集成**：基线提交与 `origin/main` 同步；本轮功能保持工作区未提交状态。按“安全集成分支 → 分层提交 → 复验 → 合并并推送 main”执行，并在提交前向用户确认本地 Ollama 实机门与提交分层

## 八、约定与红线

- 素材许可：CC0/CC-BY 可验证素材（Kenney/Sharm/Medieval/ansimuz/LimeZu 均署名于 ATTRIBUTION.md）；**禁用** RPG Maker RTP/星露谷扒包/来源不明仓库（用户曾提议的 CSDN 两仓库已裁定拒绝）
- 交付卫生（用户强制规则）：交付物只描述最终状态、无过程叙述、无「已去除X」措辞、注释肯定式；修改可见结果前先在聊天提出
- 子代理模型策略：明确指令用 deepseek-v4-flash，集成/评审用 pro
- 服务器管理：`pkill -f "[t]sx src/cli/town-web"` 后重启为后台任务；浏览器人工验收
