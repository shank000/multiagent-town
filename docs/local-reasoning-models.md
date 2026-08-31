# 本地推理模型配置

## 设计目标

每位居民拥有独立的 persona、记忆、关系、日记、信念和行为指导，但共享 Ollama 模型服务与模型权重。该结构能够保持个体心智隔离，同时避免为每个居民重复占用内存。

## 预设

| profile | complex / large | frequent / small | 适用场景 |
|---|---|---|---|
| `qwen3-single` | `qwen3:4b` | `qwen3:4b` | 默认；单模型、低切换开销 |
| `qwen3-balanced` | `qwen3:4b` Thinking | `qwen3:4b-instruct` | 本机实验推荐；深度反思与实时交互分层 |
| `qwen3-tiered` | `qwen3:8b` | `qwen3:1.7b` | 资源较充足；日记和对话质量优先 |
| `deepseek-tiered` | `deepseek-r1:8b` | `qwen3:1.7b` | 复杂反思与推理对照 |

模型能力与可用标签以 Ollama 的 [Qwen3 模型页](https://ollama.com/library/qwen3) 和 [DeepSeek-R1 模型页](https://ollama.com/library/deepseek-r1) 为准。系统调用 Ollama 官方 [`/api/chat`](https://docs.ollama.com/api/chat)，对需要推理的任务启用 `think`，并通过 `keep_alive` 降低连续模拟中的重复装载成本。

## 本机纯本地启动

模型下载完成后，Ollama 服务可以在无需账号的纯本地模式运行。服务终端只监听本机回环地址，并以单并发、单驻留模型适配 8GB 显存：

```powershell
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
$env:OLLAMA_CONTEXT_LENGTH = '8192'
ollama serve
```

应用还会为每次聊天请求显式发送 `num_ctx=8192`，因此通过桌面版或既有 Ollama 服务启动时也保持同一上下文条件。需要更长窗口时，可在启动小镇前设置 `$env:OLLAMA_NUM_CTX = '16384'`；该值会增加显存/内存占用，应在同一批实验中固定不变。

项目终端使用同一台机器上的服务：

```powershell
ollama pull qwen3:4b
ollama pull qwen3:4b-instruct
$env:LLM_PROVIDER = 'ollama'
$env:OLLAMA_PROFILE = 'qwen3-balanced'
$env:OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
$env:LLM_MAX_CONCURRENCY = '1'
$env:LLM_MAX_QUEUE = '96'
pnpm town-web --port 8787
```

逐居民的真实模型验收使用：

```powershell
pnpm test:agents:real
```

该入口在未指定环境变量时选用 `ollama + qwen3-balanced`，并明确拒绝 `LLM_PROVIDER=mock`。

分层 Qwen3：

```powershell
ollama pull qwen3:8b
ollama pull qwen3:1.7b
$env:LLM_PROVIDER = 'ollama'
$env:OLLAMA_PROFILE = 'qwen3-tiered'
pnpm town-web --port 8787
```

指定居民模型时使用 JSON 映射；未列出的居民继续使用 profile：

```powershell
$env:OLLAMA_AGENT_MODELS = '{"chen-mo":"qwen3:8b","lin-wanqing":"deepseek-r1:8b"}'
```

## 推理负载与高速观察

研究控制台右栏提供三个全局运行模式：`Mock` 用于确定性工程回归；`本地开源模型` 配置 Ollama 地址、高频模型、深度反思模型、上下文窗口和超时；`API` 配置兼容的 chat-completions 地址、模型、超时与内存凭据。三种模式均通过共享网关服务全部居民和全部平行世界。正式实验期间配置锁定；安全切换要求人物对话完整结束、居民思考完成结算，再暂停世界、停止实验并等待模型队列清空。连接检测和吞吐校准不进入居民记忆、关系证据或正式研究事件。

- 全部平行世界共享同一个有界调度器；本地单卡默认并发为 1、等待容量为 96。
- 优先级固定为：连贯对话与摘要 → 动作决策 → 日/小时规划 → 反思 → 事件重要性标注。
- 同优先级请求按世界轮询，避免 `w1`、`w2`、`w3` 因创建顺序产生稳定等待差异。
- 动作、日计划、小时规划、对话与对话摘要使用 Ollama structured outputs；字段、长度、数组规模和数值范围由请求级 JSON Schema 约束。动作 Schema 使用互斥分支约束 `idle` 的空目标与移动/交互的已知对象目标；应用层继续执行规范化、携带原因的低温修正与叙事安全回退。
- 每轮对话在写入事件、消息和关系证据前经过 `dialogue-turn/v2` 质量门：居民口语与日记、计划、审计记录、关系摘要分层；明确问题与普通陈述均需承接，4–6 句内形成推进或收束；换词复述、意象循环、无证据阅读经历、作品内容、居民身份与已完成世界事件均可证伪。候选可低温重写一次，保守路径按首句发起、中段追问、后段收束生成自然口语。事件 payload 保存校验状态、尝试次数与拒绝原因。
- 小时规划按居民合并，只提交最新时间段；已经失去时间意义的结果不会覆盖当前计划。
- 单次规划失败时保留已有计划并继续模拟，不会终止 Web 进程。
- 对话请求包含排队时间在内的墙钟期限；期限到达后会话记录为异常并释放双方行动锁。
- 60× 高速档使用固定墙钟频率的动作采样和稀疏小时规划。默认在等待队列达到容量的 75% 时暂缓虚拟时钟，降到 50% 后恢复；模型结果、日记与关系证据持续结算。
- 三个平行世界共用同一推进批次；每批要么全部推进、要么全部等待认知结算，避免条件组产生时间偏移。
- 顶栏“本地推理”状态显示生成、排队和认知背压；`GET /api/llm/status` 提供同一组结构化指标。
- Ollama 原生 `eval_count/eval_duration` 形成生成 tok/s，应用墙钟形成有效 tok/s 与 p50/p90 延迟。顶栏显示实测值；“自适应”以两次 structured-output 探针补足冷启动样本，并在 `1/5/10/30/60×` 档位中选择建议持续倍速。估计器同时纳入三世界 18 位居民的行动/小时规划到达率、模型并发容量和 35% 突发余量；首次深反思样本形成后还会把其墙钟成本一并纳入。60× 是统一运行上限。

后台事件重要性评分在模型评分名额满载时使用确定性规则分数，事件正文、参与者、时间和来源 ID 仍完整入库。该降级只作用于记忆检索权重，不生成居民发言、动作或反思文本。

动作决策的结构质量写入 `thought.payload.decisionQuality`；发生规范化、重试修正或安全回退时，同时写入 `action_decision_quality` 诊断事件。诊断事件保留在研究事件库中，不进入居民记忆、叙事时间线或现场气泡。

## 研究使用约束

- 正式配对实验在各条件之间固定实际模型、采样参数、profile 与居民覆盖映射。
- 正式实验固定 `LLM_MAX_CONCURRENCY`、`LLM_MAX_QUEUE`、运行倍速和调度版本，并导出队列等待指标。
- Replay 记录实际模型 ID、请求标识、提示哈希、原始响应和解析结果。
- 模型切换属于稳健性实验，不与关系历史主效应同时改变。
- 本地模型输出属于模拟智能体行为，不外推为真实人类群体结论。
- `mock` provider 保持确定性，用于工程回归和机制正控；不替代正式真实模型实验。
