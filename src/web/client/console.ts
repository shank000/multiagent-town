// 社会研究控制台：有向伙伴选择网络、结构指标主图与实验控制。

import type { AgentView } from './panel';

export interface MetricsPayload {
  repeat: number[];
  recip: number[];
  clus: number[];
  div: number[];
  hhi: number[];
  persistence: number[];
  hub: number[];
  pairs: { pair: string; count: number }[];
}

export type MetricKey = Exclude<keyof MetricsPayload, 'pairs'>;

export const METRIC_DEFINITIONS: ReadonlyArray<{
  key: MetricKey;
  label: string;
  shortLabel: string;
  min: number;
  fixedMax?: number;
  color: string;
}> = [
  { key: 'repeat', label: '同对重复率', shortLabel: '重复', min: 0, fixedMax: 1, color: '#f2c66d' },
  { key: 'recip', label: '互惠性（相对基线）', shortLabel: '互惠', min: 0, color: '#77b8ff' },
  { key: 'clus', label: '聚类系数', shortLabel: '聚类', min: 0, fixedMax: 1, color: '#7dd7a0' },
  { key: 'div', label: '伙伴多样性（7日）', shortLabel: '多样性', min: 0, color: '#f58fa6' },
  { key: 'hhi', label: '伙伴集中度 HHI（7日）', shortLabel: '集中度', min: 0, fixedMax: 1, color: '#c39cff' },
  { key: 'persistence', label: '双 7 日关系矩阵持续性', shortLabel: '持续性', min: -1, fixedMax: 1, color: '#62dacb' },
  { key: 'hub', label: '加权入度枢纽集中度', shortLabel: '枢纽', min: 0, fixedMax: 1, color: '#ff9d70' },
];

export interface NetworkNodeLayout {
  agentId: string;
  x: number;
  y: number;
  radius: number;
}

interface Point { x: number; y: number }
const POS = new Map<string, Point>();
let layoutW = 0;
let layoutH = 0;
let lastLayoutStepAt = 0;

function parsePair(pair: string, count: number, n: number): { from: number; to: number; count: number } | null {
  const [from, to] = pair.split(':').map(Number);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= n || to >= n || from === to || count <= 0) return null;
  return { from, to, count };
}

function preparePositions(agents: AgentView[], w: number, h: number): Point[] {
  if (layoutW > 0 && layoutH > 0 && (layoutW !== w || layoutH !== h)) {
    for (const p of POS.values()) {
      p.x = (p.x / layoutW) * w;
      p.y = (p.y / layoutH) * h;
    }
  }
  layoutW = w;
  layoutH = h;
  const radiusX = Math.max(70, Math.min(180, w * .3));
  const radiusY = Math.max(60, Math.min(140, h * .28));
  return agents.map((agent, index) => {
    let p = POS.get(agent.id);
    if (!p) {
      const angle = (Math.PI * 2 * index) / Math.max(1, agents.length) - Math.PI / 2;
      p = { x: w / 2 + Math.cos(angle) * radiusX, y: h / 2 + Math.sin(angle) * radiusY };
      POS.set(agent.id, p);
    }
    return p;
  });
}

/** 清空布局缓存；世界人口或研究者主动复位时使用。 */
export function resetNetworkLayout(): void {
  POS.clear();
  layoutW = 0;
  layoutH = 0;
  lastLayoutStepAt = 0;
}

/** 网络节点命中测试，坐标统一使用 CSS px。 */
export function hitTestNetwork(nodes: readonly NetworkNodeLayout[], x: number, y: number): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const node of nodes) {
    const distance = Math.hypot(x - node.x, y - node.y);
    if (distance <= node.radius + 5 && (!best || distance < best.distance)) best = { id: node.agentId, distance };
  }
  return best?.id ?? null;
}

