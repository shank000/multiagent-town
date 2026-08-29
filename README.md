# MultiAgent Town

面向计算社会科学实验的多智能体社会涌现平台。系统以中文像素小镇为可观察环境，持续记录居民的互动、记忆、关系与伙伴选择，并提供平行世界对照、结构化 Replay、社会网络指标和可插拔分析层。

当前研究问题是：在候选伙伴数量相等时，关系历史的可访问性是否会让原本离散的互动形成依赖历史的伙伴选择，并随时间产生重复互动对、枢纽与低传递性的持久关系结构。

## 系统能力

- **平行世界**：`w1` 关系记忆开启、`w2` 关系记忆关闭、`w3` 谣言传播；世界状态、SQLite、日志、感知缓冲和实验状态彼此隔离。
- **社会实验**：每日伙伴选择、等价候选集、关系记忆与馈礼 2×2 因子、确定性种子、候选快照、缺失与恢复审计。
- **社会记录**：事件、对话、记忆、反思、计划、有向关系、馈礼、谣言、活动、声望与选择决策均可追溯。
- **结构指标**：同对重复率、互惠性、聚类系数、伙伴多样性、伙伴 HHI、窗口网络持久性与枢纽集中度。
- **研究控制台**：小镇、人物关系、人物属性/对话/世界状态三个视窗，支持聚焦、整数像素缩放、网络节点选择与指标切换。
- **深度统计**：`/stats.html` 按世界和日期查看运行统计；伙伴选择因果指标仍由实验测量引擎独立计算。
- **认知系统**：三因子记忆检索、日/小时规划、反思、多轮对话与摘要、情感/尊重关系、选择性谣言披露、公开活动和 PageRank 声望。
- **外部智能体协议**：`town-agent` CLI 与 `/api/guest/*` 让外部 AI 以访客身份感知和行动。
- **AgentSociety² 适配**：24 人正式实验矩阵、自定义 Agent/Environment、Replay schema、checkpoint 恢复、跨语言指标 parity 与数据质量门。
- **LLM Provider**：确定性 `mock`、DeepSeek API 与本地 Ollama。
- **工程约束**：TypeScript strict、Node.js 22、`node:http`、`node:sqlite`、零运行时依赖。

## 快速开始

```bash
pnpm install
pnpm town-web --port 8787
```

打开：

- 研究控制台：<http://127.0.0.1:8787/>
- 深度统计：<http://127.0.0.1:8787/stats.html>

`town-web` 每次默认创建带时间戳的新实验数据库，并为 `w1`、`w2`、`w3` 派生独立文件。临时演示可使用：

```bash
pnpm town-web --port 8787 --db :memory:
```

## LLM 配置

默认 `LLM_PROVIDER=mock`，可离线运行和测试。

DeepSeek：

```bash
LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=your-key pnpm town-web --port 8787
```

本地 Ollama：

```bash
ollama pull qwen2.5:7b
LLM_PROVIDER=ollama pnpm town-web --port 8787
```

| 变量 | 含义 | 默认值 |
|---|---|---|
| `LLM_PROVIDER` | `mock`、`deepseek` 或 `ollama` | `mock` |
| `OLLAMA_BASE_URL` | Ollama HTTP 服务 | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | large 层模型 | `qwen2.5:7b` |
| `OLLAMA_SMALL_MODEL` | small 层模型；留空时复用 large 模型 | 留空 |
| `OLLAMA_TIMEOUT_MS` | 单次请求超时 | `120000` |

Ollama 使用原生 `/api/chat`、非流式响应和 JSON 模式，按请求层级选择模型；本地推理成本计量为零。

## 实验与验证

本地参考实验：

```bash
pnpm experiment --days 20 --seeds 3
pnpm experiment --days 60 --seeds 5 --format json
```

工程验证：

```bash
pnpm typecheck
pnpm test
pnpm build:web
```

AgentSociety² 适配验证：

```powershell
cd platform/agentsociety2
python -m venv .venv
$env:PYTHONPATH='.'
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe tests/real_sdk_smoke.py
.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -v
```

Linux/macOS 将虚拟环境解释器替换为 `.venv/bin/python`，并使用 `export PYTHONPATH=.`。

## 外部 AI 访客

```bash
pnpm town-agent login --name 爱丽丝
pnpm town-agent look --name 爱丽丝
pnpm town-agent map
pnpm town-agent walk --name 爱丽丝 --target 湖边公园
pnpm town-agent interact --name 爱丽丝 --target 林间咖啡馆
pnpm town-agent say --name 爱丽丝 --text 大家好
pnpm town-agent status --name 爱丽丝
```

访客与常驻居民共享事件、记忆和关系机制；感知数据按世界隔离。

## 目录

```text
src/core/                    世界、时间、寻路与状态机
src/engine/                  认知、社交、实验、指标与统计
src/store/                   SQLite 事件、记忆与关系存储
src/llm/                     Mock、DeepSeek、Ollama 与统一网关
src/web/                     多世界 HTTP/SSE 服务与浏览器客户端
platform/agentsociety2/      正式平台适配、协议、分析与验证器
public/                      三视窗控制台、统计页与许可素材
tests/                       Node.js 回归与端到端测试
docs/                        研究设计、比赛报告与运行证据
```

## 研究文档

- [竞赛执行计划](docs/competition-execution-plan.md)
- [赛道 7 分析](docs/competition-track7-analysis.md)
- [研究叙事](docs/research-narrative.md)
- [报告草稿](docs/competition-report-draft.md)
- [AgentSociety² 移植合同](docs/agentsociety2-migration-contract.md)
- [运行与证据验证](docs/runtime-validation.md)
- [工程架构](docs/ARCHITECTURE.md)
- [素材许可与署名](ATTRIBUTION.md)

所有图像素材采用可验证的 CC0/CC-BY 来源，许可与署名以 `ATTRIBUTION.md` 为准。
