// 像素小镇浏览器客户端：Canvas 2D 像素渲染，零依赖，SSE 实时刷新

import { drawNpc, type Dir } from './sprites';
import { drawTerrain, drawObjectDetail, drawInterior, applyDayNight, TILE } from './render';
import { computeFit, zoomScale, zoomOffsets, type FitCamera } from './camera';

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
let selectedObjectId: string | null = null;

const STATE_NAME: Record<string, string> = { idle: '待机', thinking: '思考中', moving: '赶路中', acting: '行动中' };
const TYPE_NAME: Record<string, string> = { town: '小镇', building: '建筑', room: '房间', furniture: '家具', zone: '区域' };

// 玩家扮演：快照不含该信息，客户端本地记录正在被扮演的 NPC
const playing = new Set<string>();
let playTargetId: string | null = null;

// 悬停 tooltip 与广播横幅（canvas 绘制层）
let tooltip: { text: string; x: number; y: number } | null = null;
let banner: { text: string; until: number } | null = null;

interface Display { x: number; y: number; tx: number; ty: number; lastTileX: number; lastTileY: number; moving: boolean }
interface Bubble { kind: 'chat' | 'thought' | 'chat_summary'; speaker: string; text: string; until: number }
const display = new Map<string, Display>();
const bubbles = new Map<string, Bubble>();
const ticker: string[] = [];

// —— 全屏相机（fit-to-screen，无拖拽）——
const camera: FitCamera = { scale: 1, offX: 0, offY: 0 };
let fitScale = 1;

async function main(): Promise<void> {
  snap = (await (await fetch('/api/state')).json()) as WorldSnapshot;
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  for (const a of snap.agents) initDisplay(a);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseleave', () => { tooltip = null; });
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', () => fitCamera());
  canvas.addEventListener('click', onClick);
  bindControls();
  bindPlayBar();
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

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  fitCamera();
}

function fitCamera(): void {
  if (!snap) return;
  const dpr = window.devicePixelRatio || 1;
  const f = computeFit(canvas.width / dpr, canvas.height / dpr, snap.gridW, snap.gridH, TILE);
  fitScale = f.scale;
  camera.scale = fitScale;
  camera.offX = f.offX * dpr;
  camera.offY = f.offY * dpr;
}

function applyCamera(): void {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(camera.scale * dpr, 0, 0, camera.scale * dpr, camera.offX, camera.offY);
}

function resetCamera(): void { ctx.setTransform(1, 0, 0, 1, 0, 0); }
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
  fitCamera();
}

