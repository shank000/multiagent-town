# 运行与证据验证记录

> 机制与压力数据日期：2026-08-23；SDK 合同复验日期：2026-08-29；本地真实模型并发回归日期：2026-08-30；终态一致性与对话质量门复验日期：2026-08-31。每项证据按其能够支持的范围解释。

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
