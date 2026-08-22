// 像素小镇浏览器客户端：Canvas 2D 像素渲染，零依赖，SSE 实时刷新

import { drawNpc, type Dir } from './sprites';
import { drawTerrain, drawObjectDetail, drawInterior, applyDayNight, TILE } from './render';
import { computeFit, zoomScale, zoomOffsets, type FitCamera } from './camera';
import { ParticleSystem, sitDust, steamPuff, sparkleBurst, zzzPuff, paperFlutter, smokePuff, fireflySpawn, rainDrop, rainSplash, type Particle } from './effects';
import { escapeHtml, STATE_NAME, TYPE_NAME, renderDetail, renderProfile, renderObjectCard, renderMind, bindPanel, updatePanelDeps, type AgentView } from './panel';
import { drawNetwork, drawMetrics, drawMiniWorld, fetchMetrics, controlExperiment, exportMetrics, type MetricsPayload } from './console';
import { drawTooltip, drawBanner, drawBubbles, actionIconFor, dprScale, type Bubble, type DisplayPos } from './hud';
import type { ObjectView } from './types';

interface ClockState { day: number; minutesOfDay: number; totalMinutes: number }
interface WorldSnapshot {
  clock: ClockState; speedPerRealSecond: number; paused: boolean;
  gridW: number; gridH: number; objects: ObjectView[]; agents: AgentView[]; seq: number;
  weather: 'clear' | 'rain';
}
interface TownEvent { id: string;
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

interface Display { x: number; y: number; tx: number; ty: number; lastTileX: number; lastTileY: number; moving: boolean; dir: Dir }
/** 3 帧步态循环：站立-迈步-迈步-迈步（经典四拍） */
const WALK_CYCLE = [0, 1, 2, 1] as const;
const WALK_SPEED = TILE * 5.5; // 像素/秒（匀速行走）
const display = new Map<string, Display>();
const bubbles = new Map<string, Bubble>();
const ticker: string[] = [];
const fx = new ParticleSystem();
const poses = new Map<string, { scaleY: number }>(); // agentId -> 姿态缩放（1 站 / 0.78 坐 / 0.5 躺）
const lastActionKey = new Map<string, string>();     // agentId -> "targetName:verb"
const zzzLast = new Map<string, number>();
const steamLast = new Map<string, number>();
let lastFx = performance.now();
let lastFrame = performance.now();

const FIREFLY_ZONE_IDS = ['obj:lake', 'obj:park', 'obj:forest_ne'];
let lastSmoke = 0;
let lastFirefly = 0;
const RAIN_CAP = 200;
let lastRainSpawn = 0;
let lastWaterRipple = 0;

// —— 全屏相机（fit-to-screen，无拖拽）——
const camera: FitCamera = { scale: 1, offX: 0, offY: 0 };
let viewMode: 'narrative' | 'map' | 'net' | 'metrics' = 'narrative';
let activeWorldId = 'w1';
let metricsCache: MetricsPayload = { repeat: [], recip: [], clus: [], div: [], pairs: [] };
let lastMetricsAt = 0;
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
  display.set(a.id, { x: a.x * TILE, y: a.y * TILE, tx: a.x * TILE, ty: a.y * TILE, lastTileX: a.x, lastTileY: a.y, moving: false, dir: 'down' });
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

function onEvent(e: TownEvent & { worldId?: string }): void {
  if (e.worldId && e.worldId !== activeWorldId) return;
  feed.unshift({ kind: e.payload?.kind ?? '', text: e.description, id: e.id });
  if (feed.length > 200) feed.pop();
  renderFeed();
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

interface FeedItem { kind: string; text: string; id: string }
const feed: FeedItem[] = [];
interface NarrativeItem {
  id: string; seq: number; time: number; day: number; minute: number; type: string; kind: string;
  actor: string | null; actorName: string; target: string | null; targetName: string | null;
  text: string; line: string | null; thought: string | null;
  mode: string | null; chosen: string | null;
  candidates: { id: string; name: string; affection: number; lastInteraction: number }[] | null;
}
let lastNarrativeId = 0;
let lastNarrativeAt = 0;

/** 叙事流：SillyTavern 式时间轴卡片 + 对话气泡 + 内心独白 */
function renderNarrative(items: NarrativeItem[]): void {
  const box = document.getElementById('narrative');
  if (!box) return;
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const frag = document.createDocumentFragment();
  let lastDay = -1;
  for (const it of items) {
    if (it.day !== lastDay) {
      lastDay = it.day;
      const sep = document.createElement('div');
      sep.className = 'nar-day';
      sep.textContent = `── 第 ${it.day} 天 ──`;
      frag.appendChild(sep);
    }
    const card = document.createElement('div');
    const meta = `<span class="nar-meta">${hhmm(it.minute)}</span>`;
    if (it.kind.startsWith('chat')) {
      card.className = 'nar-bubble';
      card.innerHTML = `<div class="nar-head"><span class="nar-ava">${escapeHtml(it.actorName.slice(0, 1))}</span><span class="nar-name">${escapeHtml(it.actorName)}</span>${meta}</div><div class="nar-text">${escapeHtml(it.line ?? it.text)}</div>`;
    } else if (it.kind === 'thought' || ((it.kind.startsWith('thought')) && it.thought)) {
      card.className = 'nar-card thought';
      card.innerHTML = `${meta}<span class="nar-title">💭 ${escapeHtml(it.actorName)} 的内心独白</span><div class="nar-italic">${escapeHtml(it.thought ?? it.text)}</div>`;
    } else if (it.kind === 'experiment_pair_choice') {
      card.className = 'nar-card scene';
      const cands = (it.candidates ?? []).map((c) => {
        const id = c.name;
        const rel = c.affection !== 0 ? `💗${c.affection >= 0 ? '+' : ''}${c.affection}` : '';
        const hist = c.lastInteraction > 0 ? ` · 上次互动${Math.round(c.lastInteraction / 1440)}天` : '';
        const chosenCls = c.name === (it.candidates ?? []).find((x) => x.id === it.chosen)?.name ? ' chosen' : '';
        return `<span class="cand${chosenCls}"><b>${escapeHtml(id)}</b> ${rel}${hist}</span>`;
      }).join(' ');
      const reason = it.mode === 'on'
        ? `她让回忆牵引着脚步——走向了 ${escapeHtml(it.targetName ?? '')}。`
        : `这一次没有特别的回忆，她随意地走向了 ${escapeHtml(it.targetName ?? '')}。`;
      card.innerHTML = `${meta}<div class="nar-prose"><span class="nar-title">🌆 黄昏 · 选择时刻</span><br>${escapeHtml(it.actorName)} 的目光在几位同样熟识的伙伴之间停留——</div>
        <div class="cands">${cands}</div><div class="nar-reason">${reason}</div>`;
    } else if (it.kind === 'gift') {
      card.className = 'nar-card gift';
      card.innerHTML = `${meta}<span class="nar-title">💐 馈礼</span><span class="nar-text">${escapeHtml(it.text)} <em class="nar-tag">💗 +0.10 关系升温</em></span>`;
    } else {
      const icon = it.kind.startsWith('town_event') ? '🎪' : it.kind === 'rumor' ? '🗣' : it.type === 'move' ? '🚶' : it.kind === 'experiment_pair_choice' ? '🤝' : '🛠';
      card.className = 'nar-card';
      card.innerHTML = `${meta}<span class="nar-title">${icon} ${escapeHtml(it.text)}</span>`;
    }
    frag.appendChild(card);
  }
  box.innerHTML = '';
  box.appendChild(frag);
  box.scrollTop = box.scrollHeight;
}

async function pollNarrative(): Promise<void> {
  const now = performance.now();
  if (now - lastNarrativeAt < 2000) return;
  lastNarrativeAt = now;
  try {
    const res = await fetch('/api/narrative?limit=300');
    const r = (await res.json()) as { items: NarrativeItem[] };
    const fresh = r.items.filter((x) => (x.id ?? '') !== '' && x.seq >= 0).slice(-120);
    if (fresh.length) renderNarrative(fresh);
    void lastNarrativeId;
  } catch { /* 静默 */ }
}
const FEED_KINDS: [string, string][] = [
  ['chat', '💬 对话'], ['chat_summary', '📜 小结'], ['gift', '💐 馈礼'], ['rumor', '🗣 谣言'],
  ['town_event', '🎪 活动'], ['broadcast', '📢 广播'], ['interact', '🛠 互动'], ['move', '🚶 移动'],
];
let activeFilter = '全部';
function renderCharacterCard(id: string | null): void {
  const box = document.getElementById('character-card');
  if (!box || !snap) return;
  const a = snap.agents.find((x) => x.id === id);
  if (!a) { box.innerHTML = '点击左侧名册或对话头像查看角色'; return; }
  box.innerHTML = `<div class="char-head"><span class="char-ava">${escapeHtml(a.name.slice(0, 1))}</span>
    <div><div class="char-name">${escapeHtml(a.name)}</div><div class="char-sub">${escapeHtml(a.occupation)}</div></div></div>
    <div class="char-row"><span>状态</span>${escapeHtml(STATE_NAME[a.state] ?? a.state)}${a.verb ? ` · ${escapeHtml(a.verb)}` : ''}</div>
    <div class="char-row"><span>想法</span>${a.thought ? escapeHtml(a.thought) : '（暂无）'}</div>
    <div class="char-divider"></div>
    <div class="char-row"><span>坐标</span>(${a.x}, ${a.y}) · ${escapeHtml(a.locationName)}</div>`;
}

function renderFeed(): void {
  const list = document.getElementById('feed-list');
  if (!list) return;
  const chipsBox = document.getElementById('feed-filters');
  if (chipsBox && !chipsBox.dataset.built) {
    chipsBox.dataset.built = '1';
    const chips = ['全部', ...FEED_KINDS.map(([k]) => k)];
    for (const c of chips) {
      const chip = document.createElement('button');
      chip.className = `filter-chip${c === activeFilter ? ' on' : ''}`;
      chip.textContent = c === '全部' ? '全部' : FEED_KINDS.find(([k]) => k === c)![1];
      chip.addEventListener('click', () => {
        activeFilter = c;
        chipsBox.querySelectorAll('.filter-chip').forEach((x) => x.classList.toggle('on', (x as HTMLElement).textContent === chip.textContent));
        renderFeed();
      });
      chipsBox.appendChild(chip);
    }
  }
  const rows = (activeFilter === '全部' ? feed : feed.filter((f) => f.kind === activeFilter)).slice(0, 60);
  list.innerHTML = rows.map((f) => {
    const tag = FEED_KINDS.find(([k]) => k === f.kind)?.[1] ?? '·';
    return `<div class="feed-item"><span class="t">${tag}</span> ${escapeHtml(f.text)}</div>`;
  }).join('') || '<p style="color:var(--ink-dim)">等待事件……</p>';
}

/** 左栏居民名册：点击选中查看详情 */
function renderRoster(): void {
  const box = document.getElementById('roster');
  if (!box || !snap) return;
  box.innerHTML = snap.agents.map((a) => {
    const hot = a.id === selectedId ? ' hot' : '';
    return `<div class="roster-item${hot}" data-id="${escapeHtml(a.id)}"><span>${escapeHtml(a.name)}</span><span class="v">${escapeHtml(STATE_NAME[a.state] ?? a.state)}</span></div>`;
  }).join('');
  box.querySelectorAll('.roster-item').forEach((el) => {
    el.addEventListener('click', () => {
      selectedId = (el as HTMLElement).dataset.id ?? null;
      selectedObjectId = null;
      renderRoster();
      updatePanel();
      renderCharacterCard(selectedId);
    });
  });
}

/** 实验运行状态轮询 */
function pollExperiment(): void {
  void fetch('/api/experiment/state').then((r) => r.json()).then((st) => {
    const el = document.getElementById('run-status');
    if (!el) return;
    const live = !!st.running;
    el.classList.toggle('live', live);
    el.innerHTML = `<div class="dot"></div>实验：${live ? `<b>运行中（余 ${st.remainingDays} 天）</b>` : '<b>未运行</b>'}<br><span style="font-size:11px">记忆${st.mem === 'on' ? '开' : '关'} · 馈礼${st.gift === 'on' ? '开' : '关'}</span>`;
  }).catch(() => { /* 服务未就绪时静默 */ });
}
setInterval(pollExperiment, 2000);

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
  const setView = (v: 'narrative' | 'map' | 'net' | 'metrics') => {
    viewMode = v;
    const nar = document.getElementById('narrative')!;
    const g = document.getElementById('game')!;
    const net = document.getElementById('net-canvas')!;
    const met = document.getElementById('metrics-canvas')!;
    nar.style.display = v === 'narrative' ? 'block' : 'none';
    g.style.display = v === 'map' ? 'block' : 'none';
    net.style.display = v === 'net' ? 'block' : 'none';
    met.style.display = v === 'metrics' ? 'block' : 'none';
    for (const [id, mode] of [['view-narrative', 'narrative'], ['view-map', 'map'], ['view-net', 'net'], ['view-metrics', 'metrics']] as const) {
      document.getElementById(id)!.classList.toggle('active', mode === v);
    }
  };
  document.getElementById('view-narrative')!.addEventListener('click', () => setView('narrative'));
  document.getElementById('view-map')!.addEventListener('click', () => setView('map'));
  document.getElementById('view-net')!.addEventListener('click', () => setView('net'));
  document.getElementById('view-metrics')!.addEventListener('click', () => setView('metrics'));
  document.getElementById('exp-start')!.addEventListener('click', () => {
    const mem = (document.getElementById('exp-mem') as HTMLInputElement).checked ? 'on' : 'off';
    const gift = (document.getElementById('exp-gift') as HTMLInputElement).checked ? 'on' : 'off';
    const days = Number((document.getElementById('exp-days') as HTMLInputElement).value || 30);
    void controlExperiment('config', { mem, gift }).then(() => controlExperiment('start', { days }));
  });
  document.getElementById('exp-stop')!.addEventListener('click', () => void controlExperiment('stop'));
  document.getElementById('exp-export')!.addEventListener('click', () => exportMetrics(metricsCache));
  renderFeed();
  pollExperiment();
  setInterval(() => void pollNarrative(), 2000);
  // 平行世界：列出世界并切换（服务端切换活跃世界，事件带 worldId 过滤）
  void fetch('/api/worlds').then((r) => r.json()).then((w) => {
    const sel = document.getElementById('world-select') as HTMLSelectElement;
    const desc = document.getElementById('world-desc')!;
    sel.innerHTML = w.worlds.map((x: { id: string; name: string }) => `<option value="${x.id}">${x.name}</option>`).join('');
    activeWorldId = w.active ?? 'w1';
    sel.value = activeWorldId;
    const cur = w.worlds.find((x: { id: string }) => x.id === activeWorldId);
    if (cur) desc.textContent = cur.desc;
    sel.addEventListener('change', () => {
      activeWorldId = sel.value;
      void fetch('/api/world/switch', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: activeWorldId }),
      }).then(() => {
        const c = w.worlds.find((x: { id: string }) => x.id === activeWorldId);
        if (c) desc.textContent = c.desc;
        lastNarrativeAt = 0;
      });
    });
  }).catch(() => { /* 单世界模式无 worlds 时静默 */ });
  document.getElementById('side')!.addEventListener('click', () => { /* 面板区点击不动视图 */ });
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
  const dtSec = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  // 匀速行走：按固定速度逼近目标，避免缓出插值导致的停顿感
  for (const d of display.values()) {
    const prevX = d.x;
    const prevY = d.y;
    const dx = d.tx - d.x;
    const dy = d.ty - d.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.5) {
      const step = Math.min(dist, WALK_SPEED * dtSec);
      d.x += (dx / dist) * step;
      d.y += (dy / dist) * step;
    } else {
      d.x = d.tx;
      d.y = d.ty;
    }
    // 方向按本帧实际位移判定（主轴优先；位移过小时保持上一方向，避免拐角抖动）
    const mdx = d.x - prevX;
    const mdy = d.y - prevY;
    if (Math.abs(mdx) + Math.abs(mdy) > 0.3) {
      d.dir = Math.abs(mdx) >= Math.abs(mdy) ? (mdx > 0 ? 'right' : 'left') : (mdy > 0 ? 'down' : 'up');
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
  if (viewMode !== 'narrative' && now - lastMetricsAt > 2000) {
    lastMetricsAt = now;
    void fetchMetrics().then((m) => { metricsCache = m; });
  }
  if (viewMode === 'map') {
    const g = document.getElementById('game') as HTMLCanvasElement;
    resizeConsole(g);
    if (snap) drawMiniWorld(g.getContext('2d')!, snap, g.width, g.height);
  } else if (viewMode === 'net') {
    const net = document.getElementById('net-canvas') as HTMLCanvasElement;
    resizeConsole(net);
    drawNetwork(net.getContext('2d')!, snap?.agents ?? [], metricsCache.pairs, net.width, net.height, now);
  } else if (viewMode === 'metrics') {
    const met = document.getElementById('metrics-canvas') as HTMLCanvasElement;
    resizeConsole(met);
    drawMetrics(met.getContext('2d')!, metricsCache, met.width, met.height);
  } else {
    void 0; // 叙事视图：由 SSE 事件 + 2s 轮询驱动渲染
  }
  requestAnimationFrame(loop);
}

/** 控制台画布铺满窗口（与游戏画布同规格） */
function resizeConsole(c: HTMLCanvasElement): void {
  const stage = document.getElementById('stage')!;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(stage.clientWidth * dpr);
  const h = Math.floor(stage.clientHeight * dpr);
  if (c.width === w && c.height === h) return;
  c.width = w;
  c.height = h;
  c.style.width = `${stage.clientWidth}px`;
  c.style.height = `${stage.clientHeight}px`;
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
    const dir: Dir = d.dir;
    const walking = Math.abs(d.tx - d.x) > 1 || Math.abs(d.ty - d.y) > 1;
    const frame = (walking ? WALK_CYCLE[Math.floor(now / 140) % 4] : 0) as 0 | 1 | 2;
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
