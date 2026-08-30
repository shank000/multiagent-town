# MultiAgent Town

面向计算社会科学实验的多智能体社会涌现平台。系统以中文像素小镇为可观察环境，持续记录居民的互动、记忆、关系与伙伴选择，并提供平行世界对照、结构化 Replay、社会网络指标和可插拔分析层。

当前研究问题是：在候选伙伴数量相等时，关系历史的可访问性是否会让原本离散的互动形成依赖历史的伙伴选择，并随时间产生重复互动对、枢纽与低传递性的持久关系结构。

## 系统能力

- **实验工作空间**：从初始名称、随机种子、速度、默认天数和居民档案创建独立小镇；`w1` 关系记忆开启、`w2` 关系记忆关闭、`w3` 谣言传播可任意选择 1–3 个加载，未选世界不占用引擎、数据库或模型队列。
- **社会实验**：每日伙伴选择、等价候选集、关系记忆与馈礼 2×2 因子、确定性种子、候选快照、缺失与恢复审计。
- **社会记录**：事件、持久会话与逐轮发言、记忆、日记反思、计划、有向关系证据、观察、帮助、分享、邀请、协作、馈礼、谣言、活动、声望与选择决策均可追溯。
- **日常生活世界**：公告栏、集市摊位、饮水泉、湖边长椅、喂鸟台、水泵、共享菜园、工具架和候车亭均有可供动作、感官线索与现场状态；每天四个时段轮换发生自然、商业、照料和邻里事件，只有附近居民形成观察记忆。
- **世界事实契约**：公共活动依次经过预告、步行前往、现场到场核验与开始/取消；共同经历只由实际到场者形成，花店馈礼同时记录购买来源、履约地点与双方库存。对话首轮即注入真实场景和对象功能，入库前拦截缺少完成证据的活动、馈礼与共同经历叙述。
- **结构指标**：同对重复率、互惠性、聚类系数、伙伴多样性、伙伴 HHI、窗口网络持久性与枢纽集中度。
- **研究控制台**：小镇、人物关系、人物属性/对话/世界状态三个视窗；统一像素头像贯穿名册、档案、对话与时间线；居民编辑器可定义身份背景、能力、人格、初始心态和头像；6+4 测量支持悬停、点击、键盘定位、时间窗/Ego/阈值筛选及双人互动—关系—结构证据检查器。
- **深度统计**：`/stats.html` 按世界和日期查看运行统计；伙伴选择因果指标仍由实验测量引擎独立计算。
- **后端可观测性**：`/logs.html` 实时筛选当前进程的启动、模型、规划、对话、警告与异常日志，可复制文件路径并下载完整脱敏 JSONL。
- **认知系统**：三因子记忆检索、日/小时规划、证据约束日记、可修订信念与行为指引、多轮对话与摘要、选择性谣言披露、公开活动和 PageRank 声望。
- **外部智能体协议**：`town-agent` CLI 与 `/api/guest/*` 让外部 AI 以访客身份感知和行动。
- **AgentSociety² 适配**：24 人正式实验矩阵、自定义 Agent/Environment、Replay schema、checkpoint 恢复、跨语言指标 parity 与数据质量门。
- **LLM Provider**：确定性 `mock`、DeepSeek API 与本地 Ollama；共享网关提供优先级、有界队列、跨世界轮询与高速认知背压。
- **工程约束**：TypeScript strict、Node.js 22、`node:http`、`node:sqlite`、零运行时依赖。

## 快速开始

不使用命令行的 Windows 协作者可直接运行发布包中的 `MultiagentTown.exe`。程序内置 Node.js 与研究控制台，自动连接本机 Ollama、准备所需 Qwen3 模型并在浏览器打开三视窗界面。使用与构建说明见 [Windows 单文件版](docs/windows-executable.md)。

```bash
pnpm install
pnpm town-web --port 8787
```

打开：

- 研究控制台：<http://127.0.0.1:8787/>
- 深度统计：<http://127.0.0.1:8787/stats.html>
- 后端日志：<http://127.0.0.1:8787/logs.html>

`town-web` 默认只加载 `w1`，每次使用带时间戳的新实验工作空间。在右栏点击“新建小镇”可从初始配置加载任意一个、两个或三个世界；也可在启动时选择：

```bash
pnpm town-web --port 8787 --worlds mem-on,mem-off,rumor --workspace-name "三组对照" --seed 42
```

临时演示可使用：

```bash
pnpm town-web --port 8787 --db :memory:
```

