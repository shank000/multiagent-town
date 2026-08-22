# 项目交接手册（multiagent-town → 涌现观测台）

> 本文档供接手 agent 完整理解项目现状与后续任务。最后更新：2026-08-22，HEAD = d5f0ba6，135/135 测试全绿，工作区干净。

## 一、项目是什么

一个**多智能体社会涌现实验平台**：LLM 驱动的智能体在一个微观社会中进行重复互动（伙伴选择/对话/馈礼/传言），研究者通过平行世界对照、叙事流、网络与指标视图观察社会结构的涌现。

**最初形态**是像素小镇（Generative Agents / Smallville 风格），随后按用户指示经历三次形态演进：
1. 小镇（世界/心智/协议层）→ 2. 涌现控制台（网络/指标/干预）→ 3. **涌现酒馆叙事层 + 平行世界（当前主形态）**——「世界」退为小地图像素块，主体是文字对话游戏 UI。

**核心研究问题（赛道 7 参赛主线，不可偏离）**：
> 在候选伙伴数量相等的前提下，agent 能否访问与特定伙伴相关的互动历史记录？关系回忆能否将原本离散的互动行为转化为依赖历史记录的伙伴选择模式，并随时间形成持久的关系结构？

## 二、技术栈与运行

- TypeScript strict、Node 22（`node:sqlite` DatabaseSync）、tsx、esbuild、node:test。**零运行时依赖**。
- 常用命令：
  - `pnpm test`（135 项）｜`pnpm typecheck`｜`pnpm build:web`
  - `pnpm town-web --port 8787` → http://127.0.0.1:8787（平行世界控制台+酒馆叙事）
  - `pnpm experiment --days 20 --seeds 3`（2×2 因子预实验 CLI，输出四格指标表）
  - `pnpm town-agent login/look/map/status/walk/interact/say`（AI 接入协议，需要服务在跑）
- LLM 网关：`LLM_PROVIDER=mock`（默认，确定性离线）或 `deepseek`（OpenAI 兼容，`DEEPSEEK_API_KEY`）。

## 三、架构（五层）

```
src/core/      world(48×44网格/A*/walkable) · time(时钟) · types · state-machine(执行器) · pathfinding
src/engine/    seed(6居民persona+对象树) · mind(记忆/反思/规划/对话/关系/谣言/活动门面)
               social(邻近闲聊) · town-model(公开活动) · rumors(选择性披露) · loop(主循环)
               economy(金币/物品/赠礼) · experiment(伙伴选择实验·候选快照) · experiment-runner(实时挂载)
               metrics(共享测量：重复率/互惠/聚类/多样性) · perception(Alicization式感知缓冲)
               world-factory(平行世界装配：mem-on/mem-off/rumor) · player(玩家指令) · dialogue/reflection/memory-writer
src/llm/       gateway(路由/重试/计量) · prompts(模板) · mock(确定性决策) · deepseek
src/store/     db(sqlite schema: world_meta/agents/objects/events/memories/reflections/plans/messages/relationships/rumors)
src/web/       server(node http: /api/* 路由+SSE) · snapshot(快照序列化)
src/web/client camera(全屏相机) · console(网络图/指标曲线/小地图/实验控制)
               effects(粒子) · hud/panel(旧界面控件) · main(编排) · render/tiles/sprites(旧小镇渲染，叙事态下不展示)
               perception 前端对应叙事流；kinds 事件驱动叙事卡
src/cli/       town-web · experiment(2×2 CLI) · town-agent(协议) · run/replay/interview
tests/         135 项 node:test（验收 m0-m3/town2 + 单元 + server-guest/narrative/experiment）
public/        index.html(三栏：rail/舞台/角色详情) · style.css(深色仪器风) · assets/(素材，叙事态仅存档)
skills/town-agent/SKILL.md   外部 AI 接入文档
docs/          交接/研究文档（见下）
```

## 四、平行世界（当前主形态）

`world-factory.ts` 创建三个独立世界（各自内存库/引擎/日志/循环）：
- `w1` mem-on：伙伴选择可访问历史（亲密度+近因打分）+ 馈礼交换；**关闭邻近闲聊**，隔离实验变量
- `w2` mem-off：随机选择、无馈礼（零模型对照）
- `w3` rumor：注入秘密（`seedRumor`），观察传播链（保留社交邻近闲聊）

服务端：`/api/worlds`（列表+active）、`/api/world/switch`；所有 `/api/state|narrative|experiment/*|guest/*|world/control` 作用于**当前活跃世界**；SSE 事件带 `worldId`（客户端 `activeWorldId` 过滤）。
客户端：左栏世界下拉（切换即重拉叙事/指标）；顶栏视图 🎭叙事 / 🗺地图（极简像素块小地图）/ 🕸网络 / 📈指标。

