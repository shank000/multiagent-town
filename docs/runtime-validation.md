# 运行与证据验证记录

> 机制与压力数据日期：2026-08-23；SDK 合同复验日期：2026-08-29；本地真实模型并发回归日期：2026-08-30；终态一致性与对话质量门复验日期：2026-08-31。每项证据按其能够支持的范围解释。

## 规划与叙事的世界边界

`MindEngine` 在每次调度规划前把正在运行的 `WorldState` 绑定到规划器。日计划和小时安排只可引用当前居民名册与当前对象表；小时地点统一保存为对象 id，且每个时间必须属于请求的小时。模型结果先经纯评估器检查，越界时以低温修复一次，再以人物作息和现存地点形成确定性安排。只有通过相同评估器的日计划会写入 `plans` 和 `kind=plan` 记忆。

动作决策同时检查内心独白：程序字段、程序地点编号、名册外社交对象和内部校验话术会进入 `ungrounded_narrative` 质量记录，并触发现有的一次修复与安全回退。真实模型门禁支持：

```powershell
$env:LLM_PROVIDER='ollama'
$env:OLLAMA_PROFILE='qwen3-balanced'
$env:REAL_AGENT_NAMES='白露,老周'
$env:REAL_AGENT_CHECKS='planning,action'
pnpm test:agents:real
```

## 可复用的真实模型运行耐久门

运行器只连接本地 Ollama（默认使用既有 `qwen3-balanced` profile 和 `127.0.0.1:11434`），不会启动、停止或重置任何服务。所有 SQLite 与 JSON 输出必须位于已被 Git 忽略的 `data/` 目录。开发冒烟命令：

```bash
pnpm test:runtime:real -- --worlds 1 --waves 1 --pairs-per-world 3 --forced-timeout-ms 5 --output data/runtime-soak/dev-smoke
```

需要形成内存稳定性证据时使用至少 3 个波次；例如保留默认单世界规模：

```bash
pnpm test:runtime:real -- --worlds 1 --waves 3 --pairs-per-world 3 --forced-timeout-ms 5 --output data/runtime-soak/local-stability
```

参数采用严格边界：`worlds=1..3`、`waves=1..8`、`pairs-per-world=1..3`、`forced-timeout-ms=1..1000`。`--output` 可指向目录或 `.json` 文件，但必须在仓库 `data/` 下且尚不存在；运行器拒绝复用旧数据库或覆盖既有报告。运行器总是先安全落盘 JSON 报告，再根据十项合同设置退出码；任意合同失败即为非零。

十项合同固定为：真实 provider、正常会话数量、正常终态与 4–6 轮限制、完整 queued/started/completed 生命周期、共享队列压力有观测且不越界、真实 Ollama 超时诊断、超时后的安全 fallback 完成、SQLite 完整性/时间线/消息序列、稳定内存、干净排空与关闭。报告同时以纯数值 `durationMs` 保存整个运行、normal phase 与 timeout phase 的墙钟耗时，便于复核运行规模；其余只保存计数、状态、时延、模型名和已清洗错误，不保存提示正文、消息正文或凭据。

内存检查要求以 `node --expose-gc` 取得基线和逐波次 post-GC 检查点。wave 1 完全排除并只作为热身，wave 2 是稳定区间基线；总波次仍必须至少为 3。post-warmup heap 净增长不得超过 `max(32 MiB, wave 2 heap×25%)`，heap 线性斜率不得超过 `max(16 MiB/波, wave 2 heap×12%/波)`；RSS 净增长不得超过 `max(64 MiB, wave 2 RSS×25%)`，RSS 线性斜率不得超过 `max(32 MiB/波, wave 2 RSS×12%/波)`。四个边界必须共同通过，因此 SQLite/native/缓冲区的 RSS 增长不会被仅检查 JS heap 的门漏掉；RSS 使用加倍绝对余量以吸收 V8、SQLite 页缓存和本地缓冲区的正常驻留。单波开发冒烟会明确报告 `insufficient`，并使 `memory.stabilized` 合同失败；它可以验证执行路径，却不能声称长运行稳定。`global.gc` 不可用同样不能通过该合同。

该门验证的是运行工程合同：真实生成、排队、超时恢复、持久化不变量和进程内存边界。它不估计、不支持、也不应被解释为任何社会科学处理效应或人物行为效应；正式科学结论仍必须来自预注册设计与独立分析。

## 1. 本地 TypeScript 机制正控

命令：

```bash
pnpm experiment --days 20 --seeds 3 --format json
pnpm experiment --days 60 --seeds 5 --format json
```

| 规模 | 运行结果 | 墙钟时间 | 峰值 RSS | 数据 |
|---|---|---:|---:|---|
| 20 天×3 seed×4 条件 | exit 0 | 14.03 s | 163,128 KB | `docs/data/local-reference-pilot-20d-3seed.v1.json` |
| 60 天×5 seed×4 条件 | exit 0 | 2:41.96 | 170,680 KB | `docs/data/local-reference-stress-60d-5seed.v1.json` |

两个文件保存每个独立 seed 的汇总值。它们证明本地参考策略、指标链和 60 天运行边界可执行；不估计正式 LLM 历史可见性效应，也不代表 AgentSociety² 在线 token 或墙钟成本。

## 2. AgentSociety² SDK 合同冒烟

环境指纹：

