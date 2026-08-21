// 像素小镇浏览器客户端：Canvas 2D 像素渲染，零依赖，SSE 实时刷新

import { drawNpc, type Dir } from './sprites';
import { drawTerrain, drawObjectDetail, drawInterior, applyDayNight, TILE } from './render';
import { computeFit, zoomScale, zoomOffsets, type FitCamera } from './camera';
import { ParticleSystem, sitDust, steamPuff, sparkleBurst, zzzPuff, paperFlutter, smokePuff, fireflySpawn, rainDrop, rainSplash, type Particle } from './effects';
import { escapeHtml, STATE_NAME, TYPE_NAME, renderDetail, renderProfile, renderObjectCard, renderMind, bindPanel, updatePanelDeps, type AgentView } from './panel';
import { drawTooltip, drawBanner, drawBubbles, actionIconFor, dprScale, type Bubble, type DisplayPos } from './hud';
import type { ObjectView } from './types';

interface ClockState { day: number; minutesOfDay: number; totalMinutes: number }
interface WorldSnapshot {
  clock: ClockState; speedPerRealSecond: number; paused: boolean;
  gridW: number; gridH: number; objects: ObjectView[]; agents: AgentView[]; seq: number;
  weather: 'clear' | 'rain';
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

// 玩家扮演：快照不含该信息，客户端本地记录正在被扮演的 NPC
const playing = new Set<string>();
let playTargetId: string | null = null;

// 悬停 tooltip 与广播横幅（canvas 绘制层）
let tooltip: { text: string; x: number; y: number } | null = null;
let banner: { text: string; until: number } | null = null;

interface Display { x: number; y: number; tx: number; ty: number; lastTileX: number; lastTileY: number; moving: boolean }
const display = new Map<string, Display>();
const bubbles = new Map<string, Bubble>();
const ticker: string[] = [];
const fx = new ParticleSystem();
const poses = new Map<string, { scaleY: number }>(); // agentId -> 姿态缩放（1 站 / 0.78 坐 / 0.5 躺）
const lastActionKey = new Map<string, string>();     // agentId -> "targetName:verb"
const zzzLast = new Map<string, number>();
const steamLast = new Map<string, number>();
let lastFx = performance.now();

const FIREFLY_ZONE_IDS = ['obj:lake', 'obj:park', 'obj:forest_ne'];
let lastSmoke = 0;
let lastFirefly = 0;
const RAIN_CAP = 200;
let lastRainSpawn = 0;
let lastWaterRipple = 0;

// —— 全屏相机（fit-to-screen，无拖拽）——
const camera: FitCamera = { scale: 1, offX: 0, offY: 0 };
let fitScale = 1;
// 记录上次快照的网格尺寸：仅当网格变化时重算 fit，避免高频快照复位滚轮缩放
let lastGridW = 0;
let lastGridH = 0;

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
  updatePanelDeps({ playing, togglePlay });
  bindPanel((tab) => { activeTab = tab; }, updatePanel);
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
  camera.offX = f.offX;
  camera.offY = f.offY;
}

function applyCamera(): void {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(camera.scale * dpr, 0, 0, camera.scale * dpr, camera.offX * dpr, camera.offY * dpr);
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
  if (snap.gridW !== lastGridW || snap.gridH !== lastGridH) {
    lastGridW = snap.gridW;
    lastGridH = snap.gridH;
    fitCamera();
  }
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
  const side = document.getElementById('side')!;
  document.getElementById('panel-toggle')!.addEventListener('click', (e) => {
    side.classList.toggle('collapsed');
    (e.target as HTMLButtonElement).textContent = side.classList.contains('collapsed') ? '▶' : '◀';
  });
  const ticker = document.getElementById('ticker')!;
  document.getElementById('ticker-toggle')!.addEventListener('click', () => {
    ticker.classList.toggle('hidden');
  });
}