## 五、实验机制（核心）

### 伙伴选择实验（`engine/experiment.ts`）
- 每日 19:30 轮次（`CHOICE_MINUTE=1170`）：每位参与者从**等价伙伴集合**独立选 1 位开展一对一对话
- 因子1 `historyAccess`：off=均匀随机；on=按 `亲密度 + 0.5×近因(40游戏小时衰减) + 0.3×扰动` 打分
- 因子2 `giftExchange`：每日工资 10 → 买鲜花(5) → 赠所选伙伴（A→B 情感+0.1，B→A +0.05），事件 kind=`gift`
- 选择事件 payload 含 `mode/candidates[{id,name,affection,lastInteraction}]/chosen`——叙事「选择场景」卡依赖此数据（**删减会破坏前台**）
- `experiment-runner.ts`：实时主循环挂载（`remainingDays` 扣减用精确 minute===1171 判定，**调速跳过窗口时扣减不生效但轮次仍会触发**——已知小缺陷，修复方向：改为跨日计数）

### 测量（`engine/metrics.ts`，CLI/服务端共用）
`repeat(同对重复率) / recip(互惠性相对基线) / clus(聚类系数) / div(7日窗口伙伴多样性)` + `metricsOf()` 汇总。
CLI 输出 2×2 四格表；`/api/experiment/metrics` 输出逐日序列+配对计数。

### 预实验结论（20 天 × 3 种子，mock）
- 记忆开 → 重复率 0.54-0.58 vs 记忆关 0.23-0.24（2.3×）；伙伴多样性 2.19-2.34 vs 3.53-3.55（集中化）
- 馈礼在记忆开下有正向交互趋势（0.582/2.189 为四格极值）；互惠性跨格稳定（基线现象，鉴别对照有效）
- 完整表见 `docs/competition-report-draft.md`

## 六、比赛上下文（必须延续）

- **赛事**：AI 社会科学家研究挑战赛（清华 FIB Lab），赛道 7「智能体与计算社会科学探索」
- **硬约束**：所有研究类投稿须基于 AgentSociety² 平台实验（`pip install agentsociety2`，在线工作区有免费 LLM API）；提交=研究报告+代码+工作区压缩包（agentsociety.fiblab2025@gmail.com）；**初筛 2026-09-15**；现场 10-25；组队 3-5 人；评审五维（社科价值/问题创新/方法严谨/理论贡献/影响潜力）
- **我方策略**：本仓库作预实验+演示台 → 平台复刻正式实验（N=24-30、三组/2×2、5 种子、60 天、稳健性子实验、Replay 数据）→ 报告成稿
- **分析文档**：`docs/competition-track7-analysis.md`（策略）、`docs/research-narrative.md`（总纲）、`docs/competition-report-draft.md`（报告 v1 草稿，含全部预实验数据与平台计划）、`docs/alicization-study.md`（Alicization 对照）、`docs/agentopia-analysis.md`（M3 机制来源论文）

## 七、未完成任务（按优先级）

1. **AgentSociety² 平台移植**（比赛关键路径，等队伍 API Key；代码结构可参考 `world-factory`/`experiment.ts` 移植为自定义环境模块）
2. **报告 v2**：补充平行世界对照叙事、稳健性数据
3. **实验运行稳定性**：`experiment-runner` 跨速扣减缺陷；长时间运行内存验证
4. **「世界配置徽标」**：每个世界在叙事流顶部显示实验差异说明
5. **GitHub 推送**：本地领先远程 6 个提交（54947b2 起未推；github.com 443 曾不稳定，恢复后 `git push origin main`；凭据需用户 token，远程地址已去凭据化）

## 八、约定与红线

- 素材许可：CC0/CC-BY 可验证素材（Kenney/Sharm/Medieval/ansimuz/LimeZu 均署名于 ATTRIBUTION.md）；**禁用** RPG Maker RTP/星露谷扒包/来源不明仓库（用户曾提议的 CSDN 两仓库已裁定拒绝）
- 交付卫生（用户强制规则）：交付物只描述最终状态、无过程叙述、无「已去除X」措辞、注释肯定式；修改可见结果前先在聊天提出
- 子代理模型策略：明确指令用 deepseek-v4-flash，集成/评审用 pro
- 服务器管理：`pkill -f "[t]sx src/cli/town-web"` 后重启为后台任务；浏览器人工验收
