// 像素小镇浏览器客户端：Canvas 2D 像素渲染，零依赖，SSE 实时刷新

import {
  drawNpc, npcAnimationPhase, npcConversationPlacement, npcPoseFor, npcRouteWaypoints, npcTargetPlacement,
  type Dir, type NpcPose,
} from './sprites';
import { drawTerrain, drawObjectDetail, drawObjectSelection, drawInterior, applyDayNight, TILE } from './render';
import { computeFit, zoomOffsets, detailScale, stepPixelZoom, clampCameraOffsets, type FitCamera } from './camera';
import { ParticleSystem, sitDust, steamPuff, sparkleBurst, zzzPuff, paperFlutter, smokePuff, fireflySpawn, rainDrop, rainSplash, type Particle } from './effects';
import {
  escapeHtml, STATE_NAME, TYPE_NAME, renderDetail, renderProfile, renderObjectCard, renderMind,
  bindPanel, updatePanelDeps, setRelationshipDyadFocus, clearRelationshipDyadFocus, type AgentView,
} from './panel';
import {
  drawNetwork, drawMetrics, fetchMetrics, fetchSocialNetwork, controlExperiment, exportMetrics,
  hitTestNetwork, hitTestNetworkEdge, networkLensLevel, resetNetworkLayout, METRIC_DEFINITIONS, NETWORK_LENSES,
  type MetricsPayload, type MetricKey, type NetworkNodeLayout, type NetworkEdgeLayout,
  type NetworkMode, type NetworkLens, type NetworkRenderResult, type SocialNetworkPayload,
} from './console';
import { drawTooltip, drawBanner, drawBubbles, actionIconFor, dprScale, type Bubble, type DisplayPos } from './hud';
import type { ObjectView } from './types';

interface ClockState { day: number; minutesOfDay: number; totalMinutes: number }
interface ActiveConversationView {
  conversationId: string;
  aId: string;
  bId: string;
  speakerId: string | null;
  phase?: 'waiting_model' | 'ready' | 'summarizing';
  waitMs?: number;
}
interface WorldSnapshot {
  clock: ClockState; speedPerRealSecond: number; paused: boolean;
  gridW: number; gridH: number; objects: ObjectView[]; agents: AgentView[]; seq: number;
  weather: 'clear' | 'rain';
  activeConversations?: ActiveConversationView[];
}
interface TownEvent { id: string;
  type: string; actorId: string | null; description: string;
  payload: {
    kind?: string; line?: string; thought?: string; fromId?: string; toId?: string;
    conversationId?: string;
  } | null;
}

interface WorldListItem {
  id: string;
  name: string;
  desc: string;
  badges?: { label: string; value: string; tone: 'on' | 'off' | 'neutral' }[];
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
let snap: WorldSnapshot | null = null;
let selectedId: string | null = null;
let selectedObjectId: string | null = null;

// 玩家扮演：快照不含该信息，客户端本地记录正在被扮演的 NPC
const playing = new Set<string>();
let playTargetId: string | null = null;
let playWorldId: string | null = null;

// 悬停 tooltip 与广播横幅（canvas 绘制层）
let tooltip: { text: string; x: number; y: number } | null = null;
let banner: { text: string; until: number } | null = null;

interface Display {
  x: number; y: number; tx: number; ty: number;
  lastTileX: number; lastTileY: number;
  dir: Dir; phase: number;
  waypoints: { x: number; y: number }[];
  speed: number;
}
interface ConversationRenderState { cx: number; cy: number; dir: Dir; speaking: boolean }
const WALK_SPEED = TILE * 5.5; // 像素/秒（匀速行走）
const display = new Map<string, Display>();
const bubbles = new Map<string, Bubble>();
const recentConversations = new Map<string, ActiveConversationView & { until: number }>();
const ticker: string[] = [];
const fx = new ParticleSystem();
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

// —— 像素细节相机：整数倍率、拖拽平移、边界钳制 ——
const camera: FitCamera = { scale: 1, offX: 0, offY: 0 };
let cameraReady = false;
let pendingCameraTarget: { x: number; y: number } | null = null;
let dragState: { pointerId: number; startX: number; startY: number; offX: number; offY: number; moved: boolean } | null = null;
let suppressMapClick = false;
let activeWorldId = 'w1';
const emptyMetrics = (): MetricsPayload => ({
  repeat: [], recip: [], clus: [], div: [], hhi: [], persistence: [], hub: [], pairs: [],
});
let metricsCache: MetricsPayload = emptyMetrics();
const metricsByWorld = new Map<string, MetricsPayload>();
let lastMetricsAt = 0;
let metricsRequestSeq = 0;
let metricsController: AbortController | null = null;
let metricsStatus: 'loading' | 'ready' | 'stale' = 'loading';
const emptySocialNetwork = (worldId: string): SocialNetworkPayload => ({
  worldId,
  modelVersion: 'social-relations-v2',
  generatedGameTime: 0,
  window: { days: 7, startGameTime: 0, endGameTime: 0, label: '近 7 日' },
  proxyNotice: '',
  measureSchema: [],
  dataQuality: [],
  observationSummary: { relationshipEvidence: 0, partnerChoices: 0 },
  directions: [],
  dyads: [],
});
let socialNetworkCache: SocialNetworkPayload = emptySocialNetwork(activeWorldId);
const socialNetworkByWorld = new Map<string, SocialNetworkPayload>();
let lastSocialNetworkAt = 0;
let socialNetworkStatus: 'loading' | 'ready' | 'error' = 'loading';
let socialNetworkRequestSeq = 0;
let socialNetworkController: AbortController | null = null;
let networkMode: NetworkMode = 'social';
let networkLens: NetworkLens = 'overall';
let networkWindowDays: number | null = 7;
let networkScope: 'all' | 'ego' = 'all';
let networkThreshold = 0;
let fitScale = 1;
let activeMetric: MetricKey = 'repeat';
let networkNodes: NetworkNodeLayout[] = [];
let networkEdges: NetworkEdgeLayout[] = [];
let hoveredNetworkId: string | null = null;
let hoveredNetworkEdgeId: string | null = null;
let lastNetworkPointer: { x: number; y: number } | null = null;
let selectedNetworkEdge: {
  id: string;
  worldId: string;
  mode: NetworkMode;
  fromId: string;
  toId: string;
} | null = null;
let networkEdgeControlSignature = '';
let lastSelectedDyadPanelRefreshAt = 0;
let toastTimer = 0;
// 记录上次快照的网格尺寸：仅当网格变化时重算 fit，避免高频快照复位滚轮缩放
let lastGridW = 0;
let lastGridH = 0;

const socialNetworkCacheKey = (worldId: string, windowDays: number | null) =>
  `${worldId}\u0000${windowDays === null ? 'all' : windowDays}`;
const activeSocialNetworkWindow = (): number | null => networkLens === 'overall' ? null : networkWindowDays;

function clearNetworkEdgeSelection(refreshRelationPanel = true): void {
  selectedNetworkEdge = null;
  hoveredNetworkEdgeId = null;
  clearRelationshipDyadFocus();
  networkEdgeControlSignature = '';
  const select = document.getElementById('network-edge-select') as HTMLSelectElement | null;
  if (select) {
    select.value = '';
    select.dataset.selected = 'false';
  }
  const tooltip = document.getElementById('network-edge-tooltip');
  if (tooltip) tooltip.hidden = true;
  const stage = document.querySelector<HTMLElement>('.network-stage');
  if (stage) {
    stage.classList.remove('has-edge-selection');
    delete stage.dataset.edgeSelected;
  }
  if (refreshRelationPanel && activeTab === 'relation' && selectedId) updatePanel();
}

function invalidateSocialNetworkRequest(): void {
  socialNetworkRequestSeq++;
  socialNetworkController?.abort();
  socialNetworkController = null;
  lastSocialNetworkAt = 0;
}

function invalidateMetricsRequest(): void {
  metricsRequestSeq++;
  metricsController?.abort();
  metricsController = null;
  lastMetricsAt = 0;
}

function maybeRefreshSelectedDyadPanel(now = Date.now()): void {
  if (!selectedNetworkEdge || selectedNetworkEdge.worldId !== activeWorldId || activeTab !== 'relation') return;
  if (now - lastSelectedDyadPanelRefreshAt < 5_000) return;
  lastSelectedDyadPanelRefreshAt = now;
  updatePanel();
}

async function main(): Promise<void> {
  const initial = (await (await fetch('/api/state')).json()) as WorldSnapshot & { worldId?: string };
  if (initial.worldId) activeWorldId = initial.worldId;
  snap = initial;
  selectedId = snap.agents[0]?.id ?? null;
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  for (const a of snap.agents) initDisplay(a);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseleave', () => { tooltip = null; });
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onMapPointerDown);
  canvas.addEventListener('pointermove', onMapPointerMove);
  canvas.addEventListener('pointerup', onMapPointerUp);
  canvas.addEventListener('pointercancel', onMapPointerUp);
  canvas.addEventListener('dblclick', () => resetDetailCamera());
  canvas.addEventListener('click', onClick);
  bindControls();
  bindWorkspaceInteractions();
  bindNetworkInteractions();
  bindMetricTabs();
  bindNarrativeFollow();
  bindPlayBar();
  updatePanelDeps({ playing, togglePlay });
  bindPanel((tab) => { activeTab = tab; }, updatePanel);
  document.addEventListener('relationship-dyad-focus-cleared', () => {
    if (selectedNetworkEdge) clearNetworkEdgeSelection(false);
  });
  renderRoster();
  renderCharacterCard(selectedId);
  updatePanel();
  const es = new EventSource('/events');
  es.addEventListener('open', () => setConnectionState(true));
  es.addEventListener('error', () => setConnectionState(false));
  es.addEventListener('snapshot', (ev) => {
    const incoming = JSON.parse((ev as MessageEvent<string>).data) as WorldSnapshot & { worldId?: string };
    if (incoming.worldId && incoming.worldId !== activeWorldId) return;
    snap = incoming;
    applySnapshot();
  });
  es.addEventListener('event', (ev) => onEvent(JSON.parse((ev as MessageEvent<string>).data) as TownEvent));
  updateHud();
  pollLLMStatus();
  requestAnimationFrame(loop);
}

