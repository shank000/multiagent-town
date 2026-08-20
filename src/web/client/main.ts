// 像素小镇浏览器客户端：Canvas 2D 像素渲染，零依赖，SSE 实时刷新

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

const TILE = 32;
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
let snap: WorldSnapshot | null = null;
let selectedId: string | null = null;

interface Display { x: number; y: number; tx: number; ty: number; lastTileX: number; lastTileY: number; moving: boolean }
const display = new Map<string, Display>();
const bubbles = new Map<string, { text: string; kind: string; until: number }>();
const ticker: string[] = [];

const PALETTES = [
  { hair: '#5b3a29', skin: '#f2c99c', top: '#d97757', bottom: '#6b4f6b', accent: '#f7e8d0' }, // 林晚晴·围裙
  { hair: '#2f2f2f', skin: '#e8c39a', top: '#4a6fa5', bottom: '#3a3a3a', accent: '#9fb8d8' }, // 陈默·眼镜
  { hair: '#7a4a2b', skin: '#f5d0a8', top: '#8a2f2f', bottom: '#5a4a3a', accent: '#c9a66b' }, // 沈屿·贝雷帽
  { hair: '#1f1f1f', skin: '#f2c99c', top: '#b33b3b', bottom: '#4a4a4a', accent: '#2f6b2f' }, // 周岚·邮差帽
];
const ROOFS = ['#b35d45', '#8a5a3a', '#5a7a8a', '#6b4f6b', '#8a7a3a', '#4a6a4a'];