function onEvent(e: TownEvent): void {
  ticker.unshift(e.description);
  if (ticker.length > 5) ticker.pop();
  updateTicker();
  const kind = e.payload?.kind;
  // 广播事件 → 顶部横幅（6 秒后淡出）
  if (kind === 'broadcast') {
    banner = { text: e.description, until: performance.now() + 6000 };
    return;
  }
  const fromId = e.payload?.fromId ?? e.actorId;
  if (fromId && (kind === 'thought' || kind === 'chat' || kind === 'chat_summary')) {
    const speaker = snap?.agents.find((x) => x.id === fromId)?.name ?? fromId;
    const text = kind === 'thought' ? (e.payload?.thought ?? '') : (e.payload?.line ?? '');
    // 对话条（chat/chat_summary）显示 9 秒，thought 气泡维持 7 秒
    const until = performance.now() + (kind === 'thought' ? 7000 : 9000);
    bubbles.set(fromId, { kind, speaker, text, until });
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
  document.querySelectorAll('#controls button[data-action]').forEach((btn) => {
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
  document.getElementById('fit-view')!.addEventListener('click', () => fitCamera());
}

function onWheel(e: WheelEvent): void {
  if (!snap) return;
  e.preventDefault();
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const ax = (e.clientX - rect.left) * dpr;
  const ay = (e.clientY - rect.top) * dpr;
  const factor = e.deltaY < 0 ? 1.25 : 0.8;
  const next = zoomScale(camera.scale, factor, fitScale * dpr);
  const off = zoomOffsets(ax, ay, camera.scale, next, camera.offX, camera.offY, TILE);
  camera.scale = next;
  camera.offX = off.offX;
  camera.offY = off.offY;
}

function onClick(ev: MouseEvent): void {
  if (!snap) return;
  const { tx, ty } = tileAt(ev);
  const agent = snap.agents.find((a) => Math.abs(a.x - tx) <= 0.5 && Math.abs(a.y - ty) <= 0.5);
  if (agent) {
    selectedId = agent.id;
    selectedObjectId = null;
    updatePanel();
    return;
  }
  // 未命中 NPC → 命中对象则显示建筑信息卡
  const obj = findObjectAtTile(tx, ty);
  selectedId = null;
  selectedObjectId = obj?.id ?? null;
  updatePanel();
}

function onMouseMove(ev: MouseEvent): void {
  if (!snap) return;
  const { px, py, tx, ty } = tileAt(ev);
  const a = snap.agents.find((x) => Math.abs(x.x - tx) <= 0.5 && Math.abs(x.y - ty) <= 0.5);
  if (a) {
    tooltip = { text: `${a.name}（${STATE_NAME[a.state] ?? a.state}）`, x: px, y: py };
    return;
  }
  const o = findObjectAtTile(tx, ty);
  if (o) {
    tooltip = { text: `${o.name}（${TYPE_NAME[o.type] ?? o.type}）`, x: px, y: py };
    return;
  }
  tooltip = null;
}

function tileAt(ev: MouseEvent): { px: number; py: number; tx: number; ty: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const px = (ev.clientX - rect.left) * dpr;
  const py = (ev.clientY - rect.top) * dpr;
  return {
    px, py,
    tx: Math.floor((px - camera.offX) / (TILE * camera.scale)),
    ty: Math.floor((py - camera.offY) / (TILE * camera.scale)),
  };
}

// 客户端版 objectAt：返回包含该瓦片且面积最小的对象（与服务器 world.objectAt 一致）
function findObjectAtTile(tx: number, ty: number): ObjectView | null {
  if (!snap) return null;
  let best: ObjectView | null = null;
  for (const o of snap.objects) {
    if (o.type === 'town') continue;
    const contains = tx >= o.x && tx < o.x + o.w && ty >= o.y && ty < o.y + o.h;
    if (contains && (!best || o.w * o.h < best.w * best.h)) best = o;
  }
  return best;
}

let activeTab = 'detail';

function updatePanel(): void {
  const body = document.getElementById('panel-body')!;
  if (selectedObjectId) {
    const o = snap?.objects.find((x) => x.id === selectedObjectId);
    if (o) {
      renderObjectCard(body, o);
      return;
    }
    selectedObjectId = null;
  }
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
  const isPlaying = playing.has(a.id);
  body.innerHTML = `
    <h3>${escapeHtml(a.name)}</h3>
    <p><span class="label">职业</span> ${escapeHtml(a.occupation)}</p>
    <p><span class="label">状态</span> ${escapeHtml(STATE_NAME[a.state] ?? a.state)}</p>
    <p><span class="label">位置</span> ${escapeHtml(a.locationName)}</p>
    ${a.verb ? `<p><span class="label">正在</span> ${escapeHtml(a.verb)}</p>` : ''}
    ${a.thought ? `<p><span class="label">想法</span> ${escapeHtml(a.thought)}</p>` : ''}
    <p><span class="label">简介</span> ${escapeHtml(a.background)}</p>
    <button id="play-toggle">${isPlaying ? '退出扮演' : '🎮 扮演'}</button>`;
  document.getElementById('play-toggle')!.addEventListener('click', () => togglePlay(a.id));
}

function renderObjectCard(body: HTMLElement, o: ObjectView): void {
  body.innerHTML = `
    <h3>${escapeHtml(o.name)}</h3>
    <p><span class="label">类型</span> ${escapeHtml(TYPE_NAME[o.type] ?? o.type)}</p>
    <p><span class="label">尺寸</span> ${o.w}×${o.h}</p>`;
}

// —— 玩家扮演 ——
function togglePlay(id: string): void {
  if (playing.has(id)) stopPlay(id);
  else startPlay(id);
}

function startPlay(id: string): void {
  // 若此前在扮演其他 NPC，先清除服务端覆盖
  if (playTargetId && playTargetId !== id) {
    void fetch(`/api/player/${encodeURIComponent(playTargetId)}/act`, { method: 'DELETE' });
    playing.delete(playTargetId);
  }
  playing.add(id);
  playTargetId = id;
  const input = document.getElementById('play-input') as HTMLInputElement;
  input.value = '';
  document.getElementById('play-bar')!.hidden = false;
  input.focus();
  updatePanel();
}

function stopPlay(id: string): void {
  playing.delete(id);
  if (playTargetId === id) playTargetId = null;
  document.getElementById('play-bar')!.hidden = true;
  void fetch(`/api/player/${encodeURIComponent(id)}/act`, { method: 'DELETE' });
  updatePanel();
}

async function sendPlay(): Promise<void> {
  if (!playTargetId) return;
  const input = document.getElementById('play-input') as HTMLInputElement;
  const instruction = input.value.trim();
  if (!instruction) return;
  await fetch(`/api/player/${encodeURIComponent(playTargetId)}/act`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction }),
  });
  input.value = '';
}

