// 数据统计与分析页面客户端：拉取 /api/stats 报告，渲染为纯 HTML 表格 + CSS 条形图。
// 渲染函数保持 DOM 无关（可被 node 测试直接调用）；DOM 绑定只在浏览器环境执行。

import type { TownReport } from '../../engine/analyze';
import { escapeHtml } from './panel';

const esc = (s: string): string => escapeHtml(s);

/** 数字格式化：保留 up 位小数并去掉尾零（"12.00"→"12"，"0.50"→"0.5"） */
export function fmt(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '0';
  return v.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function barRow(label: string, count: number, max: number, valueText?: string): string {
  const pct = max > 0 ? Math.max(1, Math.round((count / max) * 100)) : 0;
  return `<div class="srow"><span class="slabel">${esc(label)}</span><div class="sbar"><div class="sbar-fill" style="width:${Math.min(100, pct)}%"></div></div><span class="sval">${esc(valueText ?? String(count))}</span></div>`;
}

function section(title: string, inner: string): string {
  return `<section class="stats-sec"><h2>${esc(title)}</h2>${inner}</section>`;
}

function cards(entries: [string, string][]): string {
  return `<div class="cards">${entries.map(([num, label]) =>
    `<div class="stat-card"><div class="stat-num">${esc(num)}</div><div class="stat-label">${esc(label)}</div></div>`).join('')}</div>`;
}

function table(headers: string[], rows: string[][]): string {
  return `<table class="stats-table"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function emptyHint(msg: string): string {
  return `<p class="stats-empty">${esc(msg)}</p>`;
}

export function renderOverview(r: TownReport): string {
  const c = r.overview.counts;
  const perDayAvg = r.overview.days > 0 ? Math.round(c.events / r.overview.days) : 0;
  const agents = r.overview.agents.map((a) => a.name).join('、');
  const activeDays = r.events.perDay.length;
  return section('概览', cards([
    [`第 ${r.overview.days} 天`, '已模拟天数'],
    [String(c.events), '事件总数'],
    [String(perDayAvg), '日均事件'],
    [String(c.memories), '记忆'],
    [String(c.reflections), '反思'],
    [String(c.plans), '计划'],
    [String(c.messages), '对话消息'],
    [String(c.relationships), '关系记录'],
    [String(c.rumors), '谣言记录'],
    [String(activeDays), '有事件的天数'],
  ]) + `<p class="stats-note">居民：${esc(agents)}</p>`);
}

export function renderEvents(r: TownReport): string {
  const e = r.events;
  if (!e.total) return section('事件', emptyHint(r.overview.agents.length ? '还没有事件数据，先运行小镇让居民生活一会儿。' : '库中没有任何事件。'));
  const maxType = Math.max(...Object.values(e.byType));
  const maxKind = Math.max(...Object.values(e.byPayloadKind));
  const maxDay = e.perDay.length ? Math.max(...e.perDay.map((d) => d.count)) : 0;
  const maxHour = e.perHour.length ? Math.max(...e.perHour.map((h) => h.count)) : 0;
  const perDay = e.perDay.length > 7
    ? `<details class="stats-det"><summary>每日事件（共 ${e.perDay.length} 天）</summary>${e.perDay.map((d) => barRow(`第${d.day}天`, d.count, maxDay)).join('')}</details>`
    : e.perDay.map((d) => barRow(`第${d.day}天`, d.count, maxDay)).join('');
  return section('事件', cards([
    [String(e.total), '事件总数'],
    [String(e.perHour.length * 2), '覆盖时段(小时)'],
    [String(e.topActors.length ? e.topActors[0].name : '-'), '最活跃居民'],
  ])
    + section('按类型', Object.entries(e.byType).map(([k, v]) => barRow(k, v, maxType)).join(''))
    + section('按子类型 payload.kind', Object.entries(e.byPayloadKind).map(([k, v]) => barRow(k, v, maxKind)).join(''))
    + section('每日趋势', perDay)
    + section('时段分布（2 小时档）', e.perHour.map((h) => barRow(h.hour, h.count, maxHour)).join(''))
    + section('最活跃居民 Top' + e.topActors.length, table(['居民', '事件数'], e.topActors.map((a) => [a.name, String(a.count)])))
    + section('最常活动地点 Top' + e.topLocations.length, table(['地点', '事件数'], e.topLocations.map((l) => [l.location, String(l.count)]))));
}

export function renderMemories(r: TownReport): string {
  const m = r.memories;
  if (!m.total) return section('记忆', emptyHint('暂无记忆数据（需 MindEngine 运行，例如用真机 LLM 或先跑一天）。'));
  const maxKind = Math.max(...Object.values(m.byKind));
  const maxAgent = Math.max(...m.byAgent.map((a) => a.count));
  const maxHist = Math.max(...m.importanceHist.map((h) => h.count));
  return section('记忆', cards([
    [String(m.total), '记忆总数'],
    [fmt(m.perDayRate), '日均新增'],
    [fmt(m.importance.avg), 'importance 均值'],
    [String(m.importance.max), '最高'],
    [String(m.importance.min), '最低'],
    [fmt(m.neverAccessed.ratio * 100, 1) + '%', '从未被检索'],
  ])
    + section('按类型', Object.entries(m.byKind).map(([k, v]) => barRow(k, v, maxKind)).join(''))
    + section('importance 分布', m.importanceHist.map((h) => barRow(h.label, h.count, maxHist, `${h.count}（${fmt((h.count / m.total) * 100, 1)}%）`)).join(''))
    + section('各居民记忆量', m.byAgent.map((a) => barRow(a.name, a.count, maxAgent)).join('')));
}

export function renderReflections(r: TownReport): string {
  const s = r.reflections;
  if (!s.total) return section('反思', emptyHint('暂无反思（importance 累计超过阈值后才会触发）。'));
  return section('反思', cards([
    [String(s.total), '反思次数'],
    [fmt(s.avgTriggerScore), '平均触发分'],
    [fmt(s.avgInsights), '平均洞察条数'],
  ])
    + table(['居民', '反思次数'], s.byAgent.map((a) => [a.name, String(a.count)])));
}

export function renderPlans(r: TownReport): string {
  const p = r.plans;
  if (!p.total) return section('计划', emptyHint('暂无日/小时计划（MindEngine 在每天 5:00 生成）。'));
  return section('计划', cards([
    [String(p.total), '计划条数'],
    [String(p.daysCovered), '覆盖天数'],
    [fmt(p.avgHourlyItems), '平均小时条目'],
  ])
    + table(['居民', '计划条数'], p.byAgent.map((a) => [a.name, String(a.count)])));
}

export function renderDialogues(r: TownReport): string {
  const d = r.dialogues;
  if (!d.messages) return section('对话', emptyHint('暂无对话消息（居民长时间相邻才会闲聊）。'));
  const maxDay = d.perDay.length ? Math.max(...d.perDay.map((x) => x.count)) : 0;
  const maxPair = Math.max(...d.topPairs.map((p) => p.count));
  return section('对话', cards([
    [String(d.messages), '对话消息'],
    [String(d.conversations), '会话数'],
    [fmt(d.avgTurnsPerConversation), '平均每会话轮数'],
    [fmt(d.avgCharsPerMessage, 1), '平均每句字数'],
  ])
    + section('每日消息量', d.perDay.map((x) => barRow(`第${x.day}天`, x.count, maxDay)).join(''))
    + section('对话最多的配对', d.topPairs.map((p) => barRow(`${p.from} ↔ ${p.to}`, p.count, maxPair, String(p.count))).join('')));
}

export function renderRelationships(r: TownReport): string {
  const rel = r.relationships;
  if (!rel.pairs) return section('关系', emptyHint('暂无关系数据（对话结束摘要会写入双方关系）。'));
  return section('关系', cards([
    [String(rel.pairs), '有向关系记录'],
    [String(rel.reciprocalPairs), '双向关系对'],
    [fmt(rel.meanAffection), 'affection 均值'],
    [fmt(rel.meanRespect), 'respect 均值'],
    [String(rel.knowledgeEntries), '知识叙事条目'],
  ])
    + section('关系最紧密', table(['甲方', '乙方', '综合分'], rel.strongest.map((x) => [x.a, x.b, fmt(x.score)])))
    + section('关系最疏远', table(['甲方', '乙方', '综合分'], rel.mostHostile.map((x) => [x.a, x.b, fmt(x.score)]))));
}

export function renderStanding(r: TownReport): string {
  if (!r.standing.length) return section('声望榜', emptyHint('暂无声望（需有关系数据）。'));
  const max = Math.max(...r.standing.map((s) => s.score));
  return section('声望榜（Weighted PageRank）', r.standing.map((s, i) =>
    barRow(`${i + 1}. ${s.name}`, s.score, max, fmt(s.score, 4))).join(''));
}

export function renderRumors(r: TownReport): string {
  const ru = r.rumors;
  if (!ru.total) return section('谣言', emptyHint('暂无谣言（通过 /api/rumor 或对话选择性披露产生）。'));
  const maxHops = Math.max(...ru.hopsHist.map((h) => h.count));
  return section('谣言', cards([
    [String(ru.total), '谣言记录'],
    [String(ru.uniqueContents), '去重内容数'],
    [String(ru.maxHops), '最长传播链'],
  ])
    + section('传播链长度分布', ru.hopsHist.map((h) => barRow(`${h.hops} 跳`, h.count, maxHops)).join(''))
    + table(['源头', '记录数'], ru.topOrigins.map((o) => [o.name, String(o.count)])));
}

export function renderTownEvents(r: TownReport): string {
  if (!r.townEvents.length) return section('公开活动', emptyHint('暂无成行活动（≥2 人报名才会广播）。'));
  return section('公开活动', table(['时间', '活动', '参与人数'], r.townEvents.map((t) => [t.timeText, t.name, String(t.participants)])));
}

/** 组装完整页面 HTML（测试直接调用，渲染函数保持 DOM 无关） */
export function renderAll(r: TownReport): string {
  return renderOverview(r) + renderEvents(r) + renderMemories(r) + renderReflections(r)
    + renderPlans(r) + renderDialogues(r) + renderRelationships(r) + renderStanding(r)
    + renderRumors(r) + renderTownEvents(r);
}

/** 页面启动：拉取 /api/stats → 渲染 → 绑定筛选/自动刷新 */
export async function bootstrap(): Promise<void> {
  const daySel = document.getElementById('stats-day') as HTMLSelectElement | null;
  const root = document.getElementById('stats-root');
  const meta = document.getElementById('stats-meta');
  const refreshBtn = document.getElementById('stats-refresh');
  const autoChk = document.getElementById('stats-auto') as HTMLInputElement | null;
  const status = document.getElementById('stats-status');

  async function load(): Promise<void> {
    const day = daySel?.value && daySel.value !== '' ? Number(daySel.value) : undefined;
    const q = day !== undefined ? `?day=${day}` : '';
    try {
      const res = await fetch(`/api/stats${q}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const report = (await res.json()) as TownReport;
      daySel && fillDayOptions(daySel, report);
      root && (root.innerHTML = renderAll(report));
      if (meta) {
        const hh = String(Math.floor((report.overview.gameMinutes % 1440) / 60)).padStart(2, '0');
        const mm = String(report.overview.gameMinutes % 60).padStart(2, '0');
        meta.textContent = `${report.overview.dbPath} · 游戏时间 第${report.overview.days}天 ${hh}:${mm}`;
      }
      if (status) status.textContent = '';
    } catch (err) {
      if (status) status.textContent = `加载失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  daySel?.addEventListener('change', () => void load());
  refreshBtn?.addEventListener('click', () => void load());
  autoChk?.addEventListener('change', () => {
    if (autoChk.checked) void load();
  });
  setInterval(() => {
    if (autoChk?.checked) void load();
  }, 5000);
  await load();
}

function fillDayOptions(sel: HTMLSelectElement, r: TownReport): void {
  const days = Math.max(r.overview.days, ...r.events.perDay.map((d) => d.day));
  const opts = `<option value="">全部天数</option>` + Array.from({ length: Math.max(0, days) }, (_, i) => i + 1)
    .map((d) => `<option value="${d}"${sel.value === String(d) ? ' selected' : ''}>第 ${d} 天</option>`).join('');
  if (sel.innerHTML !== opts) sel.innerHTML = opts;
}

if (typeof document !== 'undefined') void bootstrap();