- Python 3.11.16（Windows AMD64，仓库隔离 `.venv`）
- `agentsociety2==2.8.4`
- `mcp==1.29.1`

命令：

```bash
export PYTHONPATH="$PWD/platform/agentsociety2"
export WORKSPACE_PATH="$PWD/platform/agentsociety2"
export AGENTSOCIETY_LLM_API_KEY=offline-contract-smoke
python platform/agentsociety2/tests/real_sdk_smoke.py
```

结果：`AgentSociety 2.8.4 SDK/Replay/checkpoint smoke: ok`。

该门覆盖自定义 agent/environment 扫描、工具注册、处理标签不进入模型提示、四个 Replay dataset 的 schema/写入/读取、有向关系 entity key 与受控 checkpoint/restore。固定选择在冒烟数据中标为 `tool_submission`，因此该结果不宣称执行过在线 LLM 决策。

## 3. 本地真实模型并发回归

并发压力证据配置：Ollama 纯本地回环服务、`qwen3:4b-instruct`、单模型单并发、应用等待队列 96、三个平行世界与批量跨越伙伴选择时刻。当前产品世界速度上限为 60×，并提供 0.05×—60× 离散档位、认知同步屏障和持续自适应跟速。

| 验证项 | 结果 |
|---|---|
| 三世界时钟 | 全程严格相同 |
| Ollama 在途请求 | 1 |
| 应用队列峰值 | 45 / 96 |
| Ollama 已建立 TCP 连接 | 2 个端点记录（单个请求连接） |
| `w1` / `w2` 真实会话 | 两个世界均形成 2 个持久会话并生成多轮台词 |
| 逐居民真实验收 | 行动/对话/世界事实/反思 24/24；世界事实专项 6/6；质量门升级后对话专项 6/6；动作互斥 Schema 升级后专项 6/6 |
| 冷启动吞吐校准 | 112.9 tok/s；有效 93.8 tok/s；p90 1,631 ms；18 居民负载建议 1× |
| 最新逐居民真实模型验收 | `qwen3:4b` / `qwen3:4b-instruct`；林晚晴与沈屿的行动、对话、世界事实、反思 8/8 |
| 对话质量门真机验收 | `qwen3:4b-instruct` 单并发、8192 上下文；陈默与沈屿的对话/世界事实 4/4，7 次真实 completion 均由本地 Ollama 提供；陈默在第二候选准确承接《乡土中国》，两位居民均把活动预告与馈礼意向保持为未发生事实；错误候选的拒绝原因进入 `dialogue-turn/v2` 诊断 |
| 自动化回归 | 独立 worktree 中 `pnpm test` 399/399；`pnpm typecheck` 通过；`pnpm build:web` 通过 |

该门证明本地真实模型在高速三世界观察下能够受控排队、优先生成对话并保持条件组时钟一致；它不用于估计社会科学效应。

## 4. 有限运行终态与本地长时稳定性

60 天本地小镇耐久门连续推进 86,400 游戏分钟，墙钟 579.35 秒，峰值工作集约 108.5 MB；SQLite `integrity_check=ok`。数据库包含 12,770 条事件、14,584 条记忆、720 条反思、366 份计划、1,028 条消息、22 条当前关系和 258 个会话，长运行期间未出现持续内存增长或进程崩溃。

有限运行终态契约在独立工作树复验：世界停止时先排空模型调用，再把仍活跃的会话写为 `interrupted`，把安排会话写入 `failed + interrupted` 生命周期，完整会话保持 `completed`。1 天终点样本得到 3 个 `completed`、2 个 `interrupted`、0 个 `active`；结束时间早于开始时间的记录为 0，SQLite `integrity_check=ok`。旧版会话表在事务内迁移并保留既有记录与索引。

## 5. Windows 协作包

`dist/MultiagentTown-Windows-x64/MultiagentTown.exe` 与对应 ZIP 已按当前源码重新构建。可执行文件本地冒烟使用 Ollama 真模型，验证默认 1 个世界、每世界 6 位居民和 1—3 世界选择性加载；结果为 `SMOKE_OK real_model=true worlds=1 agents_per_world=6 selective_loading=true`。

## 6. 正式数据采集硬门

以下证据必须由在线工作区生成后才能开始正式 60 天矩阵：

1. 真实 `AgentSociety.init/step/close` 至少完成一个模型伙伴选择；Replay 记录实际模型 ID、请求 ID、采样参数、渲染提示哈希、原始响应和解析结果。
2. 24 agent×2 天×4 主条件容量标定记录 completion/token/失败/fallback/墙钟/checkpoint 大小。
3. append 后、已写集合更新后、checkpoint 后三处故障注入证明恢复不产生重复 Replay 行。
4. 在线互动摘要与馈礼事实进入下一轮可见 dyadic history；none 条件保持零历史派生字段和零处理标签。
5. validator 对 60 个完整轮次、fallback≤5%、零跳轮、唯一事件 ID、连续序列和配对候选顺序全部通过。

AgentSociety² 官方说明自定义环境通过 `EnvBase`、`@tool` 与 `step` 接入，并使用 workspace 钩子恢复；Replay 是 append-only JSONL，跨 shard 必须显式排序：

- https://agentsociety2.readthedocs.io/en/latest/env_modules.html
- https://agentsociety2.readthedocs.io/en/latest/storage.html
