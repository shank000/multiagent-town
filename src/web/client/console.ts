// 涌现控制台：社会网络力导向图 + 指标曲线 + 实验干预（Plague Inc 式数据仪表面板）

import type { AgentView } from './panel';

export interface MetricsPayload {
  repeat: number[];
  recip: number[];
  clus: number[];
  div: number[];
  pairs: { pair: string; count: number }[];
}

const POS = new Map<string, { x: number; y: number }>();

/** 网络视图：力导向布局（斥力 + 弹簧边 + 中心引力），节点=居民、边宽=互动频次 */
export function drawNetwork(
  ctx: CanvasRenderingContext2D,
  agents: AgentView[],
  pairs: MetricsPayload['pairs'],
  w: number,
  h: number,
  nowMs: number
): void {
  ctx.fillStyle = '#1a2018';
  ctx.fillRect(0, 0, w, h);
  if (!agents.length) return;
  const n = agents.length;
  const pos = agents.map((a) => {
    const p = POS.get(a.id);
    if (!p) {
      const ang = (Math.PI * 2 * POS.size) / Math.max(1, agents.length) - Math.PI / 2;
      const np = { x: w / 2 + Math.cos(ang) * 150, y: h / 2 + Math.sin(ang) * 110 };
      POS.set(a.id, np);
      return np;
    }
    return p;
  });
  const edgeW = new Map<string, number>();
  for (const p of pairs) edgeW.set(p.pair, p.count);
  // 力模拟（少量迭代，保证实时）
  for (let iter = 0; iter < 6; iter++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const d = Math.max(20, Math.hypot(dx, dy));
        const rep = 9000 / (d * d);
        pos[i].x -= (dx / d) * rep;
        pos[i].y -= (dy / d) * rep;
        pos[j].x += (dx / d) * rep;
        pos[j].y += (dy / d) * rep;
      }
      pos[i].x += (w / 2 - pos[i].x) * 0.01;
      pos[i].y += (h / 2 - pos[i].y) * 0.01;
    }
  }
  // 边
  ctx.lineCap = 'round';
  const seen = new Set<string>();
  for (const [key, count] of edgeW) {
    const [a, b] = key.split(':').map(Number);
    const pa = pos[a];
    const pb = pos[b];
    if (!pa || !pb) continue;
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(k)) continue;
    seen.add(k);
    ctx.strokeStyle = `rgba(227,178,60,${Math.min(1, 0.22 + count * 0.06)})`;
    ctx.lineWidth = Math.min(8, 1 + count * 0.8);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  // 节点
  for (let i = 0; i < n; i++) {
    const a = agents[i];
    const p = pos[i];
    const pulse = a.state === 'acting' ? Math.sin(nowMs / 300) * 2 : 0;
    ctx.fillStyle = '#e3b23c';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 16 + pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.font = `${Math.round(9 + pulse / 4)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(a.name.slice(0, 4), p.x, p.y + 3);
    ctx.fillStyle = '#f5e9c8';
    ctx.font = '10px monospace';
    ctx.fillText(a.verb && a.state === 'acting' ? `（${a.verb.slice(0, 6)}）` : '', p.x, p.y + 30);
  }
  ctx.textAlign = 'left';
}

const SERIES: [string, string][] = [
  ['repeat', '同对重复率'],
  ['recip', '互惠性(相对基线)'],
  ['clus', '聚类系数'],
  ['div', '伙伴多样性'],
];
const COLORS = ['#e3b23c', '#6ba3d9', '#7fbf7f', '#e8708a'];

/** 指标视图：四条逐日曲线 */
export function drawMetrics(ctx: CanvasRenderingContext2D, m: MetricsPayload, w: number, h: number): void {
  ctx.fillStyle = '#1a2018';
  ctx.fillRect(0, 0, w, h);
  const series = SERIES.map(([k], i) => ({ key: k, data: m[k as keyof MetricsPayload] as number[], color: COLORS[i] }));
  const maxLen = Math.max(...series.map((s) => s.data.length), 2);
  const pad = { l: 36, r: 12, t: 14, b: 22 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  // 网格
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = pad.t + (ih * g) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
  }
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.data.forEach((v, i) => {
      const x = pad.l + (iw * i) / Math.max(1, maxLen - 1);
      const y = pad.t + ih - (Math.max(0, Math.min(1, v)) * ih);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  // 图例
  ctx.font = '11px monospace';
  series.forEach((s, i) => {
    ctx.fillStyle = s.color;
    ctx.fillRect(pad.l + i * 130, 4, 10, 4);
    ctx.fillText(SERIES[i][1], pad.l + i * 130 + 14, 9);
  });
  ctx.fillStyle = '#c9d3e8';
  ctx.font = '10px monospace';
  ctx.fillText(`共 ${maxLen} 天`, w - pad.r - 60, h - 8);
}

/** 拉取实验指标 */
export async function fetchMetrics(): Promise<MetricsPayload> {
  const res = await fetch('/api/experiment/metrics');
  const r = (await res.json()) as { repeat: number[]; recip: number[]; clus: number[]; div: number[]; pairs: MetricsPayload['pairs'] };
  return { repeat: r.repeat, recip: r.recip, clus: r.clus, div: r.div, pairs: r.pairs };
}

/** 实验控制 */
export async function controlExperiment(cmd: 'start' | 'stop' | 'config', body?: Record<string, unknown>): Promise<void> {
  await fetch(`/api/experiment/${cmd}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : '{}',
  });
}

/** 导出指标 JSON */
export function exportMetrics(m: MetricsPayload): void {
  const blob = new Blob([JSON.stringify(m, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `emergence-metrics-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 小地图：极简像素块示意（建筑色块 + 区域 + agent 彩点 + 活动指示） */
export function drawMiniWorld(
  ctx: CanvasRenderingContext2D,
  snap: { gridW: number; gridH: number; objects: { id: string; name: string; type: string; x: number; y: number; w: number; h: number }[]; agents: AgentView[] },
  w: number,
  h: number
): void {
  ctx.fillStyle = '#101a12';
  ctx.fillRect(0, 0, w, h);
  const ts = Math.max(2, Math.floor(Math.min((w - 40) / snap.gridW, (h - 40) / snap.gridH)));
  const ox = (w - snap.gridW * ts) / 2;
  const oy = (h - snap.gridH * ts) / 2;
  ctx.fillStyle = '#22331f';
  ctx.fillRect(ox, oy, snap.gridW * ts, snap.gridH * ts);
  const palette: Record<string, string> = {
    building: '#b08968', zone: '#3f7d3a', water: '#3a6ea8', furniture: '#8a6f4d', room: '#c9a06a',
  };
  for (const o of snap.objects) {
    if (o.type === 'town') continue;
    ctx.fillStyle = palette[o.type] ?? '#666';
    ctx.fillRect(ox + o.x * ts, oy + o.y * ts, o.w * ts, o.h * ts);
  }
  for (const a of snap.agents) {
    const cx = ox + (a.x + 0.5) * ts;
    const cy = oy + (a.y + 0.5) * ts;
    ctx.fillStyle = a.state === 'acting' ? '#e3b23c' : '#4fd1c5';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2.5, ts * 0.45), 0, Math.PI * 2);
    ctx.fill();
    if (a.state === 'acting') {
      ctx.strokeStyle = '#e3b23c';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(4.5, ts * 0.8), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.fillStyle = '#9aa8bd';
  ctx.font = '10px monospace';
  ctx.fillText(`${snap.gridW}×${snap.gridH} · 实心=行动中`, 8, h - 6);
}
