// 像素小镇浏览器客户端：Canvas 2D 像素渲染，零依赖，SSE 实时刷新

import { drawNpc, type Dir } from './sprites';
import { drawTerrain, drawObjectDetail, applyDayNight, TILE } from './render';

interface AgentView {
  id: string; name: string; occupation: string; state: string;
  x: number; y: number; locationId: string; locationName: string;
  verb: string; thought: string | null; targetName: string | null;
  spriteIndex: number; background: string;
}
interface ObjectView { id: string; name: string; type: string; x: number; y: number; w: number; h: number }
interface ClockState { day: number; minutesOfDay: number; totalMinutes: number }
interface WorldSnapshot {
  clock: ClockState; speedPerRealSecond: number; paused: boolean;
  gridW: number; gridH: number; objects: ObjectView[]; agents: AgentView[]; seq: number;
}
interface TownEvent {
  type: string; actorId: string | null; description: string;
  payload: { kind?: string; line?: string; thought?: string; fromId?: string } | null;
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
let snap: WorldSnapshot | null = null;
let selectedId: string | null = null;

interface Display { x: number; y: number; tx: number; ty: number; lastTileX: number; lastTileY: number; moving: boolean }
const display = new Map<string, Display>();
const bubbles = new Map<string, { text: string; kind: string; until: number }>();
const ticker: string[] = [];

async function main(): Promise<void> {
  snap = (await (await fetch('/api/state')).json()) as WorldSnapshot;
  initCanvas();
  for (const a of snap.agents) initDisplay(a);
  canvas.addEventListener('click', onClick);
  bindControls();
  document.querySelectorAll('#panel-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      activeTab = (tab as HTMLElement).dataset.tab ?? 'detail';
      document.querySelectorAll('#panel-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
      updatePanel();
    });
  });
  const es = new EventSource('/events');
  es.addEventListener('snapshot', (ev) => {
    snap = JSON.parse((ev as MessageEvent<string>).data) as WorldSnapshot;
    applySnapshot();
  });
  es.addEventListener('event', (ev) => onEvent(JSON.parse((ev as MessageEvent<string>).data) as TownEvent));
  updateHud();
  requestAnimationFrame(loop);
}

function initCanvas(): void {
  if (!snap) return;
  canvas.width = snap.gridW * TILE;
  canvas.height = snap.gridH * TILE;
}
function initDisplay(a: AgentView): void {
  display.set(a.id, { x: a.x * TILE, y: a.y * TILE, tx: a.x * TILE, ty: a.y * TILE, lastTileX: a.x, lastTileY: a.y, moving: false });
}
function applySnapshot(): void {
  if (!snap) return;
  for (const a of snap.agents) {
    let d = display.get(a.id);
    if (!d) {
      initDisplay(a);
      d = display.get(a.id)!;
    }
    if (a.x !== d.lastTileX || a.y !== d.lastTileY) {
      d.tx = a.x * TILE;
      d.ty = a.y * TILE;
      d.moving = true;
      d.lastTileX = a.x;
      d.lastTileY = a.y;
    } else {
      d.moving = false;
    }
  }
  updateHud();
}

function onEvent(e: TownEvent): void {
  ticker.unshift(e.description);
  if (ticker.length > 5) ticker.pop();
  updateTicker();
  const kind = e.payload?.kind;
  const fromId = e.payload?.fromId ?? e.actorId;
  if ((kind === 'thought' || kind === 'chat') && fromId) {
    const text = kind === 'chat' ? (e.payload?.line ?? '') : (e.payload?.thought ?? '');
    bubbles.set(fromId, { text, kind, until: performance.now() + 7000 });
  }
}

function updateTicker(): void {
  const box = document.getElementById('ticker')!;
  box.innerHTML = ticker.map((t) => `<p>${escapeHtml(t)}</p>`).join('') || '<p>事件流：等待小镇苏醒……</p>';
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bindControls(): void {
  document.querySelectorAll('#controls button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action')!;
      const value = btn.getAttribute('data-value');
      void fetch('/api/world/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value ? { action, value: Number(value) } : { action }),
      });
    });
  });
}

function onClick(ev: MouseEvent): void {
  if (!snap) return;
  const rect = canvas.getBoundingClientRect();
  const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
  const tx = Math.floor(px / TILE);
  const ty = Math.floor(py / TILE);
  selectedId = snap.agents.find((a) => Math.abs(a.x - tx) <= 0.5 && Math.abs(a.y - ty) <= 0.5)?.id ?? null;
  updatePanel();
}

let activeTab = 'detail';

function updatePanel(): void {
  const body = document.getElementById('panel-body')!;
  const a = snap?.agents.find((x) => x.id === selectedId);
  if (!a) {
    activeTab = 'detail';
    body.innerHTML = '<p id="panel-empty">点击小镇里的角色查看详情</p>';
    return;
  }
  if (activeTab === 'detail') renderDetail(body, a);
  else void renderMind(body, a.id, activeTab);
}