function resizeCanvas(): void {
  const host = document.getElementById('town-body');
  if (!host) return;
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (width <= 0 || height <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  if (!cameraReady) resetDetailCamera();
  else if (pendingCameraTarget) {
    const target = pendingCameraTarget;
    pendingCameraTarget = null;
    centerCameraAt(target.x, target.y);
  }
  else clampCamera();
}

function resetDetailCamera(): void {
  if (!snap) return;
  const dpr = window.devicePixelRatio || 1;
  const f = computeFit(canvas.width / dpr, canvas.height / dpr, snap.gridW, snap.gridH, TILE);
  fitScale = f.scale;
  camera.scale = detailScale(fitScale);
  const selected = snap.agents.find((agent) => agent.id === selectedId);
  centerCameraAt(
    selected ? (selected.x + .5) * TILE : (snap.gridW * TILE) / 2,
    selected ? (selected.y + .5) * TILE : (snap.gridH * TILE) / 2
  );
  cameraReady = true;
  updateZoomLabel();
}

function applyCamera(): void {
  const dpr = window.devicePixelRatio || 1;
  // 设备像素对齐和最近邻采样共同保持像素素材边缘稳定。
  ctx.setTransform(camera.scale * dpr, 0, 0, camera.scale * dpr, Math.round(camera.offX * dpr), Math.round(camera.offY * dpr));
  ctx.imageSmoothingEnabled = false;
}

function resetCamera(): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
}

function canvasCssSize(): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1;
  return { width: canvas.width / dpr, height: canvas.height / dpr };
}

function centerCameraAt(worldX: number, worldY: number): void {
  const host = document.getElementById('town-body');
  if (!host || host.clientWidth <= 0 || host.clientHeight <= 0) {
    pendingCameraTarget = { x: worldX, y: worldY };
    return;
  }
  pendingCameraTarget = null;
  const view = canvasCssSize();
  camera.offX = view.width / 2 - worldX * camera.scale;
  camera.offY = view.height / 2 - worldY * camera.scale;
  clampCamera();
}

function clampCamera(): void {
  if (!snap) return;
  const view = canvasCssSize();
  const next = clampCameraOffsets(view.width, view.height, snap.gridW * TILE, snap.gridH * TILE, camera.scale, camera.offX, camera.offY);
  camera.offX = next.offX;
  camera.offY = next.offY;
}

function setPixelZoom(nextScale: number, anchorX?: number, anchorY?: number): void {
  const view = canvasCssSize();
  const ax = anchorX ?? view.width / 2;
  const ay = anchorY ?? view.height / 2;
  const offset = zoomOffsets(ax, ay, camera.scale, nextScale, camera.offX, camera.offY, TILE);
  camera.scale = nextScale;
  camera.offX = offset.offX;
  camera.offY = offset.offY;
  clampCamera();
  updateZoomLabel();
}

function updateZoomLabel(): void {
  const label = document.getElementById('map-zoom-label');
  if (label) label.textContent = `${Math.round(camera.scale * 100)}% · 拖拽平移`;
}
function initDisplay(a: AgentView): void {
  display.set(a.id, {
    x: a.x * TILE, y: a.y * TILE, tx: a.x * TILE, ty: a.y * TILE,
    lastTileX: a.x, lastTileY: a.y, dir: 'down', phase: npcAnimationPhase(a.id),
    waypoints: [], speed: WALK_SPEED,
  });
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
      const next = npcRouteWaypoints(
        a.path ?? [],
        { x: d.lastTileX, y: d.lastTileY },
        { x: a.x, y: a.y },
        TILE,
      );
      d.waypoints.push(...next);
      d.tx = a.x * TILE;
      d.ty = a.y * TILE;
      d.lastTileX = a.x;
      d.lastTileY = a.y;
      let routeLength = 0;
      let cursorX = d.x;
      let cursorY = d.y;
      for (const waypoint of d.waypoints) {
        routeLength += Math.abs(waypoint.x - cursorX) + Math.abs(waypoint.y - cursorY);
        cursorX = waypoint.x;
        cursorY = waypoint.y;
      }
      // 在下一次 500ms 快照前追上服务端；低速时维持清晰的像素游戏步速。
      d.speed = Math.max(WALK_SPEED, routeLength / 0.42);
    }
  }
  updateHud();
  renderRoster();
  renderSelectedCard();
  if (activeTab === 'detail' || activeTab === 'profile') updatePanel();
  if (snap.gridW !== lastGridW || snap.gridH !== lastGridH) {
    lastGridW = snap.gridW;
    lastGridH = snap.gridH;
    resetDetailCamera();
  }
}

function onEvent(e: TownEvent & { worldId?: string }): void {
  if (e.worldId && e.worldId !== activeWorldId) return;
  const kind = e.payload?.kind;
  if (kind === 'action_decision_quality') return;
  feed.unshift({ kind: kind ?? '', text: e.description, id: e.id });
  if (feed.length > 200) feed.pop();
  renderFeed();
  // 广播事件 → 顶部横幅（6 秒后淡出）
  if (kind === 'broadcast') {
    banner = { text: e.description, until: performance.now() + 6000 };
    return;
  }
  const fromId = e.payload?.fromId ?? e.actorId;
  const toId = e.payload?.toId;
  const conversationId = e.payload?.conversationId;
  if (kind === 'chat_summary') {
    if (conversationId) recentConversations.delete(conversationId);
    if (fromId && toId) recentConversations.delete(conversationKey(fromId, toId));
  } else if (kind === 'chat' && fromId && toId) {
    const key = conversationId ?? conversationKey(fromId, toId);
    recentConversations.set(key, {
      conversationId: key,
      aId: fromId,
      bId: toId,
      speakerId: fromId,
      until: performance.now() + (conversationId ? 12_000 : 6_000),
    });
  }
  if (fromId && (kind === 'thought' || kind === 'chat' || kind === 'chat_summary')) {
    const speaker = snap?.agents.find((x) => x.id === fromId)?.name ?? fromId;
    const text = kind === 'thought' ? (e.payload?.thought ?? '') : (e.payload?.line ?? '');
    // 对话条（chat/chat_summary）显示 9 秒，thought 气泡维持 7 秒
    const until = performance.now() + (kind === 'thought' ? 7000 : 9000);
    bubbles.set(fromId, { kind, speaker, text, until });
  }
}

function conversationKey(aId: string, bId: string): string {
  return aId < bId ? `pair:${aId}|${bId}` : `pair:${bId}|${aId}`;
}

