# 运行与证据验证记录

> 机制与压力数据日期：2026-08-23；SDK 合同复验日期：2026-08-29。每项证据按其能够支持的范围解释。

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

- Python 3.12.13
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

## 3. 正式数据采集硬门

以下证据必须由在线工作区生成后才能开始正式 60 天矩阵：

1. 真实 `AgentSociety.init/step/close` 至少完成一个模型伙伴选择；Replay 记录实际模型 ID、请求 ID、采样参数、渲染提示哈希、原始响应和解析结果。
2. 24 agent×2 天×4 主条件容量标定记录 completion/token/失败/fallback/墙钟/checkpoint 大小。
3. append 后、已写集合更新后、checkpoint 后三处故障注入证明恢复不产生重复 Replay 行。
4. 在线互动摘要与馈礼事实进入下一轮可见 dyadic history；none 条件保持零历史派生字段和零处理标签。
5. validator 对 60 个完整轮次、fallback≤5%、零跳轮、唯一事件 ID、连续序列和配对候选顺序全部通过。

AgentSociety² 官方说明自定义环境通过 `EnvBase`、`@tool` 与 `step` 接入，并使用 workspace 钩子恢复；Replay 是 append-only JSONL，跨 shard 必须显式排序：

- https://agentsociety2.readthedocs.io/en/latest/env_modules.html
- https://agentsociety2.readthedocs.io/en/latest/storage.html
