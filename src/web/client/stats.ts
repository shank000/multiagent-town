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
    rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function emptyHint(msg: string): string {
  return `<p class="stats-empty">${esc(msg)}</p>`;
}

export function renderOverview(r: TownReport): string {
  const c = r.overview.counts;
  const perDayAvg = r.overview.days > 0 ? Math.round(c.events / r.overview.days) : 0;
  const currentDay = Math.floor(r.overview.gameMinutes / 1440) + 1;
  const agents = r.overview.agents.map((a) => a.name).join('、');
  const activeDays = r.events.perDay.length;
  return section('概览', cards([
    [String(r.overview.days), '已完成天数'],
    [String(currentDay), '当前游戏日'],
    [String(c.events), '事件总数'],
    [String(perDayAvg), '已完成日均事件'],
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
    [String(e.total), e.filtered ? '所选日事件数' : '事件总数'],
    [String(e.perHour.length * 2), '覆盖时段(小时)'],
    [String(e.topActors.length ? e.topActors[0].name : '-'), '最活跃居民'],
  ]) + `<p class="stats-note">${e.filtered ? '当前仅展示所选日期的事件范围。' : '当前展示全部日期的事件范围。'}</p>`
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
  const scopedMessages = d.filteredMessages ?? d.messages;
  const maxDay = d.perDay.length ? Math.max(...d.perDay.map((x) => x.count)) : 0;
  const maxPair = d.topPairs.length ? Math.max(...d.topPairs.map((p) => p.count)) : 0;
  return section('对话', cards([
    [String(scopedMessages), d.filteredMessages === null ? '对话消息' : '所选日对话消息'],
    [String(d.conversations), '当前范围会话数'],
    [fmt(d.avgTurnsPerConversation), '当前范围平均轮数'],
    [fmt(d.avgCharsPerMessage, 1), '报告平均每句字数'],
  ])
    + section('报告内每日消息量', d.perDay.map((x) => barRow(`第${x.day}天`, x.count, maxDay)).join(''))
    + section('报告内对话最多的配对', d.topPairs.length
      ? d.topPairs.map((p) => barRow(`${p.from} ↔ ${p.to}`, p.count, maxPair, String(p.count))).join('')
      : emptyHint('当前范围内没有对话配对。')));
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

interface WorldListItem {
  id: string;
  name: string;
  kind?: string;
}

interface WorldsResponse {
  active?: string;
  worlds?: WorldListItem[];
}

type WorldTownReport = TownReport & { worldId?: string };

/** 页面启动：加载平行世界名册，再按独立 worldId 拉取只读统计。 */
export async function bootstrap(): Promise<void> {
  const worldSel = document.getElementById('stats-world') as HTMLSelectElement | null;
  const daySel = document.getElementById('stats-day') as HTMLSelectElement | null;
  const root = document.getElementById('stats-root');
  const meta = document.getElementById('stats-meta');
  const refreshBtn = document.getElementById('stats-refresh') as HTMLButtonElement | null;
  const autoChk = document.getElementById('stats-auto') as HTMLInputElement | null;
  const status = document.getElementById('stats-status');
  if (!worldSel || !daySel || !root) return;
  const worldSelect = worldSel;
  const daySelect = daySel;
  const rootNode = root;

  let requestSequence = 0;
  let activeController: AbortController | null = null;

  function setStatus(message: string, state: 'loading' | 'ready' | 'error'): void {
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
  }

  async function loadWorlds(): Promise<void> {
    const response = await fetch('/api/worlds');
    if (!response.ok) throw new Error(`世界名册 HTTP ${response.status}`);
    const payload = (await response.json()) as WorldsResponse;
    const worlds = Array.isArray(payload.worlds)
      ? payload.worlds.filter((world): world is WorldListItem => (
        typeof world?.id === 'string' && world.id.length > 0 && typeof world.name === 'string'
      ))
      : [];
    if (!worlds.length) throw new Error('世界名册为空');

    const previous = worldSelect.value;
    worldSelect.replaceChildren(...worlds.map((world) => {
      const option = document.createElement('option');
      option.value = world.id;
      option.textContent = world.kind ? `${world.name} · ${world.kind}` : world.name;
      return option;
    }));
    const preferred = worlds.some((world) => world.id === previous)
      ? previous
      : worlds.some((world) => world.id === payload.active) ? payload.active! : worlds[0].id;
    worldSelect.value = preferred;
  }

  async function load(): Promise<void> {
    const worldId = worldSelect.value;
    if (!worldId) {
      setStatus('请选择一个平行世界。', 'error');
      rootNode.setAttribute('aria-busy', 'false');
      return;
    }
    const day = daySelect.value ? Number(daySelect.value) : undefined;
    const sequence = ++requestSequence;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const query = new URLSearchParams({ worldId });
    if (day !== undefined) query.set('day', String(day));

    rootNode.setAttribute('aria-busy', 'true');
    if (refreshBtn) refreshBtn.disabled = true;
    setStatus('正在读取统计……', 'loading');
    try {
      const response = await fetch(`/api/stats?${query.toString()}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`统计接口 HTTP ${response.status}`);
      const report = (await response.json()) as WorldTownReport;
      if (sequence !== requestSequence || worldSelect.value !== worldId) return;
      if (report.worldId !== worldId) throw new Error(`响应世界不匹配：期望 ${worldId}`);

      fillDayOptions(daySelect, report);
      rootNode.innerHTML = renderAll(report);
      if (meta) {
        const hh = String(Math.floor((report.overview.gameMinutes % 1440) / 60)).padStart(2, '0');
        const mm = String(report.overview.gameMinutes % 60).padStart(2, '0');
        const currentDay = Math.floor(report.overview.gameMinutes / 1440) + 1;
        const worldName = worldSelect.selectedOptions[0]?.textContent ?? worldId;
        const path = report.overview.dbPath ? ` · ${report.overview.dbPath}` : '';
        meta.textContent = `${worldName} · 已完成 ${report.overview.days} 天 · 当前第 ${currentDay} 天 ${hh}:${mm}${path}`;
      }
      setStatus('统计已更新。', 'ready');
    } catch (error) {
      if (sequence !== requestSequence || (error instanceof DOMException && error.name === 'AbortError')) return;
      setStatus(`加载失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      if (sequence === requestSequence) {
        rootNode.setAttribute('aria-busy', 'false');
        if (refreshBtn) refreshBtn.disabled = false;
      }
    }
  }

  worldSelect.addEventListener('change', () => {
    daySelect.value = '';
    void load();
  });
  daySelect.addEventListener('change', () => void load());
  refreshBtn?.addEventListener('click', () => void load());
  autoChk?.addEventListener('change', () => {
    if (autoChk.checked) void load();
  });
  const timer = window.setInterval(() => {
    if (autoChk?.checked) void load();
  }, 5000);
  window.addEventListener('pagehide', () => {
    window.clearInterval(timer);
    activeController?.abort();
  }, { once: true });

  try {
    await loadWorlds();
    await load();
  } catch (error) {
    rootNode.setAttribute('aria-busy', 'false');
    setStatus(`加载失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function fillDayOptions(sel: HTMLSelectElement, r: TownReport): void {
  const selected = sel.value;
  const currentDay = Math.floor(r.overview.gameMinutes / 1440) + 1;
  const days = Math.max(currentDay, r.overview.days, ...r.events.perDay.map((day) => day.day));
  const options: HTMLOptionElement[] = [];
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全部天数';
  options.push(all);
  for (let day = 1; day <= days; day++) {
    const option = document.createElement('option');
    option.value = String(day);
    option.textContent = `第 ${day} 天`;
    options.push(option);
  }
  sel.replaceChildren(...options);
  if (options.some((option) => option.value === selected)) sel.value = selected;
}

if (typeof document !== 'undefined') void bootstrap();