/** 精确快照为主，SSE 窗口补足事件与下一帧快照之间的间隙。 */
function activeConversationsAt(nowMs: number): ActiveConversationView[] {
  for (const [id, conversation] of recentConversations) {
    if (conversation.until <= nowMs) recentConversations.delete(id);
  }
  const merged = new Map<string, ActiveConversationView>();
  for (const conversation of snap?.activeConversations ?? []) {
    merged.set(conversation.conversationId, conversation);
  }
  for (const conversation of recentConversations.values()) {
    const exact = merged.get(conversation.conversationId);
    merged.set(conversation.conversationId, {
      conversationId: conversation.conversationId,
      aId: exact?.aId ?? conversation.aId,
      bId: exact?.bId ?? conversation.bId,
      speakerId: conversation.speakerId ?? exact?.speakerId ?? null,
    });
  }
  return [...merged.values()]
    .filter((conversation) => conversation.aId !== conversation.bId)
    .sort((a, b) => a.conversationId.localeCompare(b.conversationId));
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
let lastNarrativeSignature = '';
let lastNarrativeAt = 0;
let narrativeFollow = true;

/** 叙事流：SillyTavern 式时间轴卡片 + 对话气泡 + 内心独白 */
function renderNarrative(items: NarrativeItem[]): void {
  const box = document.getElementById('narrative');
  if (!box) return;
  const activeElement = document.activeElement instanceof HTMLElement && box.contains(document.activeElement)
    ? document.activeElement
    : null;
  const activeCard = activeElement?.closest<HTMLElement>('[data-event-id]') ?? null;
  const activeActions = activeCard ? Array.from(activeCard.querySelectorAll<HTMLElement>('[data-agent-id]')) : [];
  const focusEventId = activeCard?.dataset.eventId ?? null;
  const focusActionIndex = activeElement ? activeActions.indexOf(activeElement) : -1;
  if (items.length === 0) {
    box.innerHTML = '<p class="label">当前世界尚无社会事件</p>';
    const jump = document.getElementById('narrative-jump');
    if (jump) jump.hidden = true;
    narrativeFollow = true;
    return;
  }
  const keepFollowing = narrativeFollow || box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  const previousTop = box.scrollTop;
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
    card.dataset.eventId = it.id;
    const meta = `<span class="nar-meta">${hhmm(it.minute)}</span>`;
    const actorData = it.actor ? encodeURIComponent(it.actor) : '';
    if (it.kind.startsWith('chat')) {
      card.className = 'nar-bubble';
      card.innerHTML = `<div class="nar-head"><button type="button" class="nar-ava" data-agent-id="${actorData}" aria-label="查看 ${escapeHtml(it.actorName)}">${escapeHtml(it.actorName.slice(0, 1))}</button><button type="button" class="nar-name" data-agent-id="${actorData}">${escapeHtml(it.actorName)}</button>${meta}</div><div class="nar-text">${escapeHtml(it.line ?? it.text)}</div>`;
    } else if (it.kind === 'thought' || ((it.kind.startsWith('thought')) && it.thought)) {
      card.className = 'nar-card thought';
      card.innerHTML = `${meta}<span class="nar-title">💭 ${escapeHtml(it.actorName)} 的内心独白</span><div class="nar-italic">${escapeHtml(it.thought ?? it.text)}</div>`;
    } else if (it.kind === 'experiment_pair_choice') {
      card.className = 'nar-card scene';
      const cands = (it.candidates ?? []).map((c) => {
        const id = c.name;
        const rel = c.affection !== 0 ? `💗${c.affection >= 0 ? '+' : ''}${c.affection}` : '';
        const ageMinutes = Math.max(0, it.time - c.lastInteraction);
        const hist = c.lastInteraction > 0
          ? ` · ${ageMinutes < 1440 ? '当天互动过' : `上次互动${Math.floor(ageMinutes / 1440)}天前`}`
          : '';
        const chosenCls = c.name === (it.candidates ?? []).find((x) => x.id === it.chosen)?.name ? ' chosen' : '';
        return `<button type="button" class="cand${chosenCls}" data-agent-id="${encodeURIComponent(c.id)}"><b>${escapeHtml(id)}</b> ${rel}${hist}</button>`;
      }).join(' ');
      const reason = it.mode === 'on'
        ? `本地机制正控按可访问的关系历史加权，选择了 ${escapeHtml(it.targetName ?? '')}。`
        : `本地零模型基线按种子化均匀抽样，选择了 ${escapeHtml(it.targetName ?? '')}。`;
      card.innerHTML = `${meta}<div class="nar-prose"><span class="nar-title">🌆 黄昏 · 选择时刻</span><br>${escapeHtml(it.actorName)} 在数量相等的候选伙伴之间做出选择——</div>
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
  box.querySelectorAll<HTMLElement>('[data-agent-id]').forEach((element) => {
    element.addEventListener('click', () => {
      const encoded = element.dataset.agentId;
      if (encoded) selectAgent(decodeURIComponent(encoded));
    });
  });
  if (focusEventId && focusActionIndex >= 0) {
    const restoredCard = Array.from(box.querySelectorAll<HTMLElement>('[data-event-id]'))
      .find((element) => element.dataset.eventId === focusEventId);
    restoredCard?.querySelectorAll<HTMLElement>('[data-agent-id]')[focusActionIndex]?.focus({ preventScroll: true });
  }
  if (keepFollowing) {
    box.scrollTop = box.scrollHeight;
    narrativeFollow = true;
  } else {
    box.scrollTop = previousTop;
    narrativeFollow = false;
    const jump = document.getElementById('narrative-jump');
    if (jump) jump.hidden = false;
  }
}

async function pollNarrative(): Promise<void> {
  const now = performance.now();
  if (now - lastNarrativeAt < 2000) return;
  lastNarrativeAt = now;
  try {
    const requestedWorld = activeWorldId;
    const res = await fetch(`/api/narrative?limit=300&worldId=${encodeURIComponent(requestedWorld)}`);
    if (!res.ok) throw new Error(String(res.status));
    const r = (await res.json()) as { worldId?: string; items: NarrativeItem[] };
    if (activeWorldId !== requestedWorld || r.worldId !== requestedWorld) return;
    const fresh = r.items.filter((x) => (x.id ?? '') !== '' && x.seq >= 0).slice(-120);
    const signature = `${requestedWorld}\u0000${fresh.map((item) => item.id).join('\u0000')}`;
    if (signature === lastNarrativeSignature) return;
    lastNarrativeSignature = signature;
    renderNarrative(fresh);
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

function renderSelectedCard(): void {
  if (!selectedObjectId) {
    renderCharacterCard(selectedId);
    return;
  }
  const card = document.getElementById('character-card');
  if (!card) return;
  const object = snap?.objects.find((item) => item.id === selectedObjectId);
  card.innerHTML = object
    ? `<div class="char-head"><span class="char-ava">⌂</span><div><div class="char-name">${escapeHtml(object.name)}</div><div class="char-sub">${escapeHtml(TYPE_NAME[object.type] ?? object.type)}</div></div></div><div class="char-row"><span>范围</span>${object.w}×${object.h} 格 · 坐标 (${object.x}, ${object.y})</div>`
    : '点击小镇居民或关系节点，查看人物属性与社会记录';
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

function selectAgent(id: string, centerMap = true, preserveNetworkEdge = false): void {
  if (!snap?.agents.some((agent) => agent.id === id)) return;
  if (!preserveNetworkEdge) clearNetworkEdgeSelection(false);
  selectedId = id;
  selectedObjectId = null;
  renderRoster();
  renderSelectedCard();
  updatePanel();
  if (centerMap) {
    const agent = snap.agents.find((item) => item.id === id)!;
    centerCameraAt((agent.x + .5) * TILE, (agent.y + .5) * TILE);
  }
}

function selectObject(id: string | null): void {
  clearNetworkEdgeSelection(false);
  selectedId = null;
  selectedObjectId = id;
  renderRoster();
  renderSelectedCard();
  updatePanel();
}

async function fetchWorldSnapshot(worldId: string): Promise<WorldSnapshot & { worldId: string }> {
  const response = await fetch(`/api/state?worldId=${encodeURIComponent(worldId)}`);
  if (!response.ok) throw new Error(`world snapshot unavailable (${response.status})`);
  const next = (await response.json()) as WorldSnapshot & { worldId?: string };
  if (next.worldId !== worldId) throw new Error('world snapshot mismatch');
  return next as WorldSnapshot & { worldId: string };
}

/** 以一个已验证的世界快照原子替换所有视图级临时状态。 */
function installWorldSnapshot(next: WorldSnapshot): void {
  snap = next;
  display.clear();
  lastActionKey.clear();
  zzzLast.clear();
  steamLast.clear();
  bubbles.clear();
  recentConversations.clear();
  fx.particles = [];
  tooltip = null;
  banner = null;
  feed.length = 0;
  lastNarrativeSignature = '';
  lastNarrativeAt = 0;
  narrativeFollow = true;
  const narrative = document.getElementById('narrative');
  if (narrative) narrative.innerHTML = '<p class="label">正在读取当前世界的社会事件…</p>';
  const narrativeJump = document.getElementById('narrative-jump');
  if (narrativeJump) narrativeJump.hidden = true;
  if (selectedId && !next.agents.some((agent) => agent.id === selectedId)) selectedId = next.agents[0]?.id ?? null;
  if (selectedObjectId && !next.objects.some((object) => object.id === selectedObjectId)) selectedObjectId = null;
  lastGridW = 0;
  lastGridH = 0;
  networkNodes = [];
  networkEdges = [];
  hoveredNetworkId = null;
  lastNetworkPointer = null;
  clearNetworkEdgeSelection(false);
  resetNetworkLayout();
  renderFeed();
  applySnapshot();
  updatePanel();
}

/** 居民名册是全部 Canvas 视图的键盘可访问选择入口。 */
function renderRoster(): void {
  const box = document.getElementById('roster');
  if (!box || !snap) return;
  let buttons = Array.from(box.querySelectorAll<HTMLButtonElement>('.roster-item'));
  const sameResidents = buttons.length === snap.agents.length
    && buttons.every((button, index) => button.dataset.id === snap!.agents[index].id);
  if (!sameResidents) {
    box.innerHTML = snap.agents.map((agent) =>
      `<button type="button" class="roster-item" data-id="${escapeHtml(agent.id)}"><span></span><span class="v"></span></button>`
    ).join('');
    buttons = Array.from(box.querySelectorAll<HTMLButtonElement>('.roster-item'));
    buttons.forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.id;
      if (id) selectAgent(id);
    }));
  }
  buttons.forEach((button, index) => {
    const agent = snap!.agents[index];
    const active = agent.id === selectedId;
    button.classList.toggle('hot', active);
    button.setAttribute('aria-pressed', String(active));
    const labels = button.querySelectorAll('span');
    if (labels[0]) labels[0].textContent = agent.name;
    if (labels[1]) labels[1].textContent = STATE_NAME[agent.state] ?? agent.state;
  });
}

/** 实验运行状态轮询 */
function pollExperiment(): void {
  const requestedWorld = activeWorldId;
  void fetch(`/api/experiment/state?worldId=${encodeURIComponent(requestedWorld)}`).then(async (r) => (
    r.ok ? r.json() : { available: false }
  )).then((st) => {
    if (activeWorldId !== requestedWorld || st.worldId !== requestedWorld) return;
    const el = document.getElementById('run-status');
    if (!el) return;
    if (st.available === false) {
      el.classList.remove('live');
      el.innerHTML = '<div class="dot"></div>实验：<b>此世界不适用</b>';
      return;
    }
    const live = !!st.running;
    el.classList.toggle('live', live);
    el.innerHTML = `<div class="dot"></div>实验：${live ? `<b>运行中（余 ${st.remainingDays} 天）</b>` : '<b>未运行</b>'}<br><span style="font-size:11px">记忆${st.mem === 'on' ? '开' : '关'} · 馈礼${st.gift === 'on' ? '开' : '关'}</span>`;
  }).catch(() => { /* 服务未就绪时静默 */ });
}
setInterval(pollExperiment, 2000);

function pollLLMStatus(): void {
  void fetch('/api/llm/status').then((response) => response.json()).then((status: {
    active?: number; queued?: number; maxQueued?: number; oldestWaitMs?: number; backpressured?: boolean;
    performance?: { generationTokensPerSecond?: number | null; recommendedMaxWorldSpeed?: number | null; confidence?: string };
  }) => {
    const element = document.getElementById('llm-status');
    if (!element) return;
    const active = Math.max(0, Number(status.active) || 0);
    const queued = Math.max(0, Number(status.queued) || 0);
    const waitSeconds = Math.ceil(Math.max(0, Number(status.oldestWaitMs) || 0) / 1000);
    const tokensPerSecond = Number(status.performance?.generationTokensPerSecond);
    const recommended = Number(status.performance?.recommendedMaxWorldSpeed);
    const calibration = Number.isFinite(tokensPerSecond) && tokensPerSecond > 0
      ? ` · ${tokensPerSecond.toFixed(1)} tok/s · 建议≤${recommended || 1}×`
      : ' · 待校准';
    element.classList.toggle('busy', !status.backpressured && (active > 0 || queued > 0));
    element.classList.toggle('pressure', !!status.backpressured);
    element.innerHTML = status.backpressured
      ? `<span class="llm-dot"></span>认知背压 · ${queued} 排队${calibration}`
      : queued > 0
        ? `<span class="llm-dot"></span>本地推理 · ${queued} 排队${waitSeconds ? ` · ${waitSeconds}s` : ''}${calibration}`
        : `<span class="llm-dot"></span>本地推理 · ${active ? '生成中' : '就绪'}${calibration}`;
  }).catch(() => {
    const element = document.getElementById('llm-status');
    if (element) element.innerHTML = '<span class="llm-dot"></span>本地推理 · 状态未知';
  });
}
setInterval(pollLLMStatus, 2000);

function showToast(message: string, tone: 'info' | 'success' | 'error' = 'info'): void {
  const toast = document.getElementById('ui-toast');
  if (!toast) return;
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3200);
}

function setConnectionState(online: boolean): void {
  const status = document.getElementById('connection-status');
  if (!status) return;
  status.classList.toggle('offline', !online);
  status.innerHTML = `<span class="live-dot"></span>纵向社会观测 · ${online ? '实时' : '正在重连'}`;
}

function bindWorkspaceInteractions(): void {
  const workspace = document.getElementById('research-workspace')!;
  const focusButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-focus-view]'));
  const refreshFocusButtons = () => {
    const focused = workspace.dataset.focus ?? '';
    for (const button of focusButtons) {
      const active = button.dataset.focusView === focused;
      button.setAttribute('aria-pressed', String(active));
      button.textContent = active ? '恢复三窗' : '聚焦';
    }
  };
  const setFocus = (view: string | null) => {
    if (view) workspace.dataset.focus = view;
    else delete workspace.dataset.focus;
    refreshFocusButtons();
    requestAnimationFrame(() => {
      resizeCanvas();
      window.dispatchEvent(new Event('resize'));
    });
  };
  for (const button of focusButtons) {
    button.addEventListener('click', () => {
      const view = button.dataset.focusView ?? '';
      setFocus(workspace.dataset.focus === view ? null : view);
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && workspace.dataset.focus) setFocus(null);
  });

  document.getElementById('map-zoom-out')!.addEventListener('click', () => setPixelZoom(stepPixelZoom(camera.scale, -1)));
  document.getElementById('map-zoom-in')!.addEventListener('click', () => setPixelZoom(stepPixelZoom(camera.scale, 1)));
  document.getElementById('map-reset')!.addEventListener('click', resetDetailCamera);
  document.getElementById('network-reset')!.addEventListener('click', () => {
    resetNetworkLayout();
    showToast(`${networkMode === 'social' ? '社会关系' : '伙伴选择'}网络已重新排布`, 'success');
  });
  document.getElementById('roster-toggle')!.addEventListener('click', (event) => {
    const roster = document.querySelector<HTMLElement>('.town-roster')!;
    const collapsed = roster.classList.toggle('is-collapsed');
    const button = event.currentTarget as HTMLButtonElement;
    button.textContent = collapsed ? '展开' : '收起';
    button.setAttribute('aria-expanded', String(!collapsed));
  });

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => resizeCanvas());
    observer.observe(document.getElementById('town-body')!);
  }
}

function networkAgentName(id: string): string {
  return snap?.agents.find((agent) => agent.id === id)?.name ?? id;
}

function activeNetworkLensLabel(): string {
  return NETWORK_LENSES.find((item) => item.key === networkLens)?.label ?? '综合关系强度';
}

function setNetworkEdgeSelection(edge: NetworkEdgeLayout): void {
  selectedNetworkEdge = {
    id: edge.id,
    worldId: activeWorldId,
    mode: edge.mode,
    fromId: edge.fromId,
    toId: edge.toId,
  };
  lastSelectedDyadPanelRefreshAt = Date.now();
  setRelationshipDyadFocus(
    edge.fromId,
    edge.toId,
    edge.mode === 'choice' || networkLens === 'overall' ? 'all' : (networkWindowDays ?? 'all'),
  );
  selectAgent(edge.fromId, false, true);
  const stage = document.querySelector<HTMLElement>('.network-stage');
  if (stage) {
    stage.classList.add('has-edge-selection');
    stage.dataset.edgeSelected = 'true';
  }
  const edgeSelect = document.getElementById('network-edge-select') as HTMLSelectElement | null;
  if (edgeSelect) {
    edgeSelect.value = edge.id;
    edgeSelect.dataset.selected = 'true';
  }
  const relationTab = document.querySelector<HTMLButtonElement>('#panel-tabs [data-tab="relation"]');
  if (relationTab && !relationTab.classList.contains('active')) relationTab.click();
}

function showNetworkEdgeTooltip(edge: NetworkEdgeLayout, x: number, y: number): void {
  const tooltip = document.getElementById('network-edge-tooltip') as HTMLElement | null;
  const stage = document.querySelector<HTMLElement>('.network-stage');
  if (!tooltip || !stage) return;
  const fromName = networkAgentName(edge.fromId);
  const toName = networkAgentName(edge.toId);
  const lensLabel = edge.mode === 'choice' ? '累计伙伴选择' : activeNetworkLensLabel();
  const value = edge.mode === 'choice' ? `${Math.round(edge.displayValue)} 次` : edge.displayValue.toFixed(3);
  const evidence = edge.mode === 'choice' ? `选择事件 ${edge.evidenceCount}` : `焦点组合事件 ${edge.evidenceCount}`;
  const connector = edge.directed ? '→' : '↔';
  const stateNotice = edge.mode === 'social' && edge.relationshipStateObserved === false
    ? ' · 仅行为观察，未建立持久化关系状态'
    : '';
  tooltip.innerHTML = `<strong>${escapeHtml(fromName)} ${connector} ${escapeHtml(toName)}</strong><span>${escapeHtml(lensLabel)}：${escapeHtml(value)}</span><small>${escapeHtml(evidence)}${stateNotice} · 点击查看双人证据</small>`;
  tooltip.hidden = false;
  const maxLeft = Math.max(8, stage.clientWidth - 286);
  const maxTop = Math.max(8, stage.clientHeight - 102);
  tooltip.style.left = `${Math.max(8, Math.min(maxLeft, x + 13))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(maxTop, y + 13))}px`;
}

function syncNetworkResearchControls(): void {
  const lens = document.getElementById('network-lens') as HTMLSelectElement | null;
  const windowSelect = document.getElementById('network-window') as HTMLSelectElement | null;
  const scope = document.getElementById('network-scope') as HTMLSelectElement | null;
  const threshold = document.getElementById('network-threshold') as HTMLInputElement | null;
  const thresholdOutput = (document.getElementById('network-threshold-output')
    ?? document.getElementById('network-threshold-value')) as HTMLOutputElement | null;
  const edgeSelect = document.getElementById('network-edge-select') as HTMLSelectElement | null;
  const edgeFieldLabel = document.getElementById('network-edge-field-label');
  if (lens) {
    lens.value = networkLens;
    lens.disabled = networkMode === 'choice';
  }
  if (windowSelect) {
    windowSelect.value = networkMode === 'social' && networkLens !== 'overall'
      ? (networkWindowDays === null ? 'all' : String(networkWindowDays))
      : 'all';
    windowSelect.disabled = networkMode === 'choice' || networkLens === 'overall';
  }
  if (scope) scope.value = networkScope;
  if (threshold) threshold.value = String(networkThreshold);
  if (thresholdOutput) {
    thresholdOutput.value = networkMode === 'choice'
      ? `≥ 最强边 ${Math.round(networkThreshold * 100)}%`
      : `≥ ${networkThreshold.toFixed(2)}`;
  }
  const actorLens = networkMode === 'social' && networkLensLevel(networkLens) === 'actor';
  if (edgeSelect) edgeSelect.disabled = false;
  if (edgeFieldLabel) edgeFieldLabel.textContent = actorLens ? '行动者节点编码' : '关系边定位';
}

function renderNetworkEdgeControls(result: NetworkRenderResult): void {
  networkNodes = result.nodes;
  networkEdges = result.edges;
  if (lastNetworkPointer) {
    hoveredNetworkId = hitTestNetwork(networkNodes, lastNetworkPointer.x, lastNetworkPointer.y);
    const pointerEdge = hoveredNetworkId
      ? null
      : hitTestNetworkEdge(networkEdges, lastNetworkPointer.x, lastNetworkPointer.y);
    hoveredNetworkEdgeId = pointerEdge?.id ?? null;
    if (pointerEdge) showNetworkEdgeTooltip(pointerEdge, lastNetworkPointer.x, lastNetworkPointer.y);
    else {
      const tooltip = document.getElementById('network-edge-tooltip');
      if (tooltip) tooltip.hidden = true;
    }
  }
  if (hoveredNetworkEdgeId && !networkEdges.some((edge) => edge.id === hoveredNetworkEdgeId)) {
    hoveredNetworkEdgeId = null;
    const tooltip = document.getElementById('network-edge-tooltip');
    if (tooltip) tooltip.hidden = true;
  }
  if (!lastNetworkPointer && document.activeElement?.id === 'net-canvas' && hoveredNetworkEdgeId) {
    const keyboardEdge = networkEdges.find((edge) => edge.id === hoveredNetworkEdgeId);
    if (keyboardEdge) {
      showNetworkEdgeTooltip(
        keyboardEdge,
        (keyboardEdge.startX + keyboardEdge.endX) / 2,
        (keyboardEdge.startY + keyboardEdge.endY) / 2,
      );
    }
  }
  if (selectedNetworkEdge && !networkEdges.some((edge) => edge.id === selectedNetworkEdge!.id)) {
    clearNetworkEdgeSelection();
  }
  const counter = document.getElementById('network-edge-count');
  if (counter) {
    if (result.countUnit === 'actor') {
      const missing = result.missingActors ? ` · ${result.missingActors} 位缺少可识别观察` : '';
      counter.textContent = `可见 ${result.visibleActors ?? 0} / ${result.totalActors ?? 0} 位行动者${missing}`;
    } else {
      const missing = result.missingEdges ? ` · ${result.missingEdges} 条缺少可识别观察` : '';
      counter.textContent = `可见 ${result.edges.length} / ${result.totalEdges} 条关系${missing}`;
    }
  }
  const select = document.getElementById('network-edge-select') as HTMLSelectElement | null;
  if (!select) return;
  const signature = [
    activeWorldId, networkMode, networkLens, networkWindowDays ?? 'all', networkScope, networkThreshold,
    selectedId ?? '', selectedNetworkEdge?.id ?? '',
    ...result.edges.map((edge) => `${edge.id}:${edge.displayValue}:${edge.evidenceCount}`),
    ...result.nodes.map((node) => `${node.agentId}:${node.actorValue ?? 'missing'}:${node.actorValueVisible ?? false}`),
  ].join('|');
  if (signature === networkEdgeControlSignature) return;
  networkEdgeControlSignature = signature;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = result.countUnit === 'actor'
    ? (result.visibleActors ? '选择一位有观察值的行动者' : '当前筛选下没有可见行动者值')
    : result.edges.length ? '选择一条可见关系边' : '当前筛选下没有可见边';
  const options = result.countUnit === 'actor'
    ? result.nodes.filter((node) => node.actorValueVisible && node.actorValue !== null).map((node) => {
      const option = document.createElement('option');
      option.value = `actor:${encodeURIComponent(node.agentId)}`;
      option.dataset.agentId = node.agentId;
      option.textContent = `${networkAgentName(node.agentId)} · ${node.actorValue!.toFixed(3)}`;
      return option;
    })
    : result.edges.map((edge) => {
    const option = document.createElement('option');
    option.value = edge.id;
    const value = edge.mode === 'choice' ? `${Math.round(edge.displayValue)} 次` : edge.displayValue.toFixed(3);
    const statePrefix = edge.mode === 'social' && edge.relationshipStateObserved === false ? '仅行为 · ' : '';
    option.textContent = `${statePrefix}${networkAgentName(edge.fromId)} ${edge.directed ? '→' : '↔'} ${networkAgentName(edge.toId)} · ${value}`;
    return option;
  });
  select.replaceChildren(placeholder, ...options);
  select.value = result.countUnit === 'actor' && selectedId
    ? `actor:${encodeURIComponent(selectedId)}`
    : selectedNetworkEdge?.id ?? '';
  select.dataset.selected = String(Boolean(select.value));
}

function bindNetworkInteractions(): void {
  const network = document.getElementById('net-canvas') as HTMLCanvasElement;
  const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-network-mode]'));
  const lensSelect = document.getElementById('network-lens') as HTMLSelectElement;
  const windowSelect = document.getElementById('network-window') as HTMLSelectElement;
  const scopeSelect = document.getElementById('network-scope') as HTMLSelectElement;
  const thresholdInput = document.getElementById('network-threshold') as HTMLInputElement;
  const edgeSelect = document.getElementById('network-edge-select') as HTMLSelectElement;

  lensSelect.replaceChildren(...NETWORK_LENSES.map((definition) => {
    const option = document.createElement('option');
    option.value = definition.key;
    const family = definition.family === 'added-four' ? '新增' : definition.family === 'existing-six' ? '既有' : '总览';
    option.textContent = `${family} · ${definition.label}`;
    return option;
  }));

  const refreshModeButtons = () => {
    for (const item of modeButtons) {
      const active = item.dataset.networkMode === networkMode;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
    }
    syncNetworkResearchControls();
    renderNetworkModeMeta();
  };
  for (const button of modeButtons) {
    button.addEventListener('click', () => {
      networkMode = button.dataset.networkMode === 'choice' ? 'choice' : 'social';
      clearNetworkEdgeSelection();
      resetNetworkLayout();
      refreshModeButtons();
    });
    button.addEventListener('keydown', (event) => {
      const current = modeButtons.indexOf(button);
      const targetIndex = event.key === 'Home' ? 0
        : event.key === 'End' ? modeButtons.length - 1
          : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (current + 1) % modeButtons.length
            : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (current - 1 + modeButtons.length) % modeButtons.length
              : -1;
      if (targetIndex < 0) return;
      event.preventDefault();
      modeButtons[targetIndex].focus();
      modeButtons[targetIndex].click();
    });
  }
  lensSelect.addEventListener('change', () => {
    const candidate = lensSelect.value as NetworkLens;
    if (!NETWORK_LENSES.some((item) => item.key === candidate)) return;
    networkLens = candidate;
    clearNetworkEdgeSelection();
    const requestedWindow = activeSocialNetworkWindow();
    const cached = socialNetworkByWorld.get(socialNetworkCacheKey(activeWorldId, requestedWindow));
    socialNetworkCache = cached ?? emptySocialNetwork(activeWorldId);
    socialNetworkStatus = cached ? 'ready' : 'loading';
    invalidateSocialNetworkRequest();
    syncNetworkResearchControls();
    renderNetworkModeMeta();
  });
  windowSelect.addEventListener('change', () => {
    networkWindowDays = windowSelect.value === 'all' ? null : Math.max(1, Number(windowSelect.value) || 7);
    clearNetworkEdgeSelection();
    const requestedWindow = activeSocialNetworkWindow();
    const cached = socialNetworkByWorld.get(socialNetworkCacheKey(activeWorldId, requestedWindow));
    socialNetworkCache = cached ?? emptySocialNetwork(activeWorldId);
    socialNetworkStatus = cached ? 'ready' : 'loading';
    invalidateSocialNetworkRequest();
    resetNetworkLayout();
    syncNetworkResearchControls();
    renderNetworkModeMeta();
  });
  scopeSelect.addEventListener('change', () => {
    networkScope = scopeSelect.value === 'ego' ? 'ego' : 'all';
    if (networkScope === 'ego' && !selectedId) selectedId = snap?.agents[0]?.id ?? null;
    clearNetworkEdgeSelection();
    syncNetworkResearchControls();
  });
  thresholdInput.addEventListener('input', () => {
    networkThreshold = Math.max(0, Math.min(1, Number(thresholdInput.value) || 0));
    clearNetworkEdgeSelection();
    syncNetworkResearchControls();
  });
  document.getElementById('network-filter-reset')!.addEventListener('click', () => {
    networkLens = 'overall';
    networkWindowDays = 7;
    networkScope = 'all';
    networkThreshold = 0;
    clearNetworkEdgeSelection();
    const requestedWindow = activeSocialNetworkWindow();
    const cached = socialNetworkByWorld.get(socialNetworkCacheKey(activeWorldId, requestedWindow));
    socialNetworkCache = cached ?? emptySocialNetwork(activeWorldId);
    socialNetworkStatus = cached ? 'ready' : 'loading';
    invalidateSocialNetworkRequest();
    resetNetworkLayout();
    syncNetworkResearchControls();
    renderNetworkModeMeta();
  });
  edgeSelect.addEventListener('change', () => {
    const agentId = edgeSelect.selectedOptions[0]?.dataset.agentId;
    if (agentId) {
      selectAgent(agentId);
      const relationTab = document.querySelector<HTMLButtonElement>('#panel-tabs [data-tab="relation"]');
      if (relationTab && !relationTab.classList.contains('active')) relationTab.click();
      return;
    }
    const edge = networkEdges.find((item) => item.id === edgeSelect.value);
    if (edge) setNetworkEdgeSelection(edge);
    else clearNetworkEdgeSelection();
  });

  const pointAt = (event: MouseEvent) => {
    const rect = network.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  network.addEventListener('mousemove', (event) => {
    const point = pointAt(event);
    lastNetworkPointer = point;
    hoveredNetworkId = hitTestNetwork(networkNodes, point.x, point.y);
    const edge = hoveredNetworkId ? null : hitTestNetworkEdge(networkEdges, point.x, point.y);
    hoveredNetworkEdgeId = edge?.id ?? null;
    if (edge) showNetworkEdgeTooltip(edge, point.x, point.y);
    else {
      const tooltip = document.getElementById('network-edge-tooltip');
      if (tooltip) tooltip.hidden = true;
    }
    network.style.cursor = hoveredNetworkId || edge ? 'pointer' : 'default';
  });
  network.addEventListener('mouseleave', () => {
    lastNetworkPointer = null;
    hoveredNetworkId = null;
    hoveredNetworkEdgeId = null;
    const tooltip = document.getElementById('network-edge-tooltip');
    if (tooltip) tooltip.hidden = true;
  });
  network.addEventListener('click', (event) => {
    const point = pointAt(event);
    const id = hitTestNetwork(networkNodes, point.x, point.y);
    if (id) {
      selectAgent(id);
      const relationTab = document.querySelector<HTMLButtonElement>('#panel-tabs [data-tab="relation"]');
      if (networkMode === 'social' && relationTab && !relationTab.classList.contains('active')) relationTab.click();
      return;
    }
    const edge = hitTestNetworkEdge(networkEdges, point.x, point.y);
    if (edge) setNetworkEdgeSelection(edge);
    else clearNetworkEdgeSelection();
  });
  network.addEventListener('keydown', (event) => {
    if (!networkEdges.length) return;
    if (event.key === 'Escape') {
      clearNetworkEdgeSelection();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const edge = networkEdges.find((item) => item.id === hoveredNetworkEdgeId)
        ?? networkEdges.find((item) => item.id === selectedNetworkEdge?.id)
        ?? networkEdges[0];
      setNetworkEdgeSelection(edge);
      return;
    }
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    lastNetworkPointer = null;
    const current = networkEdges.findIndex((edge) => edge.id === (hoveredNetworkEdgeId ?? selectedNetworkEdge?.id));
    const nextIndex = current < 0
      ? (step > 0 ? 0 : networkEdges.length - 1)
      : (current + step + networkEdges.length) % networkEdges.length;
    const next = networkEdges[nextIndex];
    hoveredNetworkEdgeId = next.id;
    edgeSelect.value = next.id;
    showNetworkEdgeTooltip(next, (next.startX + next.endX) / 2, (next.startY + next.endY) / 2);
  });
  network.addEventListener('blur', () => {
    lastNetworkPointer = null;
    hoveredNetworkEdgeId = null;
    const tooltip = document.getElementById('network-edge-tooltip');
    if (tooltip) tooltip.hidden = true;
  });
  refreshModeButtons();
}

function renderNetworkModeMeta(): void {
  const direction = document.getElementById('network-legend-direction');
  const weight = document.getElementById('network-legend-weight');
  const zone = document.getElementById('network-zone-label');
  if (!direction || !weight || !zone) return;
  if (networkMode === 'choice') {
    direction.textContent = '箭头＝伙伴选择方向';
    weight.textContent = '边宽＝累计选择次数；阈值＝相对最强边';
    zone.textContent = metricsStatus === 'stale'
      ? '累计伙伴选择更新暂缓 · 当前显示最近成功快照'
      : metricsStatus === 'loading'
        ? '累计伙伴选择网络 · 正在同步选择事件'
        : '累计伙伴选择网络 · 点击边读取该双人组合的全时段证据';
    return;
  }
  const level = networkLensLevel(networkLens);
  direction.textContent = networkLens === 'overall'
    ? '箭头＝累计关系状态方向'
    : level === 'actor'
    ? '节点外环＝行动者层测量'
    : level === 'dyad' ? '无向线＝双人共同量' : '箭头＝有向关系观察';
  weight.textContent = networkLens === 'overall'
    ? '边宽＝累计关系状态强度（时间窗不适用）'
    : level === 'actor'
    ? `外环粗细＝${activeNetworkLensLabel()}`
    : `边宽＝${activeNetworkLensLabel()}`;
  if (socialNetworkStatus === 'ready') {
    zone.textContent = networkLens === 'overall'
      ? '只读累计关系状态 · 点击关系查看全时段双人证据'
      : level === 'actor'
      ? `只读行动者测量 · ${socialNetworkCache.window.label} · 点击节点查看人物证据`
      : `只读关系测量 · ${socialNetworkCache.window.label} · 点击关系查看双人证据`;
  } else if (socialNetworkStatus === 'error') {
    zone.textContent = socialNetworkCache.directions.length
      ? '关系投影更新暂缓 · 当前显示最近快照'
      : '关系投影暂不可用 · 正在等待重新连接';
  } else {
    zone.textContent = '有向社会关系投影 · 正在同步证据';
  }
}

function bindMetricTabs(): void {
  const tabs = document.getElementById('metric-tabs')!;
  tabs.replaceChildren(...METRIC_DEFINITIONS.map((definition) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `metric-tab${definition.key === activeMetric ? ' active' : ''}`;
    button.dataset.metric = definition.key;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(definition.key === activeMetric));
    button.textContent = definition.shortLabel;
    button.addEventListener('click', () => {
      activeMetric = definition.key;
      tabs.querySelectorAll<HTMLButtonElement>('.metric-tab').forEach((item) => {
        const active = item.dataset.metric === activeMetric;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', String(active));
      });
    });
    return button;
  }));
}

function bindNarrativeFollow(): void {
  const narrative = document.getElementById('narrative')!;
  const jump = document.getElementById('narrative-jump') as HTMLButtonElement;
  const update = () => {
    narrativeFollow = narrative.scrollHeight - narrative.scrollTop - narrative.clientHeight < 48;
    jump.hidden = narrativeFollow;
  };
  narrative.addEventListener('scroll', update, { passive: true });
  jump.addEventListener('click', () => {
    narrative.scrollTop = narrative.scrollHeight;
    narrativeFollow = true;
    jump.hidden = true;
  });
}

function bindControls(): void {
  document.querySelectorAll('#controls button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.getAttribute('data-action')!;
      const effectiveAction = action === 'pause' && snap?.paused ? 'resume' : action;
      const value = btn.getAttribute('data-value');
      const button = btn as HTMLButtonElement;
      button.disabled = true;
      try {
        const response = await fetch('/api/world/control', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value ? { action: effectiveAction, value: Number(value) } : { action: effectiveAction }),
        });
        if (!response.ok) throw new Error(String(response.status));
        const result = await response.json() as { speed?: number; performance?: { generationTokensPerSecond?: number | null } };
        if (action === 'speed' && Number(value) > 1) {
          showToast('高速观察已启用认知采样；推理积压时虚拟时钟会自动等待', 'info');
        } else if (action === 'adaptive-speed') {
          const rate = Number(result.performance?.generationTokensPerSecond);
          showToast(`吞吐校准完成：${Number.isFinite(rate) ? `${rate.toFixed(1)} tok/s，` : ''}世界速度设为 ${result.speed ?? 1}×`, 'success');
        }
      } catch {
        showToast('世界时间控制未生效，请检查服务状态', 'error');
      } finally {
        button.disabled = false;
      }
    });
  });
  document.getElementById('exp-start')!.addEventListener('click', async () => {
    const mem = (document.getElementById('exp-mem') as HTMLInputElement).checked ? 'on' : 'off';
    const gift = (document.getElementById('exp-gift') as HTMLInputElement).checked ? 'on' : 'off';
    const days = Number((document.getElementById('exp-days') as HTMLInputElement).value || 30);
    const button = document.getElementById('exp-start') as HTMLButtonElement;
    const requestedWorld = activeWorldId;
    button.disabled = true;
    try {
      await controlExperiment('config', requestedWorld, { mem, gift });
      if (activeWorldId !== requestedWorld) throw new Error('active world changed');
      await controlExperiment('start', requestedWorld, { days });
      pollExperiment();
      showToast(`实验已启动：${days} 天`, 'success');
    } catch {
      showToast('实验启动失败，请检查当前世界与运行参数', 'error');
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('exp-stop')!.addEventListener('click', async () => {
    const button = document.getElementById('exp-stop') as HTMLButtonElement;
    const requestedWorld = activeWorldId;
    button.disabled = true;
    try {
      await controlExperiment('stop', requestedWorld);
      pollExperiment();
      showToast('实验已停止', 'success');
    } catch {
      showToast('实验停止请求失败', 'error');
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('exp-export')!.addEventListener('click', () => exportMetrics(metricsCache));
  renderFeed();
  pollExperiment();
  setInterval(() => void pollNarrative(), 2000);
  // 平行世界：列出世界并切换（服务端切换活跃世界，事件带 worldId 过滤）
  void fetch('/api/worlds').then((r) => r.json()).then((w: { active?: string; worlds: WorldListItem[] }) => {
    const sel = document.getElementById('world-select') as HTMLSelectElement;
    sel.replaceChildren(...w.worlds.map((x) => {
      const option = document.createElement('option');
      option.value = x.id;
      option.textContent = x.name;
      return option;
    }));
    activeWorldId = w.active ?? 'w1';
    sel.value = activeWorldId;
    const cur = w.worlds.find((x) => x.id === activeWorldId);
    if (cur) renderWorldMeta(cur);
    const activateWorldView = async (worldId: string): Promise<WorldListItem | undefined> => {
      const nextSnapshot = await fetchWorldSnapshot(worldId);
      activeWorldId = worldId;
      sel.value = worldId;
      installWorldSnapshot(nextSnapshot);
      const selectedWorld = w.worlds.find((item) => item.id === worldId);
      if (selectedWorld) renderWorldMeta(selectedWorld);
      metricsCache = metricsByWorld.get(worldId) ?? emptyMetrics();
      metricsStatus = metricsByWorld.has(worldId) ? 'ready' : 'loading';
      invalidateMetricsRequest();
      const relationCacheKey = socialNetworkCacheKey(worldId, activeSocialNetworkWindow());
      socialNetworkCache = socialNetworkByWorld.get(relationCacheKey) ?? emptySocialNetwork(worldId);
      socialNetworkStatus = socialNetworkByWorld.has(relationCacheKey) ? 'ready' : 'loading';
      invalidateSocialNetworkRequest();
      renderNetworkModeMeta();
      pollExperiment();
      void pollNarrative();
      return selectedWorld;
    };
    sel.addEventListener('change', async () => {
      const previousWorldId = activeWorldId;
      const requestedWorldId = sel.value;
      let switchIssued = false;
      sel.disabled = true;
      try {
        if (playTargetId) await stopPlay(playTargetId);
        switchIssued = true;
        const response = await fetch('/api/world/switch', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: requestedWorldId }),
        });
        if (!response.ok) throw new Error(String(response.status));
        const result = await response.json() as { active?: string };
        if (result.active !== requestedWorldId) throw new Error('world switch rejected');
        const c = await activateWorldView(requestedWorldId);
        showToast(`已切换到 ${c?.name ?? requestedWorldId}`, 'success');
      } catch {
        let actualWorldId: string | null = null;
        if (switchIssued) {
          try {
            const status = await fetch('/api/worlds');
            const state = await status.json() as { active?: string };
            if (status.ok && typeof state.active === 'string') actualWorldId = state.active;
          } catch { /* 继续执行幂等回滚 */ }
        }
        if (actualWorldId === requestedWorldId) {
          try {
            const c = await activateWorldView(requestedWorldId);
            showToast(`已切换到 ${c?.name ?? requestedWorldId}，状态已重新确认`, 'success');
            return;
          } catch { /* 快照不可用时恢复到先前世界 */ }
        }
        let rollbackConfirmed = !switchIssued || actualWorldId === previousWorldId;
        if (!rollbackConfirmed) {
          try {
            const rollback = await fetch('/api/world/switch', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: previousWorldId }),
            });
            const result = await rollback.json() as { active?: string };
            rollbackConfirmed = rollback.ok && result.active === previousWorldId;
          } catch {
            rollbackConfirmed = false;
          }
        }
        activeWorldId = previousWorldId;
        sel.value = activeWorldId;
        showToast(rollbackConfirmed
          ? '平行世界切换失败，当前世界保持不变'
          : '平行世界状态未能确认，请刷新页面重新同步', 'error');
      } finally {
        sel.disabled = false;
      }
    });
  }).catch(() => { /* 单世界模式无 worlds 时静默 */ });
  document.getElementById('side')!.addEventListener('click', () => { /* 检查器点击不影响小镇选择 */ });
}

function renderWorldMeta(world: WorldListItem): void {
  const desc = document.getElementById('world-desc')!;
  const badges = document.getElementById('world-badges')!;
  desc.textContent = world.desc;
  badges.replaceChildren(...(world.badges ?? []).map((badge) => {
    const el = document.createElement('span');
    el.className = `world-badge ${badge.tone}`;
    el.append(document.createTextNode(`${badge.label} `));
    const value = document.createElement('b');
    value.textContent = badge.value;
    el.appendChild(value);
    return el;
  }));
}

function onWheel(e: WheelEvent): void {
  if (!snap) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const ax = e.clientX - rect.left;
  const ay = e.clientY - rect.top;
  setPixelZoom(stepPixelZoom(camera.scale, e.deltaY < 0 ? 1 : -1), ax, ay);
}

function onMapPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    offX: camera.offX,
    offY: camera.offY,
    moved: false,
  };
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('is-dragging');
}

function onMapPointerMove(event: PointerEvent): void {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;
  if (Math.hypot(dx, dy) > 5) dragState.moved = true;
  camera.offX = dragState.offX + dx;
  camera.offY = dragState.offY + dy;
  clampCamera();
  tooltip = null;
}

function onMapPointerUp(event: PointerEvent): void {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  suppressMapClick = dragState.moved;
  dragState = null;
  canvas.classList.remove('is-dragging');
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}

function onClick(ev: MouseEvent): void {
  if (!snap) return;
  if (suppressMapClick) {
    suppressMapClick = false;
    return;
  }
  const { tx, ty } = tileAt(ev);
  const agent = snap.agents.find((a) => Math.abs(a.x - tx) <= 0.5 && Math.abs(a.y - ty) <= 0.5);
  if (agent) {
    selectAgent(agent.id, false);
    return;
  }
  // 未命中 NPC → 命中对象则显示建筑信息卡
  const obj = findObjectAtTile(tx, ty);
  selectObject(obj?.id ?? null);
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
let playStopPromise: Promise<void> | null = null;

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
  else void renderMind(body, a.id, activeTab, activeWorldId);
}

// —— 玩家扮演 ——
function togglePlay(id: string): void {
  const action = playing.has(id) ? stopPlay(id) : startPlay(id);
  void action.catch(() => showToast('扮演状态同步失败，请稍后重试', 'error'));
}

async function startPlay(id: string): Promise<void> {
  // 若此前在扮演其他 NPC，先清除服务端覆盖
  if (playTargetId && playTargetId !== id) {
    await stopPlay(playTargetId);
  }
  playing.add(id);
  playTargetId = id;
  playWorldId = activeWorldId;
  const input = document.getElementById('play-input') as HTMLInputElement;
  input.value = '';
  document.getElementById('play-bar')!.hidden = false;
  input.focus();
  updatePanel();
}

async function stopPlay(id: string): Promise<void> {
  if (playStopPromise) return playStopPromise;
  const worldId = playWorldId ?? activeWorldId;
  const operation = (async () => {
    const response = await fetch(`/api/player/${encodeURIComponent(id)}/act?worldId=${encodeURIComponent(worldId)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(String(response.status));
    const result = await response.json() as { worldId?: string };
    if (result.worldId !== worldId) throw new Error('player world mismatch');
    playing.delete(id);
    if (playTargetId === id) playTargetId = null;
    if (playWorldId === worldId) playWorldId = null;
    document.getElementById('play-bar')!.hidden = playTargetId === null;
    updatePanel();
  })();
  playStopPromise = operation;
  try {
    await operation;
  } finally {
    if (playStopPromise === operation) playStopPromise = null;
  }
}