async function main(): Promise<void> {
  snap = (await (await fetch('/api/state')).json()) as WorldSnapshot;
  initCanvas();
  for (const a of snap.agents) initDisplay(a);
  canvas.addEventListener('click', onClick);
  bindControls();
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

function updatePanel(): void {
  const panel = document.getElementById('panel')!;
  const a = snap?.agents.find((x) => x.id === selectedId);
  if (!a) {
    panel.innerHTML = '<p id="panel-empty">点击小镇里的角色查看详情</p>';
    return;
  }
  const stateName: Record<string, string> = { idle: '待机', thinking: '思考中', moving: '赶路中', acting: '行动中' };
  panel.innerHTML = `
    <h3>${escapeHtml(a.name)}</h3>
    <p><span class="label">职业</span> ${escapeHtml(a.occupation)}</p>
    <p><span class="label">状态</span> ${stateName[a.state] ?? a.state}</p>
    <p><span class="label">位置</span> ${escapeHtml(a.locationName)}</p>
    ${a.verb ? `<p><span class="label">正在</span> ${escapeHtml(a.verb)}</p>` : ''}
    ${a.thought ? `<p><span class="label">想法</span> ${escapeHtml(a.thought)}</p>` : ''}
    <p><span class="label">简介</span> ${escapeHtml(a.background)}</p>`;
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
  ctx.fillStyle = '#7fb069';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawObjects();
  drawAgents();
  drawBubbles();
}

function drawObjects(): void {
  const order: Record<string, number> = { zone: 0, building: 1, room: 2, furniture: 2 };
  const objs = snap!.objects
    .filter((o) => o.type !== 'town')
    .sort((a, b) => (order[a.type] ?? 0) - (order[b.type] ?? 0));
  for (const o of objs) {
    const px = o.x * TILE, py = o.y * TILE, pw = o.w * TILE, ph = o.h * TILE;
    if (o.type === 'zone') {
      if (o.id === 'obj:park') drawPark(px, py, pw, ph);
      else drawPlaza(px, py, pw, ph);
    } else if (o.type === 'building') {
      drawBuilding(o, px, py, pw, ph);
    } else if (o.type === 'room') {
      ctx.fillStyle = '#d9b48f';
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = '#a97c50';
      ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
    } else {
      ctx.fillStyle = '#8a6f4d';
      ctx.fillRect(px + 4, py + 4, pw - 8, ph - 8);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.font = '11px monospace';
    ctx.fillText(o.name, px + 3, py + 13);
  }
}

function drawPark(px: number, py: number, pw: number, ph: number): void {
  ctx.fillStyle = '#6aa84f';
  ctx.fillRect(px, py, pw, ph);
  for (const [tx, ty] of [[px + 8, py + 8], [px + pw - 14, py + ph - 14]]) {
    ctx.fillStyle = '#4a3520';
    ctx.fillRect(tx, ty, 6, 14);
    ctx.fillStyle = '#2f7a3a';
    ctx.fillRect(tx - 6, ty - 8, 18, 12);
  }
}

function drawPlaza(px: number, py: number, pw: number, ph: number): void {
  ctx.fillStyle = '#c9b79c';
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeStyle = '#a3937a';
  for (let x = px + 8; x < px + pw; x += 16) {
    for (let y = py + 8; y < py + ph; y += 16) {
      ctx.strokeRect(x, y, 16, 16);
    }
  }
  ctx.fillStyle = '#6b9bd1';
  ctx.fillRect(px + pw / 2 - 8, py + ph / 2 - 8, 16, 16);
}

function drawBuilding(o: ObjectView, px: number, py: number, pw: number, ph: number): void {
  ctx.fillStyle = '#e8d5b7';
  ctx.fillRect(px, py, pw, ph);
  const roof = ROOFS[hash(o.id) % ROOFS.length];
  ctx.fillStyle = roof;
  ctx.fillRect(px, py, pw, 8);
  ctx.fillStyle = '#7a5a3a';
  ctx.fillRect(px + pw / 2 - 5, py + ph - 12, 10, 12);
  if (o.id === 'obj:post_office') {
    ctx.fillStyle = '#e3b23c';
    ctx.fillRect(px + pw - 14, py + 4, 10, 10);
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function drawAgents(): void {
  const sorted = [...snap!.agents].sort((a, b) => a.y - b.y);
  for (const a of sorted) {
    const d = display.get(a.id)!;
    const frame = d.moving ? Math.floor(performance.now() / 300) % 2 : 0;
    drawSprite(d.x + TILE / 2, d.y + TILE / 2, a.spriteIndex, frame, d.moving, a.state === 'thinking', a.id === selectedId, a.name);
  }
}

function drawSprite(cx: number, cy: number, index: number, frame: number, moving: boolean, thinking: boolean, selected: boolean, name: string): void {
  const p = PALETTES[index % PALETTES.length];
  const x = Math.round(cx);
  const y = Math.round(cy) + (moving ? Math.round(Math.sin(performance.now() / 120)) : 0);
  // 影子
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(x, cy + 6, 5, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  // 腿
  ctx.fillStyle = p.bottom;
  if (frame === 0) {
    ctx.fillRect(x - 4, y - 4, 3, 5);
    ctx.fillRect(x + 1, y - 4, 3, 5);
  } else {
    ctx.fillRect(x - 5, y - 4, 3, 4);
    ctx.fillRect(x + 2, y - 4, 3, 5);
  }
  // 身体
  ctx.fillStyle = p.top;
  ctx.fillRect(x - 4, y - 9, 8, 6);
  if (index === 0) {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 2, y - 9, 4, 6);
  }
  if (index === 3) {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 4, y - 9, 8, 2);
  }
  // 头
  ctx.fillStyle = p.skin;
  ctx.fillRect(x - 3, y - 16, 6, 6);
  // 头发
  ctx.fillStyle = p.hair;
  ctx.fillRect(x - 3, y - 18, 6, 3);
  if (index === 2) {
    ctx.fillStyle = p.top;
    ctx.fillRect(x - 4, y - 19, 8, 2);
  }
  if (index === 3) {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 4, y - 18, 8, 2);
  }
  // 眼镜（陈默）
  if (index === 1) {
    ctx.fillStyle = '#111111';
    ctx.fillRect(x - 3, y - 14, 2, 2);
    ctx.fillRect(x + 1, y - 14, 2, 2);
  }
  if (thinking) {
    ctx.fillStyle = '#ffe9a8';
    ctx.font = 'bold 14px monospace';
    ctx.fillText('…', x - 7, y - 22);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = '10px monospace';
  ctx.fillText(name, x - ctx.measureText(name).width / 2, y + 13);
  if (selected) {
    ctx.strokeStyle = '#ffd700';
    ctx.strokeRect(x - 6, y - 21, 12, 29);
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
