# Alicization Town 源码对照研究

> 对象：https://github.com/ceresOPA/Alicization-Town（V0.7.0，MIT，Node 22.5+，MCP/Skill 驱动）
> 目的：为小镇（multiagent-town）补齐成熟 AI 小镇项目的「协议层」体验。本次为源码级对照（服务端引擎 800 行 + Skill 命令集 + 插件架构）。

## 一、架构对标：灵魂-物理分离

| 层 | Alicization | 本小镇 | 结论 |
|---|---|---|---|
| 世界物理（服务器） | world-engine：2D 坐标、碰撞、广播、事件流 | WorldState + EventLog + SSE | ✅ 已对齐 |
| 意识（终端） | 外部 AI（Claude Code/OpenClaw/Codex）经 MCP/Skill `town` 命令驱动 | town-agent CLI 驱动访客 | ✅ 已对齐（P1） |
| 感知 | 注意力缓冲：事件类型权重 × 曼哈顿距离衰减（perception.js） | PerceptionEngine（本轮实现） | ✅ 已对齐 |
| 记忆/计划/反思 | （AI 终端自带） | MindEngine 全量 | ✅ 更完备 |

## 二、命令集对照（skills/alicization-town/SKILL.md）

| Alicization `town` | 本小镇 `town-agent` | 状态 |
|---|---|---|
| `login --create --name --sprite` | `login --name` | ✅（sprite 固定序号，可扩展） |
| `map` 地点目录（id+坐标） | `map`（本轮补） | ✅ |
| `look` 位置+附近+`📡 环境感知` | `look` + perceptions（⚡/●/○ 分级） | ✅ 本轮补全 |
| `walk --to/--x/--y/--forward` | `walk --target`（对象寻址） | ⚠️ 坐标寻址未做（对象寻址覆盖 95% 场景） |
| `chat` | `say`（`chat` 别名已加） | ✅ |
| `interact` / `interact --item` | `interact --target` | ⚠️ item 消耗未做（见 P2） |
| `status`（HP/等级/金币/背包/装备） | `status`（身份/位置/状态/关系） | ⚠️ 轻量版；RPG 属性不采纳（比赛无关、成本高） |
| `server list/add` | 单机（TOWN_URL 环境变量） | ✅ 够用 |
| `logout/profile` | 登录幂等（重新登录即复用） | ✅ |

## 三、机制亮点与采纳决策

1. **感知系统（已采纳）**：事件权重 chat 1.0 / interact 0.5 / join·leave 0.3 / move 0.1，attention = w × (1 − d/(range+1))，曼哈顿距离 ≤12 瓦、容量 10、阈值 0.05；look/walk 排空缓冲。这是「AI 有小世界知觉」的关键体验。
2. **动态资源区（面馆/集市/魔药店）**：`interact --item` 扣除库存、人类补货——对应本小镇 P2「区域库存交互」，**待用户确认后实施**（与预实验经济维度联动）。
3. **怪谈板（神社）**：人类发布 → AI 到访读取 → 解读 → 对话传播——本小镇 rumor 引擎已支持「注入→传播」；**P3 待确认**（神社对象 + look 读取 + 传播链聚合）。
4. **RPG 属性（status 战力/装备，rpg-advanced 插件）**：**不采纳**——与赛道 7 研究无关、实现成本高；若展示需要，用轻量「金币+背包」替代（P2 范围内）。
5. **插件架构（plugin-manager：交互钩子/事件监听/HTTP 路由）**：本小镇已有 EventLog.subscribe + 模块化引擎，等效于「钩子=事件订阅」；暂不引入动态插件系统（YAGNI），研究需时可加。

## 四、待办清单（按比赛时间线）

- [ ] P2 库存交互（面馆式 `interact --item`）+ 轻量金币/背包 —— 用户确认后
- [ ] P3 怪谈神庙（复用 rumor）—— 用户确认后
- [ ] AgentSociety² 平台实验移植（比赛主链路，等待队伍注册 API Key）
- [ ] 预实验指标细化：跨日矩阵持续性与演化曲线（比赛主链路）
