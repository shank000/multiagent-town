# AgentSociety² 正式实验工作区

本目录承载赛道 7 的正式平台实验，平台版本固定为 AgentSociety² 2.8.4，Python 版本范围为 3.11–3.13。

## 实验设计

- 主实验：N=24，60 天，5 个固定种子，关系记忆 `none/full` × 馈礼 `off/on` 的 2×2 设计。
- 稳健性扩展：每位候选仅暴露最近 3 次互动，分别配对馈礼开/关条件。
- 候选控制：每轮候选均为除本人外的全部参与者，数量固定为 N−1；配对条件使用相同的候选顺序。
- 决策控制：所有主实验条件使用同一 LLM、Skill、提示模板、采样参数、解析器、重试和 seeded fallback。记忆处理只改变候选历史的可见内容，馈礼处理只发生在选择事件落盘之后。
- Replay：伙伴选择事件使用 `partner_choice.choice_event` 数据集，并按 `day/round_id/chooser_id/event_seq` 确定性排序。

规范清单位于 `experiment-manifest.v1.json`；TypeScript 协议与离线验证器位于 `src/engine/experiment-contract.ts`。

## 平台环境

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

平台环境模块采用 `EnvBase + @tool + async step`；动态实验状态写入 workspace checkpoint，选择、馈礼、互动和关系状态写入独立 Replay 数据集。
