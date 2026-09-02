# 伙伴选择指标语义

伙伴选择测量保留原始概率、机会基线、标准化结果和可估计性状态。所有时间序列使用实际实验日作为横轴；缺失日期保持为折线断点，零值表示有效观测得到的零。

## 互惠的两种量

设第 `d-1` 天出现有向选择 `A→B`，第 `d` 天出现反向选择 `B→A`：

- `recipRate`（跨日互惠率）=`反向回选数 / 前一日有效选择数`，取值 `0..1`。
- `recipBaseline`（等候选随机基线）=`1 / (当日有效行动者数 - 1)`。
- `recip`（机会校正互惠倍数）=`recipRate / recipBaseline`。`1` 表示与等候选随机选择一致，`>1` 表示高于该基线，`<1` 表示低于该基线；它是倍数而非概率。

控制台分别展示“互惠率”和“互惠倍数”。互惠率图用虚线给出对应日期的随机基线；互惠倍数图用 `1.0` 虚线给出标准化基线。正式分析保留 `recip` 作为机会校正结构诊断，同时导出 `recipRate` 与 `recipBaseline` 供复核。

## 双 7 日矩阵持续性

`persistence` 比较两个相邻、非重叠且各自完整的 7 日窗口：

```text
Pearson r(vec(Σ M_previous_7d), vec(Σ M_current_7d))
```

第一个有效终点是第 14 个连续选择日。连续选择日少于 14 天时，状态为 `awaiting_window`；该状态与持续性为 `0` 明确区分。日期中断后，只有重新形成完整连续双窗口的终点才进入序列。

## API 契约

`GET /api/experiment/metrics?worldId=...` 返回：

- 八条研究序列：`repeat`、`recipRate`、`recip`、`clus`、`div`、`hhi`、`persistence`、`hub`；
- `recipBaseline`：与 `recipRate` 对齐的机会基线；
- `seriesDays`：每条研究序列中每个值对应的实际实验日；
- `availability`：`ready`、`no_observations`、`awaiting_adjacent_days` 或 `awaiting_window`，以及有效点数、选择日数、最长连续选择日数和所需连续日数；
- `pairs`：累计有向伙伴选择计数。

导出的指标 JSON 保留以上字段，使图表、报告和复核脚本共享同一缺失语义。