/** 有向伙伴选择网络：箭头表示选择方向，线宽表示累计次数。 */
export function drawNetwork(
  ctx: CanvasRenderingContext2D,
  agents: AgentView[],
  pairs: MetricsPayload['pairs'],
  w: number,
  h: number,
  nowMs: number,
  selectedId: string | null = null,
  hoveredId: string | null = null
): NetworkNodeLayout[] {
  ctx.fillStyle = '#09111d';
  ctx.fillRect(0, 0, w, h);
  if (!agents.length) {
    ctx.fillStyle = '#95a7bd';
    ctx.font = '14px "Microsoft YaHei UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('等待伙伴选择数据', w / 2, h / 2);
    ctx.textAlign = 'left';
    return [];
  }

  const n = agents.length;
  const edges = pairs.map((pair) => parsePair(pair.pair, pair.count, n)).filter((edge): edge is NonNullable<typeof edge> => edge !== null);
  const agentIds = new Set(agents.map((agent) => agent.id));
  let removedResident = false;
  for (const id of POS.keys()) {
    if (!agentIds.has(id)) {
      POS.delete(id);
      removedResident = true;
    }
  }
  const topologyChanged = removedResident
    || POS.size !== agents.length
    || agents.some((agent) => !POS.has(agent.id))
    || layoutW !== w
    || layoutH !== h;
  const positions = preparePositions(agents, w, h);
  const directed = new Set(edges.map((edge) => `${edge.from}:${edge.to}`));
  const undirected = new Map<string, number>();
  for (const edge of edges) {
    const key = edge.from < edge.to ? `${edge.from}:${edge.to}` : `${edge.to}:${edge.from}`;
    undirected.set(key, (undirected.get(key) ?? 0) + edge.count);
  }

  // 斥力、加权弹簧与中心引力以约 13 FPS 更新，绘制仍保持屏幕刷新率。
  const updateLayout = topologyChanged || nowMs - lastLayoutStepAt >= 75;
  if (updateLayout) lastLayoutStepAt = nowMs;
  for (let iteration = 0; updateLayout && iteration < 7; iteration++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = positions[j].x - positions[i].x;
        const dy = positions[j].y - positions[i].y;
        const distance = Math.max(36, Math.hypot(dx, dy));
        const force = 14500 / (distance * distance);
        positions[i].x -= (dx / distance) * force;
        positions[i].y -= (dy / distance) * force;
        positions[j].x += (dx / distance) * force;
        positions[j].y += (dy / distance) * force;
      }
    }
    for (const [key, count] of undirected) {
      const [from, to] = key.split(':').map(Number);
      const a = positions[from];
      const b = positions[to];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const desired = Math.max(92, 160 - Math.min(40, count * 3));
      const force = (distance - desired) * .012;
      a.x += (dx / distance) * force;
      a.y += (dy / distance) * force;
      b.x -= (dx / distance) * force;
      b.y -= (dy / distance) * force;
    }
    for (const p of positions) {
      p.x += (w / 2 - p.x) * .014;
      p.y += (h / 2 - p.y) * .014;
      p.x = Math.max(34, Math.min(w - 34, p.x));
      p.y = Math.max(42, Math.min(h - 48, p.y));
    }
  }

  const selectedIndex = agents.findIndex((agent) => agent.id === selectedId);
  const hoveredIndex = agents.findIndex((agent) => agent.id === hoveredId);
  ctx.lineCap = 'round';
  for (const edge of edges) {
    const from = positions[edge.from];
    const to = positions[edge.to];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / distance;
    const uy = dy / distance;
    const hasReverse = directed.has(`${edge.to}:${edge.from}`);
    const side = hasReverse ? (edge.from < edge.to ? 1 : -1) : 0;
    const ox = -uy * side * 5;
    const oy = ux * side * 5;
    const startX = from.x + ux * 27 + ox;
    const startY = from.y + uy * 27 + oy;
    const endX = to.x - ux * 29 + ox;
    const endY = to.y - uy * 29 + oy;
    const ego = selectedIndex < 0 || edge.from === selectedIndex || edge.to === selectedIndex;
    const hover = hoveredIndex < 0 || edge.from === hoveredIndex || edge.to === hoveredIndex;
    ctx.strokeStyle = `rgba(242,198,109,${ego && hover ? Math.min(.92, .34 + edge.count * .055) : .1})`;
    ctx.lineWidth = ego && hover ? Math.min(7, 1.4 + Math.sqrt(edge.count)) : 1;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    const arrow = 7;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - ux * arrow - uy * arrow * .55, endY - uy * arrow + ux * arrow * .55);
    ctx.lineTo(endX - ux * arrow + uy * arrow * .55, endY - uy * arrow - ux * arrow * .55);
    ctx.closePath();
    ctx.fill();
  }

  const nodes: NetworkNodeLayout[] = [];
  for (let i = 0; i < n; i++) {
    const agent = agents[i];
    const p = positions[i];
    const selected = agent.id === selectedId;
    const hovered = agent.id === hoveredId;
    const pulse = agent.state === 'acting' ? Math.sin(nowMs / 300) * 1.5 : 0;
    const radius = (selected ? 26 : hovered ? 25 : 23) + pulse;
    ctx.fillStyle = selected ? '#ffe19a' : hovered ? '#70dfd0' : '#e9bb55';
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = selected ? '#ffffff' : '#513e1b';
    ctx.lineWidth = selected ? 3 : 2;
    ctx.stroke();
    ctx.fillStyle = '#111923';
    ctx.font = '700 13px "Microsoft YaHei UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(agent.name.slice(0, 4), p.x, p.y + 5);
    ctx.fillStyle = '#b8c8da';
    ctx.font = '12px "Microsoft YaHei UI", sans-serif';
    const activity = agent.verb && agent.state === 'acting' ? agent.verb.slice(0, 7) : agent.occupation.slice(0, 7);
    ctx.fillText(activity, p.x, p.y + 40);
    nodes.push({ agentId: agent.id, x: p.x, y: p.y, radius: Math.max(23, radius) });
  }
  ctx.textAlign = 'left';
  return nodes;
}