async function sendPlay(): Promise<void> {
  if (!playTargetId) return;
  const worldId = playWorldId;
  if (!worldId || worldId !== activeWorldId) throw new Error('player world changed');
  const input = document.getElementById('play-input') as HTMLInputElement;
  const instruction = input.value.trim();
  if (!instruction) return;
  const response = await fetch(`/api/player/${encodeURIComponent(playTargetId)}/act?worldId=${encodeURIComponent(worldId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction }),
  });
  if (!response.ok) throw new Error(String(response.status));
  const result = await response.json() as { worldId?: string };
  if (result.worldId !== worldId) throw new Error('player world mismatch');
  input.value = '';
}

function bindPlayBar(): void {
  document.getElementById('play-send')!.addEventListener('click', () => {
    void sendPlay().catch(() => showToast('角色指令发送失败，请检查当前世界', 'error'));
  });
  document.getElementById('play-exit')!.addEventListener('click', () => {
    if (playTargetId) void stopPlay(playTargetId).catch(() => showToast('扮演状态同步失败', 'error'));
  });
}

function updateHud(): void {
  if (!snap) return;
  const c = snap.clock;
  const hh = String(Math.floor(c.minutesOfDay / 60)).padStart(2, '0');
  const mm = String(c.minutesOfDay % 60).padStart(2, '0');
  const paused = snap.paused ? ' ⏸ 已暂停' : '';
  document.getElementById('clock')!.textContent = `第${c.day}天 ${hh}:${mm}${paused}`;
  document.querySelectorAll<HTMLButtonElement>('#controls button[data-action]').forEach((button) => {
    const action = button.dataset.action;
    const speed = Number(button.dataset.value ?? NaN);
    const active = action === 'pause' ? snap!.paused : !snap!.paused && speed === snap!.speedPerRealSecond;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    if (action === 'pause') {
      button.textContent = snap!.paused ? '继续' : '暂停';
      button.setAttribute('aria-label', snap!.paused ? '继续运行所有平行世界' : '暂停所有平行世界');
    }
  });
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
  const conversing = new Set(activeConversationsAt(now).flatMap((conversation) => [conversation.aId, conversation.bId]));
  // 路段内匀速行走；快照跨多格时按真实 A* waypoint 加速追赶。
  for (const [id, d] of display) {
    if (conversing.has(id)) {
      // 后端同时锁定模拟动作；显示层清空历史路段并固定到会话前位置。
      d.x = d.tx;
      d.y = d.ty;
      d.waypoints.length = 0;
      continue;
    }
    let budget = d.speed * dtSec;
    while (budget > 0) {
      const target = d.waypoints[0] ?? { x: d.tx, y: d.ty };
      const dx = target.x - d.x;
      const dy = target.y - d.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= 0.5) {
        d.x = target.x;
        d.y = target.y;
        if (d.waypoints.length) {
          d.waypoints.shift();
          continue;
        }
        d.speed = WALK_SPEED;
        break;
      }
      d.dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      const step = Math.min(dist, budget);
      d.x += (dx / dist) * step;
      d.y += (dy / dist) * step;
      budget -= step;
      if (step < dist) break;
    }
  }
  const dt = now - lastFx;
  lastFx = now;
  for (const a of snap!.agents) {
    const d = display.get(a.id);
    if (!d) continue;
    if (conversing.has(a.id)) continue;
    const actionPose = npcPoseFor(a.state, a.targetName, false, a.verb);
    const actionPlacement = targetPlacementForAgent(a, d, actionPose);
    const fxCx = actionPlacement?.cx ?? d.x + TILE / 2;
    const fxCy = actionPlacement?.cy ?? d.y + TILE / 2;
    const key = `${a.targetName}:${a.verb}`;
    if (a.state === 'acting' && a.targetName && lastActionKey.get(a.id) !== key) {
      lastActionKey.set(a.id, key);
      if (actionPose === 'sleep') { fx.spawn(zzzPuff(fxCx, fxCy - 28)); zzzLast.set(a.id, now); }
      else if (actionPose === 'sit') fx.spawn(sitDust(fxCx, fxCy + 16));
      if (/煮|咖啡|泡/.test(a.verb)) fx.spawn(steamPuff(fxCx, fxCy - 22));
      if (/煮|泡/.test(a.verb)) steamLast.set(a.id, now);
      if (/写生|画|速写/.test(a.verb)) fx.spawn(sparkleBurst(fxCx, fxCy - 24, '#ffd700'));
      if (/信|分拣|送/.test(a.verb)) fx.spawn(paperFlutter(fxCx, fxCy - 28));
    }
    if (a.state === 'acting' && actionPose === 'sleep' && now - (zzzLast.get(a.id) ?? 0) > 900) {
      zzzLast.set(a.id, now);
      fx.spawn(zzzPuff(fxCx, fxCy - 28));
    }
    if (a.state === 'acting' && /煮|泡/.test(a.verb) && now - (steamLast.get(a.id) ?? 0) > 1200) {
      steamLast.set(a.id, now);
      fx.spawn(steamPuff(fxCx, fxCy - 24));
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
  if (now - lastMetricsAt > 2000 && !metricsController) {
    lastMetricsAt = now;
    const requestedWorld = activeWorldId;
    const requestSeq = ++metricsRequestSeq;
    const controller = new AbortController();
    metricsController = controller;
    void fetchMetrics(requestedWorld, controller.signal).then((metrics) => {
      if (requestSeq !== metricsRequestSeq || activeWorldId !== requestedWorld) return;
      metricsByWorld.set(requestedWorld, metrics);
      metricsCache = metrics;
      metricsStatus = 'ready';
      if (networkMode === 'choice') renderNetworkModeMeta();
      if (selectedNetworkEdge?.mode === 'choice') maybeRefreshSelectedDyadPanel();
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (requestSeq !== metricsRequestSeq || activeWorldId !== requestedWorld) return;
      metricsStatus = 'stale';
      if (networkMode === 'choice') renderNetworkModeMeta();
    }).finally(() => {
      if (metricsController === controller) metricsController = null;
    });
  }
  if (now - lastSocialNetworkAt > 2000 && !socialNetworkController) {
    lastSocialNetworkAt = now;
    const requestedWorld = activeWorldId;
    const requestedWindow = activeSocialNetworkWindow();
    const requestSeq = ++socialNetworkRequestSeq;
    const controller = new AbortController();
    socialNetworkController = controller;
    void fetchSocialNetwork(requestedWorld, requestedWindow, controller.signal).then((projection) => {
      socialNetworkByWorld.set(socialNetworkCacheKey(requestedWorld, requestedWindow), projection);
      if (requestSeq !== socialNetworkRequestSeq || activeWorldId !== requestedWorld || activeSocialNetworkWindow() !== requestedWindow) return;
      socialNetworkCache = projection;
      socialNetworkStatus = 'ready';
      renderNetworkModeMeta();
      if (selectedNetworkEdge?.mode === 'social') maybeRefreshSelectedDyadPanel();
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (requestSeq !== socialNetworkRequestSeq || activeWorldId !== requestedWorld || activeSocialNetworkWindow() !== requestedWindow) return;
      socialNetworkStatus = 'error';
      renderNetworkModeMeta();
    }).finally(() => {
      if (socialNetworkController === controller) socialNetworkController = null;
    });
  }
  draw();
  const net = document.getElementById('net-canvas') as HTMLCanvasElement;
  const netViewport = resizeConsole(net);
  if (netViewport.visible) {
    const netCtx = net.getContext('2d')!;
    netCtx.setTransform(netViewport.dpr, 0, 0, netViewport.dpr, 0, 0);
    const networkResult = drawNetwork(
      netCtx,
      snap?.agents ?? [],
      metricsCache.pairs,
      netViewport.width,
      netViewport.height,
      now,
      {
        selectedId,
        hoveredId: hoveredNetworkId,
        socialEdges: socialNetworkCache.directions,
        socialDyads: socialNetworkCache.dyads,
        mode: networkMode,
        lens: networkLens,
        threshold: networkThreshold,
        egoId: networkScope === 'ego' ? selectedId : null,
        selectedEdgeId: selectedNetworkEdge?.worldId === activeWorldId ? selectedNetworkEdge.id : null,
        hoveredEdgeId: hoveredNetworkEdgeId,
      },
    );
    renderNetworkEdgeControls(networkResult);
  }
  const met = document.getElementById('metrics-canvas') as HTMLCanvasElement;
  const metricViewport = resizeConsole(met);
  if (metricViewport.visible) {
    const metricCtx = met.getContext('2d')!;
    metricCtx.setTransform(metricViewport.dpr, 0, 0, metricViewport.dpr, 0, 0);
    drawMetrics(metricCtx, metricsCache, metricViewport.width, metricViewport.height, activeMetric);
  }
  requestAnimationFrame(loop);
}

/** 控制台画布跟随各自研究视窗尺寸。 */
function resizeConsole(c: HTMLCanvasElement): { width: number; height: number; dpr: number; visible: boolean } {
  const host = c.parentElement;
  if (!host) return { width: 0, height: 0, dpr: 1, visible: false };
  const dpr = window.devicePixelRatio || 1;
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (width <= 0 || height <= 0) return { width: 0, height: 0, dpr, visible: false };
  const bitmapWidth = Math.max(1, Math.floor(width * dpr));
  const bitmapHeight = Math.max(1, Math.floor(height * dpr));
  if (c.width !== bitmapWidth || c.height !== bitmapHeight) {
    c.width = bitmapWidth;
    c.height = bitmapHeight;
  }
  c.style.width = `${width}px`;
  c.style.height = `${height}px`;
  return { width, height, dpr, visible: true };
}

function draw(): void {
  if (!snap) return;
  const nowMs = performance.now();
  const worldW = snap.gridW * TILE;
  const worldH = snap.gridH * TILE;
  // 每帧覆盖完整位图，避免天气和屏幕层元素留下残影。
  resetCamera();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#090d15';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // 世界层：应用摄像机变换后绘制（地形/对象/agent/气泡）
  applyCamera();
  drawTerrain(ctx, worldW, worldH);
  drawObjects();
  const conversationRender = conversationRenderAt(nowMs);
  drawAgents(nowMs, conversationRender);
  drawWorldFx(ctx, nowMs);
  drawBubbles(ctx, bubbles, bubbleDisplayAt(conversationRender), nowMs);
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
  // 地图名称由屏幕 tooltip 与右侧检查器呈现，选中态只在物体边缘绘制轮廓。
  const selectedObject = selectedObjectId ? snap!.objects.find((object) => object.id === selectedObjectId) : null;
  if (selectedObject) drawObjectSelection(ctx, selectedObject);
}

function conversationRenderAt(nowMs: number): Map<string, ConversationRenderState> {
  const staged = new Map<string, ConversationRenderState>();
  for (const conversation of activeConversationsAt(nowMs)) {
    if (staged.has(conversation.aId) || staged.has(conversation.bId)) continue;
    const a = display.get(conversation.aId);
    const b = display.get(conversation.bId);
    if (!a || !b) continue;
    const placement = npcConversationPlacement(
      conversation.aId,
      conversation.bId,
      a.tx + TILE / 2,
      a.ty + TILE / 2,
      b.tx + TILE / 2,
      b.ty + TILE / 2
    );
    staged.set(conversation.aId, {
      ...placement.a,
      speaking: conversation.speakerId === conversation.aId,
    });
    staged.set(conversation.bId, {
      ...placement.b,
      speaking: conversation.speakerId === conversation.bId,
    });
  }
  return staged;
}

function bubbleDisplayAt(staged: Map<string, ConversationRenderState>): Map<string, DisplayPos> {
  const positions = new Map<string, DisplayPos>();
  for (const [id, d] of display) positions.set(id, { x: d.x, y: d.y });
  for (const [id, state] of staged) {
    positions.set(id, { x: state.cx - TILE / 2, y: state.cy - TILE / 2 });
  }
  return positions;
}

function targetPlacementForAgent(a: AgentView, d: Display, pose: NpcPose) {
  if (!snap || (pose !== 'sleep' && pose !== 'sit') || !a.targetName) return null;
  const exactTarget = a.targetId ? snap.objects.find((object) => object.id === a.targetId) : null;
  const candidates = exactTarget ? [exactTarget] : snap.objects.filter((object) => object.name === a.targetName);
  const containsAgent = (object: ObjectView) => (
    a.x >= object.x && a.x < object.x + object.w && a.y >= object.y && a.y < object.y + object.h
  );
  const distance = (object: ObjectView) => {
    const dx = object.x + object.w / 2 - (a.x + .5);
    const dy = object.y + object.h / 2 - (a.y + .5);
    return dx * dx + dy * dy;
  };
  const target = [...candidates].sort((left, right) => (
    Number(containsAgent(right)) - Number(containsAgent(left))
      || distance(left) - distance(right)
      || left.id.localeCompare(right.id)
  ))[0];
  if (!target) return null;
  return npcTargetPlacement(pose, {
    x: target.x * TILE,
    y: target.y * TILE,
    w: target.w * TILE,
    h: target.h * TILE,
  }, d.x + TILE / 2, d.y + TILE / 2, d.dir);
}

function drawAgents(now: number, conversationRender: Map<string, ConversationRenderState>): void {
  const sorted = [...snap!.agents].sort((a, b) => (
    (conversationRender.get(a.id)?.cy ?? display.get(a.id)?.y ?? a.y * TILE)
      - (conversationRender.get(b.id)?.cy ?? display.get(b.id)?.y ?? b.y * TILE)
  ));
  for (const a of sorted) {
    const d = display.get(a.id)!;
    const conversation = conversationRender.get(a.id);
    const walking = !conversation && (d.waypoints.length > 0 || Math.abs(d.tx - d.x) > 1 || Math.abs(d.ty - d.y) > 1);
    const pose = conversation
      ? (conversation.speaking ? 'speak' : 'interact')
      : npcPoseFor(a.state, a.targetName, walking, a.verb);
    const targetPlacement = conversation ? null : targetPlacementForAgent(a, d, pose);
    const dir: Dir = conversation?.dir ?? targetPlacement?.dir ?? d.dir;
    const cx = conversation?.cx ?? targetPlacement?.cx ?? d.x + TILE / 2;
    const cy = conversation?.cy ?? targetPlacement?.cy ?? d.y + TILE / 2;
    drawNpc(ctx, cx, cy, dir, a.spriteIndex, {
      pose, nowMs: now, phase: d.phase, selected: a.id === selectedId, name: a.name,
    });
    // 动作图标：acting 且映射到图标时，头顶弹跳。
    if (a.state === 'acting') {
      const icon = actionIconFor(a.verb, a.targetName);
      if (icon) {
        const bounce = Math.round(Math.sin(now / 250) * 2);
        ctx.font = '14px monospace';
        ctx.fillText(icon, Math.round(cx) - 7, Math.round(cy) - 44 + bounce);
      }
    }
    // 正在被玩家扮演的 NPC：名字旁补 🎮 徽标
    if (playing.has(a.id)) {
      ctx.font = '10px monospace';
      ctx.fillText('🎮', Math.round(cx + ctx.measureText(a.name).width / 2 + 2), Math.round(cy) + 19);
    }
  }
}

void main();
