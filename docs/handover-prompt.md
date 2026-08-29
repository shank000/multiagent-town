# 给后续 Agent 的交接 Prompt（可直接复制发送）

你接手的是一个已完成核心开发与第一轮实验工程加固的多智能体社会涌现实验平台（仓库 `/mnt/d/workspace/dsh/multiagent-town`，TypeScript strict / Node 22 / 零运行时依赖）。先以 `git rev-parse HEAD` 和 `pnpm test && pnpm typecheck` 核对当前版本。项目经历「像素小镇 → 涌现控制台 → 涌现酒馆叙事层 + 平行世界」三次形态演进，当前目标是参加「AI 社会科学家研究挑战赛」赛道 7（智能体与计算社会科学探索），并作为实验室工具持续完善。

## 背景与核心研究问题（不可偏离）

参赛作品检验：当候选伙伴数量相等时，LLM agent 能否访问与特定伙伴相关的互动历史记录？关系回忆能否把原本离散的互动转化为依赖历史记录的伙伴选择模式，并随时间形成持久的关系结构（重复互动对、枢纽、低传递性）。比赛硬约束：投稿必须基于 AgentSociety² 平台（清华 FIB Lab，pip install agentsociety2，在线工作区有免费 LLM API）做实验；提交=研究报告+代码+工作区压缩包；初筛 2026-09-15；现场 10-25；组队 3-5 人；评审五维=社会科学价值/问题创新性/方法严谨性/科学发现与理论贡献/影响与拓展潜力。

## 系统现状（五层）

1. 世界层：48×44 网格世界、6 位居民（全档案/作息）、A* 寻路、时钟可变速。
2. 心智层：记忆流（三因子检索）、日/小时规划、反思、多轮对话+摘要、关系（情感/尊重 ±0.2 夹紧）、谣言（选择性披露）、公开活动、声望榜（PageRank）。
3. 协议层：town-agent CLI（login/look/map/status/walk/interact/say）+ 环境感知（事件权重×距离衰减，⚡●○ 分级）+ `/api/guest/*`。
4. 实验层：每日 19:30 伙伴选择轮次；本地参考策略为 off=seeded uniform、on=亲密度+相对近因+标签派生扰动，正式 AgentSociety² 设计则让所有条件走同一 fresh LLM completion，只改变可见历史。馈礼在 choice 后发生并写入后续 dyadic history。兼容选择事件保留 `mode/candidates/chosen`；七项指标为有向重复率、机会校正互惠、聚类、7 日多样性/HHI、双 7 日矩阵持续性和枢纽集中度。
5. 呈现层（当前主形态）：平行世界切换（w1 记忆开实验组 / w2 记忆关对照 / w3 谣言传播，各自独立引擎与日志）；三栏仪器风 UI——左栏实验配置+运行状态+名册、中央视图（🎭叙事酒馆：对话气泡/内心独白/馈礼卡/选择场景卡、🗺极简像素块小地图、🕸力导向网络图、📈指标曲线）、右栏角色详情；SSE 事件含 worldId 由客户端过滤。

## 已有关键数据

本地 2×2 机制正控（20 天×3 seed，mock）按 seed 汇总后：关系加权策略的平均有向重复率为 0.553/0.608，对照为 0.222；7 日伙伴多样性为 2.317/2.139，对照为 3.458。该证据只验证本地策略和测量链，不估计正式 LLM 历史可见性效应。逐 seed 数据在 `docs/data/`；60 天×5 seed 压力基准峰值 RSS 170,680 KB。正式研究方法与证据边界见 `docs/competition-report-draft.md`、`docs/competition-execution-plan.md` 和 `docs/runtime-validation.md`。

## 待办（按优先级）

1. 在线 AgentSociety² 关键路径：固定实际模型，完成真实 `AgentSociety.init/step/close` 决策，接入互动摘要，执行 append/checkpoint 三处故障注入，跑 24-agent×2 天×4 条件容量标定。
2. 通过硬门后执行 N=24、60 天、4 主条件×5 seed；recent-3 扩展按容量优先级执行。任何跳轮、处理泄漏、不可审计 LLM 决策或 fallback>5% 的 run 不进入正式分析。
3. 报告 v2 回填正式平台结果、逐 seed 效应、稳健性与理论讨论；唯一确认性主要结局为第 31—60 天有向同对重复率。
4. 9 月 13 日前完成报告、代码、工作区、Replay、validator、manifest/hash 和复现说明封包。
5. GitHub 推送前先 fetch 并核对分歧；远程为无凭据 HTTPS，需要用户 token。

## 红线与约定

- 素材许可：仅 CC0/CC-BY 可验证素材（Kenney/Sharm/Medieval/ansimuz/LimeZu，署名在 ATTRIBUTION.md）；禁 RPG Maker RTP/星露谷扒包/来源不明仓库（用户两次提议的 CSDN 仓库已裁定拒绝，勿重新引入）。
- 交付卫生（用户强制）：交付物只描述最终状态、无过程叙述、无「已去除 X」措辞、注释与描述写肯定式；改动可见结果前先在聊天提出。
- 子代理模型：明确指令用 deepseek-v4-flash，集成/评审用 pro；服务器以 `pkill -f "[t]sx src/cli/town-web"` 停后重启为后台任务。

## 你的任务

先通读 `docs/PROJECT-HANDOVER.md`、`docs/competition-execution-plan.md`、`docs/competition-report-draft.md`、`docs/runtime-validation.md` 与 `platform/agentsociety2/README.md`，运行 TypeScript/Python/真实 SDK 验收。随后只推进在线硬门、正式数据采集、报告回填和提交封包；本地机制正控不得替代 AgentSociety² 正式证据。若对素材、交付卫生或比赛约束有疑问，先问用户再动手。