/** 单指标主图；指标切换由 DOM tabs 驱动，保证在窄视窗中仍可阅读。 */
export function drawMetrics(ctx: CanvasRenderingContext2D, metrics: MetricsPayload, w: number, h: number, key: MetricKey = 'repeat'): void {
  const spec = METRIC_DEFINITIONS.find((item) => item.key === key) ?? METRIC_DEFINITIONS[0];
  const data = metrics[spec.key];
  ctx.fillStyle = '#09111d';
  ctx.fillRect(0, 0, w, h);

  const latest = data.at(-1);
  ctx.fillStyle = spec.color;
  ctx.font = '600 14px "Microsoft YaHei UI", sans-serif';
  ctx.fillText(spec.label, 18, 72);
  ctx.font = '700 24px ui-monospace, monospace';
  ctx.fillText(latest === undefined ? '—' : latest.toFixed(3), 18, 101);

  const left = 54;
  const right = 24;
  const top = 116;
  const bottom = 31;
  const chartW = Math.max(20, w - left - right);
  const chartH = Math.max(20, h - top - bottom);
  const observedMax = data.length ? Math.max(...data) : 0;
  const max = spec.fixedMax ?? Math.max(1, Math.ceil(observedMax * 10) / 10);
  const span = Math.max(Number.EPSILON, max - spec.min);
  const scaleY = (value: number) => top + chartH - ((Math.max(spec.min, Math.min(max, value)) - spec.min) / span) * chartH;

  ctx.fillStyle = 'rgba(255,255,255,.025)';
  ctx.fillRect(left, top, chartW, chartH);
  ctx.strokeStyle = 'rgba(183,201,221,.13)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = top + (chartH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + chartW, y);
    ctx.stroke();
  }
  ctx.fillStyle = '#8799af';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(max.toFixed(max <= 1 ? 1 : 2), left - 8, top + 4);
  ctx.fillText(spec.min.toFixed(1), left - 8, top + chartH + 4);
  ctx.textAlign = 'left';

  if (!data.length) {
    ctx.fillStyle = '#8fa1b7';
    ctx.font = '13px "Microsoft YaHei UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('运行实验后在此显示日序列', left + chartW / 2, top + chartH / 2);
    ctx.textAlign = 'left';
    return;
  }

  ctx.strokeStyle = spec.color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  data.forEach((value, index) => {
    const x = left + (chartW * index) / Math.max(1, data.length - 1);
    const y = scaleY(value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#9cafc4';
  ctx.font = '11px "Microsoft YaHei UI", sans-serif';
  ctx.fillText('第 1 个日点', left, h - 9);
  ctx.textAlign = 'right';
  ctx.fillText(`第 ${data.length} 个日点`, left + chartW, h - 9);
  ctx.textAlign = 'left';
}

/** 拉取当前平行世界的实验指标。 */
export async function fetchMetrics(worldId?: string): Promise<MetricsPayload> {
  const query = worldId ? `?worldId=${encodeURIComponent(worldId)}` : '';
  const res = await fetch(`/api/experiment/metrics${query}`);
  if (!res.ok) throw new Error(`metrics unavailable (${res.status})`);
  const result = (await res.json()) as MetricsPayload & { worldId?: string };
  if (worldId && result.worldId && result.worldId !== worldId) throw new Error('metrics world mismatch');
  return {
    repeat: result.repeat ?? [], recip: result.recip ?? [], clus: result.clus ?? [], div: result.div ?? [],
    hhi: result.hhi ?? [], persistence: result.persistence ?? [], hub: result.hub ?? [], pairs: result.pairs ?? [],
  };
}

/** 实验控制。非 2xx 响应会交给界面反馈层处理。 */
export async function controlExperiment(
  cmd: 'start' | 'stop' | 'config',
  worldId: string,
  body?: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`/api/experiment/${cmd}?worldId=${encodeURIComponent(worldId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : '{}',
  });
  if (!res.ok) throw new Error(`experiment ${cmd} failed (${res.status})`);
  const result = (await res.json()) as { worldId?: string };
  if (result.worldId !== worldId) throw new Error(`experiment ${cmd} world mismatch`);
}

/** 导出当前世界的指标 JSON。 */
export function exportMetrics(metrics: MetricsPayload): void {
  const blob = new Blob([JSON.stringify(metrics, null, 2)], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `emergence-metrics-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

/** 极简全镇概览，供后续嵌入研究摘要使用。 */
export function drawMiniWorld(
  ctx: CanvasRenderingContext2D,
  snap: { gridW: number; gridH: number; objects: { id: string; name: string; type: string; x: number; y: number; w: number; h: number }[]; agents: AgentView[] },
  w: number,
  h: number
): void {
  ctx.fillStyle = '#0b1713';
  ctx.fillRect(0, 0, w, h);
  const tile = Math.max(2, Math.floor(Math.min((w - 40) / snap.gridW, (h - 40) / snap.gridH)));
  const ox = (w - snap.gridW * tile) / 2;
  const oy = (h - snap.gridH * tile) / 2;
  ctx.fillStyle = '#263d28';
  ctx.fillRect(ox, oy, snap.gridW * tile, snap.gridH * tile);
  const palette: Record<string, string> = { building: '#b88762', zone: '#477d45', water: '#4b83b4', furniture: '#8b7256', room: '#c59c71' };
  for (const object of snap.objects) {
    if (object.type === 'town') continue;
    ctx.fillStyle = palette[object.type] ?? '#667080';
    ctx.fillRect(ox + object.x * tile, oy + object.y * tile, object.w * tile, object.h * tile);
  }
  for (const agent of snap.agents) {
    ctx.fillStyle = agent.state === 'acting' ? '#f2c66d' : '#62dacb';
    ctx.beginPath();
    ctx.arc(ox + (agent.x + .5) * tile, oy + (agent.y + .5) * tile, Math.max(3, tile * .45), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#a7b7ca';
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillText(`${snap.gridW}×${snap.gridH} · 实心=行动中`, 10, h - 8);
}
