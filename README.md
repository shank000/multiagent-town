# MultiAgent Town

斯坦福小镇式多智能体交互系统（Generative Agents / Smallville 路线）。

## 项目状态

- [x] 调研报告（见 [SESSION.md](./SESSION.md)）
- [x] 技术方案文档（见 [docs/ai-town-design.md](./docs/ai-town-design.md)）
- [x] M0 骨架：世界状态 + 时间引擎 + LLM 网关 + 事件日志（4 agent 命令行观察）
- [ ] M1 认知核心：记忆流/检索/反思/规划闭环
- [ ] M2 空间呈现：Phaser 3 地图 + 心智面板 + 玩家扮演
- [ ] M3 社交涌现：关系网络 / 信息传播 / 事件广播
- [ ] M4 生产化：持久化/回放、成本治理、自动化评估

## 目录结构

```
multiagent-town/
├── README.md                 # 本文件
├── SESSION.md                # 会话存档（含完整调研报告）
└── docs/
    └── ai-town-design.md     # 技术方案文档（开发蓝图）
```

## 技术路线摘要

- 全栈 TypeScript（Node + Fastify），SQLite → Postgres/pgvector，bge-m3 中文 embedding
- 前端 Phaser 3 + React，地图 Tiled
- LLM 分层：DeepSeek-chat / Qwen-max（大模型层）+ 本地 Qwen-14B（小模型层）
- 时间 60x 加速；对话摘要回写记忆流；结构化输出 + 对象树校验

详细设计见 [docs/ai-town-design.md](./docs/ai-town-design.md)。

## 运行（M0）

```bash
pnpm install
pnpm town                        # 60x 实时观察台（mock，离线）
pnpm town --until-minutes 1440 --speed 60   # 虚拟时钟快速跑 1 游戏日
pnpm replay --day 1              # 回放第 1 天事件时间线
pnpm test                        # 全部测试
pnpm acceptance                  # M0 验收测试
pnpm town-web                    # 像素小镇浏览器版（默认 mock，自动打开 http://127.0.0.1:8787）
```

> 像素小镇：浏览器里看 4 个像素 NPC 在小镇地图上活动、闲聊冒泡；可暂停/调速，点击角色看状态面板。真机：`LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=sk-xxx pnpm town-web`。

切换真机 DeepSeek（OpenAI 兼容）：

```bash
LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=sk-xxx pnpm town
```