人物互动、记忆、反思、关系证据等研究记录只写入本次加载世界对应的 `data/runs/town-…-w1.sqlite`、`-w2.sqlite` 或 `-w3.sqlite`。新建小镇使用新的数据库前缀和独立 `*.runtime.jsonl`；旧工作空间完整封存。后端日志与研究事件库分离，API Key、Authorization、密码和令牌在写入前会被脱敏。

## LLM 配置

默认 `LLM_PROVIDER=mock`，可离线运行和测试。

DeepSeek：

```bash
LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=your-key pnpm town-web --port 8787
```

本地 Ollama：

```bash
ollama pull qwen3:4b
ollama pull qwen3:4b-instruct
LLM_PROVIDER=ollama OLLAMA_PROFILE=qwen3-balanced pnpm town-web --port 8787
```

PowerShell 可使用：

```powershell
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_HOST = '127.0.0.1:11434'
ollama serve
```

在项目终端中连接本机服务：

```powershell
$env:LLM_PROVIDER = 'ollama'
$env:OLLAMA_PROFILE = 'qwen3-balanced'
$env:OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
pnpm town-web --port 8787
```

| 变量 | 含义 | 默认值 |
|---|---|---|
| `LLM_PROVIDER` | `mock`、`deepseek` 或 `ollama` | `mock` |
| `OLLAMA_BASE_URL` | Ollama HTTP 服务 | `http://127.0.0.1:11434` |
| `OLLAMA_PROFILE` | `qwen3-single`、`qwen3-balanced`、`qwen3-tiered` 或 `deepseek-tiered` | `qwen3-single` |
| `OLLAMA_MODEL` | 覆盖 profile 的 large 层模型 | profile 决定 |
| `OLLAMA_SMALL_MODEL` | 覆盖 profile 的 small 层模型 | profile 决定 |
| `OLLAMA_AGENT_MODELS` | 居民 ID 到模型名的 JSON 映射 | 未设置 |
| `OLLAMA_KEEP_ALIVE` | 模型在内存中的驻留时间 | `10m` |
| `OLLAMA_NUM_CTX` | 每次模型请求的上下文窗口（token） | `8192` |
| `OLLAMA_TIMEOUT_MS` | 单次请求超时 | `120000` |
| `LLM_MAX_CONCURRENCY` | 共享模型最大并发；本地单卡建议保持 1 | Ollama 为 `1` |
| `LLM_MAX_QUEUE` | 有界推理等待队列容量 | Ollama 为 `96` |
| `TOWN_PROFILE_PATH` | CLI 居民档案 JSON 路径；设置后启动载入并持续保存 | 未设置 |

研究控制台右栏的“Agent 模型运行方式”可在当前进程中统一选择 `Mock`、本地 `Ollama` 或远程 `API`。该选择同时作用于当前工作空间已加载世界中全部居民的行动、规划、对话、摘要和反思。连接检测不写入人物记忆或社会关系；正式应用要求人物对话已完整结束、世界已暂停、实验未运行、居民决策已结算且推理队列为空。配置变更会以不含密钥的系统事件写入全部已加载世界，API Key 只驻留于当前服务内存，不回显、不写日志。

`qwen3-balanced` 使用 Qwen3 4B 处理结构化日记反思，用同系 4B Instruct 处理行动、规划与对话，是当前 8GB 显存本机的推荐设置。`qwen3-single` 保留单模型路径；`qwen3-tiered` 使用 Qwen3 8B/1.7B；`deepseek-tiered` 使用 DeepSeek-R1 8B/Qwen3 1.7B。居民的 persona、记忆、关系和心智状态始终独立，模型权重由 Ollama 共享。对话、动作、规划、反思和后台标注依次进入共享优先级队列；同优先级按已加载世界轮询。动作、规划、对话、摘要和日记由请求级 JSON Schema 约束；最终日记把事件证据、模型心态和人物价值分层投影，模型修辞不会成为新增事实。每轮对话在入库前检查前文承接、会话内重复、机械套话以及无证据人名、作品和社会角色身份；不合格候选重写一次，最终使用证据引用式安全回答。高速模式采用规划合并、动作降采样、已加载世界同步批次与虚拟时钟背压，世界速度上限为 60×。顶栏“自适应”会实测 Ollama 生成速率与端到端延迟，并将全部已加载世界设为当前硬件的建议持续倍速。完整说明见 [本地推理模型配置](docs/local-reasoning-models.md)。

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

当前工程基线为 339 项 `node:test`；AgentSociety² 工作区另有 22 项 Python 协议测试，并通过 2.8.4 SDK/Replay/checkpoint 冒烟。

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