function onWheel(e: WheelEvent): void {
  if (!snap) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const ax = e.clientX - rect.left;
  const ay = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.25 : 0.8;
  const next = zoomScale(camera.scale, factor, fitScale);
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
  const { tx, ty } = tileAt(ev);
  const rect = canvas.getBoundingClientRect();
  const cx = ev.clientX - rect.left; // 屏幕层 tooltip 坐标用 CSS px，drawTooltip 内乘 dpr
  const cy = ev.clientY - rect.top;
  const a = snap.agents.find((x) => Math.abs(x.x - tx) <= 0.5 && Math.abs(x.y - ty) <= 0.5);
  if (a) {
    tooltip = { text: `${a.name}（${STATE_NAME[a.state] ?? a.state}）`, x: cx, y: cy };
    return;
  }
  const o = findObjectAtTile(tx, ty);
  if (o) {
    tooltip = { text: `${o.name}（${TYPE_NAME[o.type] ?? o.type}）`, x: cx, y: cy };
    return;
  }
  tooltip = null;
}

function tileAt(ev: MouseEvent): { tx: number; ty: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const px = (ev.clientX - rect.left) * dpr;
  const py = (ev.clientY - rect.top) * dpr;
  return {
    tx: Math.floor((px - camera.offX * dpr) / (TILE * camera.scale * dpr)),
    ty: Math.floor((py - camera.offY * dpr) / (TILE * camera.scale * dpr)),
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
  else if (activeTab === 'profile') renderProfile(body, a);
  else void renderMind(body, a.id, activeTab);
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

function updateHud(): void {
  if (!snap) return;
  const c = snap.clock;
  const hh = String(Math.floor(c.minutesOfDay / 60)).padStart(2, '0');
  const mm = String(c.minutesOfDay % 60).padStart(2, '0');
  const paused = snap.paused ? ' ⏸ 已暂停' : '';
  document.getElementById('clock')!.textContent = `第${c.day}天 ${hh}:${mm}${paused}`;
}

/** 环境粒子：白天炊烟（咖啡馆/面包店/住宅烟囱）、夜间萤火虫（湖/公园/树林，≤40 只） */
function spawnAmbient(now: number): void {
  if (!snap) return;
  const s = snap;
  const m = s.clock.minutesOfDay;
  const night = m >= 1200 || m < 300;
  if (!night && now - lastSmoke > 900) {
    lastSmoke = now;
    const chimneyIds = ['obj:cafe', 'obj:bakery', 'obj:home_lin', 'obj:home_chen', 'obj:home_shen', 'obj:home_zhou'];
    for (const id of chimneyIds) {
      const o = s.objects.find((x) => x.id === id);
      if (o) fx.spawn(smokePuff((o.x + o.w - 1) * TILE, o.y * TILE - 6));
    }
  }
  if (night && now - lastFirefly > 350) {
    lastFirefly = now;
    const count = fx.particles.filter((p) => p.kind === 'firefly').length;
    if (count < 40) {
      const zones = FIREFLY_ZONE_IDS
        .map((id) => s.objects.find((x) => x.id === id))
        .filter((z): z is ObjectView => !!z);
      if (zones.length) {
        const z = zones[Math.floor(Math.random() * zones.length)];
        const fx0 = (z.x + Math.random() * z.w) * TILE;
        const fy0 = (z.y + Math.random() * z.h) * TILE;
        fx.spawn(fireflySpawn(fx0, fy0));
      }
    }
  }
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
  const dt = now - lastFx;
  lastFx = now;
  for (const a of snap!.agents) {
    const p = poses.get(a.id) ?? { scaleY: 1 };
    poses.set(a.id, p);
    const target = a.state === 'acting' && a.targetName
      ? (a.targetName === '床' ? 0.5 : /沙发|咖啡桌|椅/.test(a.targetName) ? 0.78 : 1)
      : 1;
    p.scaleY += (target - p.scaleY) * 0.3; // 0.3s 级缓动
    if (Math.abs(target - p.scaleY) < 0.02) p.scaleY = target;
    const d = display.get(a.id);
    if (!d) continue;
    const key = `${a.targetName}:${a.verb}`;
    if (a.state === 'acting' && a.targetName && lastActionKey.get(a.id) !== key) {
      lastActionKey.set(a.id, key);
      const cx = d.x + TILE / 2;
      if (a.targetName === '床') { fx.spawn(zzzPuff(cx, d.y - 12)); zzzLast.set(a.id, now); }
      else if (/沙发|咖啡桌|椅/.test(a.targetName)) fx.spawn(sitDust(cx, d.y + TILE));
      if (/煮|咖啡|泡/.test(a.verb)) fx.spawn(steamPuff(cx, d.y - 6));
      if (/煮|泡/.test(a.verb)) steamLast.set(a.id, now);
      if (/写生|画|速写/.test(a.verb)) fx.spawn(sparkleBurst(cx, d.y - 8, '#ffd700'));
      if (/信|分拣|送/.test(a.verb)) fx.spawn(paperFlutter(cx, d.y - 12));
    }
    if (a.state === 'acting' && a.targetName === '床' && now - (zzzLast.get(a.id) ?? 0) > 900) {
      zzzLast.set(a.id, now);
      fx.spawn(zzzPuff(d.x + TILE / 2, d.y - 12));
    }
    if (a.state === 'acting' && /煮|泡/.test(a.verb) && now - (steamLast.get(a.id) ?? 0) > 1200) {
      steamLast.set(a.id, now);
      fx.spawn(steamPuff(d.x + TILE / 2, d.y - 8));
    }
  }
  fx.update(dt);
  if (snap!.weather === 'rain' && now - lastRainSpawn > 40) {
    lastRainSpawn = now;
    const n = fx.particles.filter((p) => p.kind === 'rain').length;
    if (n < RAIN_CAP) {
      const s = dprScale();
      for (let i = 0; i < Math.min(8, RAIN_CAP - n); i++) {
        // 屏幕层坐标即 CSS px（drawRainScreen 内乘 dpr 转设备像素），与 tooltip/banner 一致
        fx.spawn(rainDrop(Math.random() * canvas.width / s, Math.random() * (canvas.height / s) * 0.9));
      }
    }
  }
  // 雨花接线：雨滴落地（接近屏幕底）生成水花并移除该雨滴（坐标 CSS px）
  {
    const s = dprScale();
    const rainBottomCss = canvas.height / s - 20;
    const hitRain: Particle[] = [];
    fx.particles = fx.particles.filter((p) => {
      if (p.kind === 'rain' && p.y > rainBottomCss) {
        hitRain.push(p);
        return false;
      }
      return true;
    });
    for (const p of hitRain) fx.spawn(rainSplash(p.x, canvas.height / s - 14));
  }
  // 雨天水面涟漪：每 ~500ms 在 lake/river 水面区域随机生成 rainSplash
  if (snap!.weather === 'rain' && now - lastWaterRipple > 500) {
    lastWaterRipple = now;
    const waterObjs = snap!.objects.filter((o) => o.id === 'obj:lake' || o.id === 'obj:river');
    for (const o of waterObjs) {
      const wx = (o.x + Math.random() * o.w) * TILE;
      const wy = (o.y + Math.random() * o.h) * TILE;
      fx.spawn(rainSplash(wx * camera.scale + camera.offX, wy * camera.scale + camera.offY));
    }
  }
  spawnAmbient(now);
  for (const [id, b] of bubbles) {
    if (now > b.until) bubbles.delete(id);
  }
  if (banner && now > banner.until) banner = null;
  draw();
  requestAnimationFrame(loop);
}

function draw(): void {
  if (!snap) return;
  const nowMs = performance.now();
  const worldW = snap.gridW * TILE;
  const worldH = snap.gridH * TILE;
  // 世界层：应用摄像机变换后绘制（地形/对象/agent/气泡）
  applyCamera();
  drawTerrain(ctx, worldW, worldH);
  drawObjects();
  drawAgents();
  drawWorldFx(ctx, nowMs);
  drawBubbles(ctx, bubbles, display as Map<string, DisplayPos>, nowMs);
  applyDayNight(ctx, worldW, worldH, snap.clock.minutesOfDay);
  if (snap.weather === 'rain') {
    ctx.fillStyle = 'rgba(70,90,130,0.12)';
    ctx.fillRect(0, 0, worldW, worldH);
  }
  // HUD 层：重置变换，按屏幕坐标绘制（tooltip/banner + 雨丝）
  resetCamera();
  if (snap.weather === 'rain') drawRainScreen(ctx);
  drawTooltip(ctx, tooltip, canvas.width, canvas.height);
  drawBanner(ctx, banner, nowMs, canvas.width);
}

/** 世界层粒子绘制：跳过 rain/splash（屏幕层单独画） */
function drawWorldFx(ctx: CanvasRenderingContext2D, nowMs: number): void {
  const saved = fx.particles;
  fx.particles = saved.filter((p) => p.kind !== 'rain' && p.kind !== 'splash');
  fx.draw(ctx, nowMs);
  fx.particles = saved;
}

/** 雨丝/水花：屏幕层绘制（resetCamera 后坐标即 CSS px，乘 dpr 转设备像素，与相机无关） */
function drawRainScreen(ctx: CanvasRenderingContext2D): void {
  const s = dprScale();
  for (const p of fx.particles) {
    if (p.kind !== 'rain' && p.kind !== 'splash') continue;
    if (p.kind === 'rain') {
      ctx.lineWidth = 1; // 复位：drawInterior 残留 lineWidth=4 会让雨丝变粗
      ctx.strokeStyle = p.color;
      ctx.beginPath();
      // 分段雨丝：2 段（8px 总长，CSS px）
      ctx.moveTo(p.x * s, p.y * s);
      ctx.lineTo((p.x + 2) * s, (p.y + 5) * s);
      ctx.moveTo((p.x + 3) * s, (p.y + 7) * s);
      ctx.lineTo((p.x + 5) * s, (p.y + 12) * s);
      ctx.stroke();
    } else {
      ctx.fillStyle = p.color;
      ctx.fillRect((p.x - p.size / 2) * s, p.y * s, p.size * s, s);
    }
  }
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
      drawObjectDetail(ctx, o, now, snap!.clock.minutesOfDay);
    }
  }
}