function renderDetail(body: HTMLElement, a: AgentView): void {
  const stateName: Record<string, string> = { idle: '待机', thinking: '思考中', moving: '赶路中', acting: '行动中' };
  body.innerHTML = `
    <h3>${escapeHtml(a.name)}</h3>
    <p><span class="label">职业</span> ${escapeHtml(a.occupation)}</p>
    <p><span class="label">状态</span> ${escapeHtml(stateName[a.state] ?? a.state)}</p>
    <p><span class="label">位置</span> ${escapeHtml(a.locationName)}</p>
    ${a.verb ? `<p><span class="label">正在</span> ${escapeHtml(a.verb)}</p>` : ''}
    ${a.thought ? `<p><span class="label">想法</span> ${escapeHtml(a.thought)}</p>` : ''}
    <p><span class="label">简介</span> ${escapeHtml(a.background)}</p>`;
}

async function renderMind(body: HTMLElement, agentId: string, tab: string): Promise<void> {
  body.innerHTML = '<p class="label">加载中…</p>';
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/mind`);
    const mind = (await res.json()) as {
      memories: { content: string; importance: number; kind: string }[];
      reflections: { insights: string[] }[];
      dialogues: { fromAgent: string; content: string }[];
    };
    if (tab === 'memory') {
      body.innerHTML = mind.memories.length
        ? mind.memories.map((m) => `<div class="mem-item"><span class="stars">${'★'.repeat(Math.round(m.importance / 2))}</span> ${escapeHtml(m.content)}</div>`).join('')
        : '<p class="label">暂无记忆</p>';
    } else if (tab === 'reflection') {
      body.innerHTML = mind.reflections.length
        ? mind.reflections.map((r) => `<div class="ref-item">${r.insights.map((i) => `<div class="ins">💡 ${escapeHtml(i)}</div>`).join('')}</div>`).join('')
        : '<p class="label">暂无反思</p>';
    } else {
      body.innerHTML = mind.dialogues.length
        ? mind.dialogues.map((d) => `<div class="dl-item">${escapeHtml(d.fromAgent)}：${escapeHtml(d.content)}</div>`).join('')
        : '<p class="label">暂无对话</p>';
    }
  } catch {
    body.innerHTML = '<p class="label">加载失败</p>';
  }
}

function updateHud(): void {
  if (!snap) return;
  const c = snap.clock;
  const hh = String(Math.floor(c.minutesOfDay / 60)).padStart(2, '0');
  const mm = String(c.minutesOfDay % 60).padStart(2, '0');
  const paused = snap.paused ? ' ⏸ 已暂停' : '';
  document.getElementById('clock')!.textContent = `第${c.day}天 ${hh}:${mm}${paused}`;
}

function loop(): void {
  const now = performance.now();
  for (const d of display.values()) {
    d.x += (d.tx - d.x) * 0.25;
    d.y += (d.ty - d.y) * 0.25;
    if (Math.abs(d.tx - d.x) < 0.4 && Math.abs(d.ty - d.y) < 0.4) {
      d.x = d.tx;
      d.y = d.ty;
    }
  }
  for (const [id, b] of bubbles) {
    if (now > b.until) bubbles.delete(id);
  }
  draw();
  requestAnimationFrame(loop);
}

function draw(): void {
  if (!snap) return;
  drawTerrain(ctx, canvas.width, canvas.height);
  drawObjects();
  drawAgents();
  drawBubbles();
  applyDayNight(ctx, canvas.width, canvas.height, snap.clock.minutesOfDay);
}

function drawObjects(): void {
  const order: Record<string, number> = { zone: 0, building: 1, room: 2, furniture: 2 };
  const objs = snap!.objects
    .filter((o) => o.type !== 'town')
    .sort((a, b) => (order[a.type] ?? 0) - (order[b.type] ?? 0));
  for (const o of objs) drawObjectDetail(ctx, o, performance.now());
}

function drawAgents(): void {
  const sorted = [...snap!.agents].sort((a, b) => a.y - b.y);
  for (const a of sorted) {
    const d = display.get(a.id)!;
    const dir: Dir = d.tx > d.x ? 'right' : d.tx < d.x ? 'left' : d.ty > d.y ? 'down' : d.ty < d.y ? 'up' : 'down';
    const frame = (d.moving ? Math.floor(performance.now() / 300) % 2 : 0) as 0 | 1;
    drawNpc(ctx, d.x + TILE / 2, d.y + TILE / 2, dir, frame, a.spriteIndex, d.moving, a.id === selectedId, a.name, a.state === 'thinking');
  }
}

function drawBubbles(): void {
  const now = performance.now();
  for (const [id, b] of bubbles) {
    if (now > b.until) {
      bubbles.delete(id);
      continue;
    }
    const d = display.get(id);
    if (!d) continue;
    const lines = wrap(b.text, 14);
    const w = Math.max(...lines.map((l) => l.length)) * 12 + 14;
    const h = lines.length * 14 + 12;
    const bx = d.x + TILE / 2 - w / 2;
    const by = d.y - 40 - h;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillRect(bx, by, w, h);
    ctx.strokeStyle = '#333333';
    ctx.strokeRect(bx, by, w, h);
    ctx.fillStyle = '#222222';
    ctx.font = '12px monospace';
    lines.forEach((l, i) => {
      ctx.fillText((b.kind === 'chat' ? '💬' : '💭') + l, bx + 7, by + 16 + i * 14);
    });
  }
}

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out.length ? out : [''];
}

void main();