function bindPlayBar(): void {
  document.getElementById('play-send')!.addEventListener('click', () => void sendPlay());
  document.getElementById('play-exit')!.addEventListener('click', () => {
    if (playTargetId) stopPlay(playTargetId);
  });
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
    } else if (tab === 'relation') {
      const res2 = await fetch(`/api/relationships/${encodeURIComponent(agentId)}`);
      const rel = (await res2.json()) as {
        relations: { otherName: string; affection: number; respect: number }[];
        standings: { name: string; score: number }[];
      };
      const bars = rel.relations.length
        ? rel.relations.map((r) => {
            const pct = (v: number) => Math.round(((v + 1) / 2) * 100);
            return `<div class="mem-item">${escapeHtml(r.otherName)}
              <div class="bar"><div class="bar-fill love" style="width:${pct(r.affection)}%"></div><span>💗${r.affection.toFixed(2)}</span></div>
              <div class="bar"><div class="bar-fill resp" style="width:${pct(r.respect)}%"></div><span>💙${r.respect.toFixed(2)}</span></div>
            </div>`;
          }).join('')
        : '<p class="label">暂无关系</p>';
      const top = rel.standings.slice(0, 3).map((s, i) => `<div class="dl-item">👑${i + 1} ${escapeHtml(s.name)}（${s.score.toFixed(3)}）</div>`).join('');
      body.innerHTML = `<p class="label">小镇声望榜</p>${top}<p class="label">对他人的看法</p>${bars}`;
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
  if (banner && now > banner.until) banner = null;
  draw();
  requestAnimationFrame(loop);
}

function draw(): void {
  if (!snap) return;
  const worldW = snap.gridW * TILE;
  const worldH = snap.gridH * TILE;
  // 世界层：应用摄像机变换后绘制（地形/对象/agent/气泡）
  applyCamera();
  drawTerrain(ctx, worldW, worldH);
  drawObjects();
  drawAgents();
  drawBubbles();
  applyDayNight(ctx, worldW, worldH, snap.clock.minutesOfDay);
  // HUD 层：重置变换，按屏幕坐标绘制（tooltip/banner）
  resetCamera();
  drawTooltip();
  drawBanner();
}

// —— 屋顶剖切：含 NPC 的建筑改画内饰 ——

/** 返回包含该瓦片的建筑（若有） */
function buildingAt(tx: number, ty: number): ObjectView | null {
  if (!snap) return null;
  return snap.objects.find((o) => o.type === 'building' &&
    tx >= o.x && tx < o.x + o.w && ty >= o.y && ty < o.y + o.h) ?? null;
}

/** 建筑的子对象（room/furniture）：几何上完整落在建筑矩形内（等价于 parentId 归属） */
function childrenOf(building: ObjectView): ObjectView[] {
  if (!snap) return [];
  return snap.objects.filter((o) =>
    (o.type === 'room' || o.type === 'furniture') &&
    o.x >= building.x && o.y >= building.y &&
    o.x + o.w <= building.x + building.w && o.y + o.h <= building.y + building.h);
}

/** 对象是否落在某建筑内部（建筑子对象）：屋顶未剖切时应被遮挡、不单独绘制 */
function isBuildingChild(o: ObjectView): boolean {
  if (!snap) return false;
  return snap.objects.some((b) => b.type === 'building' &&
    o.x >= b.x && o.y >= b.y && o.x + o.w <= b.x + b.w && o.y + o.h <= b.y + b.h);
}