function drawAgents(): void {
  const now = performance.now();
  const sorted = [...snap!.agents].sort((a, b) => a.y - b.y);
  for (const a of sorted) {
    const d = display.get(a.id)!;
    const dir: Dir = d.tx > d.x ? 'right' : d.tx < d.x ? 'left' : d.ty > d.y ? 'down' : d.ty < d.y ? 'up' : 'down';
    const frame = (d.moving ? Math.floor(now / 250) % 2 : 0) as 0 | 1;
    const p = poses.get(a.id) ?? { scaleY: 1 };
    const cx = d.x + TILE / 2;
    const cy = d.y + TILE / 2;
    ctx.save();
    if (p.scaleY < 0.999) {
      ctx.translate(cx, cy + 8);
      ctx.scale(1, p.scaleY);
      ctx.translate(-cx, -cy - 8);
    }
    drawNpc(ctx, cx, cy, dir, frame, a.spriteIndex, d.moving, a.id === selectedId, a.name, a.state === 'thinking');
    ctx.restore();
    // 动作图标：acting 且映射到图标时，头顶 y-44 处弹跳（世界层，不随坐/躺压缩）
    if (a.state === 'acting') {
      const icon = actionIconFor(a.verb, a.targetName);
      if (icon) {
        const bounce = Math.sin(now / 250) * 2;
        ctx.font = '14px monospace';
        ctx.fillText(icon, cx - 7, cy - 44 + bounce);
      }
    }
    // 躺床盖被
    if (p.scaleY < 0.6 && a.targetName === '床') {
      ctx.fillStyle = '#e8e0f0';
      ctx.fillRect(cx - 8, cy - 2, 16, 6);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - 6, cy - 8, 7, 5);
    }
    // 正在被玩家扮演的 NPC：名字旁补 🎮 徽标
    if (playing.has(a.id)) {
      ctx.font = '10px monospace';
      ctx.fillText('🎮', cx + ctx.measureText(a.name).width / 2 + 2, cy + 19);
    }
  }
}

void main();
