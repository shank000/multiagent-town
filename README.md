# MultiAgent Town

斯坦福「Generative Agents / Smallville」风格的**中文像素小镇**多智能体交互系统。

小镇里生活着六位居民：林晚晴（咖啡馆老板）、陈默（书店老板）、沈屿（画家）、周岚（邮差）、白露（花店老板）、老周（渔夫）。每一位都有自己的作息、记忆、目标与性格，会工作、闲聊、经营关系、传播消息，也会在夜晚睡床、雨后看湖。

## 功能

- **世界与时间**：48×44 像素小镇，A* 寻路，可变速时钟（1x–360x），暂停/快进
- **浏览器画面**：Canvas 2D 全屏地图，滚轮缩放、双击复位、屋顶剖切看建筑内饰
- **认知核心**：记忆流（3 因子检索）、日/小时规划、反思、多轮对话与摘要、访谈
- **社交涌现**：情感/尊重双维关系、声望榜（Weighted PageRank）、公开活动（派对/读书会/集市）、谣言传播
- **居民档案**：性别/外貌/爱好/技能/价值观/动机/背景故事，点击 NPC 查看
- **家具与动作**：床/沙发/咖啡桌作息，坐/睡姿态与动作图标，粒子特效（Zzz/蒸汽/星光/信封）
- **环境**：昼夜平滑过渡、河水波光、炊烟、萤火虫、路灯辉光、晴雨天气（雨丝/落地水花）
- **玩家扮演**：输入指令指挥任意 NPC，观看其执行
- **零运行时依赖**：TypeScript 严格模式，Node 22 `node:sqlite`，无框架

## 运行

```bash
pnpm install
pnpm town-web --port 8787     # 浏览器打开 http://127.0.0.1:8787
```

真机 DeepSeek（OpenAI 兼容）：

```bash
LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=sk-xxx pnpm town-web --port 8787
```

其他命令：

```bash
pnpm test                        # 全部测试（127 项）
pnpm typecheck                   # tsc --noEmit
pnpm town --until-minutes 1440 --speed 60   # 虚拟时钟快跑 1 游戏日（无界面）
pnpm replay --day 1              # 回放第 1 天事件时间线
pnpm interview -- --agent 林晚晴 --question "今天做了什么"   # 上帝视角访谈
```

## 目录结构

```
multiagent-town/
├── README.md                # 本文件
├── ATTRIBUTION.md           # 素材许可署名
├── src/
│   ├── core/                # 世界状态 / 寻路 / 时间 / 状态机 / 天气
│   ├── engine/              # 种子数据 / 循环 / 记忆 / 反思 / 规划 / 对话 / 社交 / 谣言 / 活动
│   ├── llm/                 # 提示词库 / 网关 / mock 与 DeepSeek 实现
│   ├── store/               # SQLite（node:sqlite）持久化
│   ├── web/                 # HTTP 服务 / SSE 快照 / 客户端（Canvas 渲染）
│   └── cli/                 # run / replay / interview / town-web
├── tests/                   # node:test 测试（127 项）
├── public/                  # 前端页面、样式、像素素材
└── docs/
    ├── ai-town-design.md    # 技术方案设计
    └── agentopia-analysis.md # 论文 Agentopia 机制映射分析
```

## 文档

- 设计文档：[docs/ai-town-design.md](docs/ai-town-design.md)
- 社交机制（Agentopia 论文）分析：[docs/agentopia-analysis.md](docs/agentopia-analysis.md)
- 素材许可与署名：[ATTRIBUTION.md](ATTRIBUTION.md)