function drawObjects(): void {
  const now = performance.now();
  // 每帧计算含 NPC 的建筑集合
  const inside = new Set<string>();
  for (const a of snap!.agents) {
    const b = buildingAt(a.x, a.y);
    if (b) inside.add(b.id);
  }
  const order: Record<string, number> = { zone: 0, building: 1, room: 2, furniture: 2 };
  // 建筑子对象不单独绘制：未剖切时被屋顶遮挡，剖切时由 drawInterior 统一绘制
  const objs = snap!.objects
    .filter((o) => o.type !== 'town')
    .filter((o) => !(o.type === 'room' || o.type === 'furniture') || !isBuildingChild(o))
    .sort((a, b) => (order[a.type] ?? 0) - (order[b.type] ?? 0));
  for (const o of objs) {
    if (o.type === 'building' && inside.has(o.id)) {
      drawInterior(ctx, o, childrenOf(o), now);
    } else {
      drawObjectDetail(ctx, o, now);
    }
  }
}

function drawAgents(): void {
  const sorted = [...snap!.agents].sort((a, b) => a.y - b.y);
  for (const a of sorted) {
    const d = display.get(a.id)!;
    const dir: Dir = d.tx > d.x ? 'right' : d.tx < d.x ? 'left' : d.ty > d.y ? 'down' : d.ty < d.y ? 'up' : 'down';
    const frame = (d.moving ? Math.floor(performance.now() / 300) % 2 : 0) as 0 | 1;
    drawNpc(ctx, d.x + TILE / 2, d.y + TILE / 2, dir, frame, a.spriteIndex, d.moving, a.id === selectedId, a.name, a.state === 'thinking');
    // 正在被玩家扮演的 NPC：名字旁补 🎮 徽标
    if (playing.has(a.id)) {
      ctx.font = '10px monospace';
      ctx.fillText('🎮', d.x + TILE / 2 + ctx.measureText(a.name).width / 2 + 2, d.y + TILE / 2 + 19);
    }
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
    const isDialogue = b.kind === 'chat' || b.kind === 'chat_summary';
    const prefix = b.kind === 'chat_summary' ? '📜' : b.kind === 'chat' ? '💬' : '💭';
    const textLines = wrap(b.text, 14);
    // 对话条：说话人姓名行 + 文本行、宽 180；thought 维持单行
    const rows = isDialogue ? [`${prefix} ${b.speaker}`, ...textLines] : textLines.map((l) => `${prefix}${l}`);
    const w = isDialogue ? 180 : Math.max(...textLines.map((l) => l.length)) * 12 + 14;
    const h = rows.length * 14 + 12;
    const bx = d.x + TILE / 2 - w / 2;
    const by = d.y - 40 - h;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillRect(bx, by, w, h);
    ctx.strokeStyle = '#333333';
    ctx.strokeRect(bx, by, w, h);
    ctx.fillStyle = '#222222';
    rows.forEach((l, i) => {
      ctx.font = i === 0 && isDialogue ? 'bold 12px monospace' : '12px monospace';
      ctx.fillText(l, bx + 7, by + 16 + i * 14);
    });
  }
}

function drawTooltip(): void {
  if (!tooltip) return;
  ctx.font = '12px monospace';
  const w = ctx.measureText(tooltip.text).width + 16;
  const h = 24;
  let x = tooltip.x + 14;
  let y = tooltip.y + 14;
  if (x + w > canvas.width) x = tooltip.x - 14 - w;
  if (y + h > canvas.height) y = tooltip.y - 14 - h;
  ctx.fillStyle = 'rgba(20,26,34,0.92)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#3a4657';
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#e8e2d4';
  ctx.fillText(tooltip.text, x + 8, y + 16);
}

function drawBanner(): void {
  if (!banner) return;
  ctx.font = 'bold 14px monospace';
  const w = ctx.measureText(banner.text).width + 36;
  const h = 28;
  const x = (canvas.width - w) / 2;
  const y = 8;
  ctx.fillStyle = 'rgba(227,178,60,0.95)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#1a1a1a';
  ctx.fillText(banner.text, x + 18, y + 19);
}

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out.length ? out : [''];
}

void main();
