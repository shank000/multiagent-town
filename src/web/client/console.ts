// 社会研究控制台：有向伙伴选择网络、结构指标主图与实验控制。

import type { AgentView } from './panel';
import type {
  DirectedRelationalMeasures,
  DyadRelationalMeasures,
  RelationalMeasureDefinition,
  RelationalMeasureKey,
} from '../../engine/social-relations';
import type {
  MetricAvailability,
  MetricAvailabilityMap,
  MetricSeriesDays,
  MetricSeriesKey,
} from '../../engine/metrics';

export interface MetricsPayload {
  repeat: number[];
  recipRate: number[];
  recipBaseline: number[];
  recip: number[];
  clus: number[];
  div: number[];
  hhi: number[];
  persistence: number[];
  hub: number[];
  seriesDays: MetricSeriesDays;
  availability: MetricAvailabilityMap;
  pairs: { pair: string; count: number }[];
}

export type NetworkMode = 'social' | 'choice';

export interface SocialNetworkEdge {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  strength: number;
  valence: number;
  recentChange: number;
  evidenceCount: number;
  relationshipStateObserved?: boolean;
  tieType: 'close' | 'supportive' | 'respect_based' | 'familiar' | 'strained' | 'asymmetric' | 'acquaintance';
  tieLabel: string;
  dimensions: {
    closeness: number; trust: number; respect: number;
    support: number; tension: number; frequency: number;
  };
  measures: DirectedRelationalMeasures;
}

export interface SocialNetworkPayload {
  worldId: string;
  modelVersion: string;
  generatedGameTime: number;
  window: { days: number | null; startGameTime: number; endGameTime: number; label: string };
  proxyNotice: string;
  measureSchema: readonly RelationalMeasureDefinition[];
  dataQuality: string[];
  observationSummary: { relationshipEvidence: number; partnerChoices: number };
  directions: SocialNetworkEdge[];
  dyads: {
    aId: string; aName: string; bId: string; bName: string; reciprocity: number; asymmetry: number;
    strength: number; recentChange: number; tieType: SocialNetworkEdge['tieType']; tieLabel: string;
    measures: DyadRelationalMeasures;
  }[];
}

export type NetworkLens = 'overall' | RelationalMeasureKey;
export type NetworkLensLevel = 'directed' | 'dyad' | 'actor';

export const NETWORK_LENSES: ReadonlyArray<{
  key: NetworkLens;
  label: string;
  family: 'overview' | 'existing-six' | 'added-four';
  level: NetworkLensLevel;
}> = [
  { key: 'overall', label: '综合关系强度', family: 'overview', level: 'directed' },
  { key: 'partnerReturn', label: '伙伴回返', family: 'existing-six', level: 'directed' },
  { key: 'tiePersistence', label: '关系持续性', family: 'existing-six', level: 'directed' },
  { key: 'recencyEffect', label: '近因暴露代理', family: 'existing-six', level: 'directed' },
  { key: 'reciprocity', label: '互惠交换', family: 'existing-six', level: 'dyad' },
  { key: 'relationalCarryOver', label: '关系延续效应', family: 'existing-six', level: 'directed' },
  { key: 'partnerConcentration', label: '伙伴集中度', family: 'existing-six', level: 'actor' },
  { key: 'interactionIntensity', label: '互动强度', family: 'added-four', level: 'directed' },
  { key: 'multiplexity', label: '关系多重性', family: 'added-four', level: 'directed' },
  { key: 'dependenceAsymmetry', label: '依赖不对称', family: 'added-four', level: 'dyad' },
  { key: 'embeddedness', label: '网络嵌入性', family: 'added-four', level: 'dyad' },
];

export function networkLensLevel(lens: NetworkLens): NetworkLensLevel {
  return NETWORK_LENSES.find((item) => item.key === lens)?.level ?? 'directed';
}

export type MetricKey = MetricSeriesKey;

export const METRIC_DEFINITIONS: ReadonlyArray<{
  key: MetricKey;
  label: string;
  shortLabel: string;
  description: string;
  min: number;
  fixedMax?: number;
  color: string;
  reference?: { value?: number; series?: 'recipBaseline'; label: string };
}> = [
  { key: 'repeat', label: '同对重复率', shortLabel: '重复', description: '昨日 A→B 在今日仍出现 A→B 的比例 · 0–1', min: 0, fixedMax: 1, color: '#f2c66d' },
  { key: 'recipRate', label: '跨日互惠率', shortLabel: '互惠率', description: 'P(B 今日选择 A｜A 昨日选择 B) · 0–1', min: 0, fixedMax: 1, color: '#77b8ff', reference: { series: 'recipBaseline', label: '等候选随机基线' } },
  { key: 'recip', label: '机会校正互惠倍数', shortLabel: '互惠倍数', description: '跨日互惠率 ÷ 等候选随机基线 · 1=随机基线', min: 0, color: '#9a9dff', reference: { value: 1, label: '随机基线 1.0' } },
  { key: 'clus', label: '聚类系数', shortLabel: '聚类', description: '无向选择网络中的闭合三元组比例 · 0–1', min: 0, fixedMax: 1, color: '#7dd7a0' },
  { key: 'div', label: '伙伴多样性（7日）', shortLabel: '多样性', description: '滚动 7 日内活跃行动者的平均独立伙伴数', min: 0, color: '#f58fa6' },
  { key: 'hhi', label: '伙伴集中度 HHI（7日）', shortLabel: '集中度', description: '滚动 7 日有向选择份额平方和 · 0–1', min: 0, fixedMax: 1, color: '#c39cff' },
  { key: 'persistence', label: '双 7 日关系矩阵持续性', shortLabel: '持续性', description: '相邻非重叠双 7 日有向矩阵 Pearson r · −1–1', min: -1, fixedMax: 1, color: '#62dacb' },
  { key: 'hub', label: '加权入度枢纽集中度', shortLabel: '枢纽', description: '接收选择权重的 Freeman 式集中度 · 0–1', min: 0, fixedMax: 1, color: '#ff9d70' },
];

export interface NetworkNodeLayout {
  agentId: string;
  x: number;
  y: number;
  radius: number;
  actorValue?: number | null;
  actorValueVisible?: boolean;
}

export interface NetworkEdgeLayout {
  id: string;
  mode: NetworkMode;
  fromId: string;
  toId: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  hitWidth: number;
  lineWidth: number;
  displayValue: number;
  evidenceCount: number;
  directed: boolean;
  level: 'directed' | 'dyad';
  relationshipStateObserved: boolean | null;
}

export interface NetworkRenderResult {
  nodes: NetworkNodeLayout[];
  edges: NetworkEdgeLayout[];
  totalEdges: number;
  missingEdges: number;
  countUnit: 'edge' | 'actor';
  totalActors?: number;
  visibleActors?: number;
  missingActors?: number;
}

export interface NetworkDrawState {
  selectedId?: string | null;
  hoveredId?: string | null;
  socialEdges?: readonly SocialNetworkEdge[];
  socialDyads?: ReadonlyArray<SocialNetworkPayload['dyads'][number]>;
  mode?: NetworkMode;
  lens?: NetworkLens;
  threshold?: number;
  egoId?: string | null;
  selectedEdgeId?: string | null;
  hoveredEdgeId?: string | null;
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

interface GraphEdge {
  id: string;
  from: number;
  to: number;
  fromId: string;
  toId: string;
  weight: number;
  strength: number;
  displayValue: number;
  recentChange: number;
  valence: number;
  evidenceCount: number;
  tieType: SocialNetworkEdge['tieType'] | 'choice';
  directed: boolean;
  level: 'directed' | 'dyad';
  relationshipStateObserved: boolean | null;
}

export function networkEdgeId(mode: NetworkMode, fromId: string, toId: string): string {
  return `${mode}:${encodeURIComponent(fromId)}>${encodeURIComponent(toId)}`;
}

export function networkDyadEdgeId(mode: NetworkMode, aId: string, bId: string): string {
  const [left, right] = aId < bId ? [aId, bId] : [bId, aId];
  return `${mode}:${encodeURIComponent(left)}<>${encodeURIComponent(right)}`;
}

const graphDyadKey = (a: string, b: string) => a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
const graphDirectionKey = (fromId: string, toId: string) => `${fromId}\u0000${toId}`;

export function networkLensValue(
  edge: SocialNetworkEdge,
  dyad: SocialNetworkPayload['dyads'][number] | undefined,
  lens: NetworkLens,
): number | null {
  if (lens === 'overall') return edge.strength;
  if (lens === 'reciprocity' || lens === 'dependenceAsymmetry' || lens === 'embeddedness') {
    return dyad?.measures[lens].value ?? null;
  }
  return edge.measures[lens].value;
}

function socialEdgeRgb(edge: GraphEdge, lens: NetworkLens): string {
  if (lens === 'overall') {
    if (edge.valence <= -0.08) return '245,119,119';
    if (edge.valence >= 0.08) return '98,218,203';
    return '143,161,183';
  }
  if (lens === 'dependenceAsymmetry') return '195,156,255';
  if (lens === 'multiplexity') return '242,198,109';
  if (lens === 'reciprocity') return '119,184,255';
  if (lens === 'embeddedness') return '125,215,160';
  return '98,218,203';
}

function directedObservationCount(edge: SocialNetworkEdge, lens: NetworkLens): number {
  if (lens === 'overall') return edge.evidenceCount;
  if (lens === 'interactionIntensity') return edge.measures.interactionEventCount;
  if (lens === 'multiplexity' || lens === 'recencyEffect') {
    return edge.measures.interactionEventCount + edge.measures.choiceCount;
  }
  return edge.measures.choiceCount;
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

/** 点到线段距离，坐标统一为 CSS px；零长度线段按点距离处理。 */
export function distanceToSegment(
  x: number,
  y: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): number {
  const dx = endX - startX;
  const dy = endY - startY;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= Number.EPSILON) return Math.hypot(x - startX, y - startY);
  const t = Math.max(0, Math.min(1, ((x - startX) * dx + (y - startY) * dy) / lengthSquared));
  return Math.hypot(x - (startX + t * dx), y - (startY + t * dy));
}

/** 命中最近的关系边；双向平行边按实际偏移几何分别识别。 */
export function hitTestNetworkEdge(
  edges: readonly NetworkEdgeLayout[],
  x: number,
  y: number,
): NetworkEdgeLayout | null {
  let best: { edge: NetworkEdgeLayout; distance: number } | null = null;
  for (const edge of edges) {
    const distance = distanceToSegment(x, y, edge.startX, edge.startY, edge.endX, edge.endY);
    if (distance <= edge.hitWidth && (!best || distance < best.distance)) best = { edge, distance };
  }
  return best?.edge ?? null;
}

/**
 * 多层关系网络。有向量用箭头、双人共同量用无向线、行动者量用节点外环；
 * 返回几何与实际绘制完全一致，供鼠标、触控替代入口与键盘选择共享。
 */
export function drawNetwork(
  ctx: CanvasRenderingContext2D,
  agents: AgentView[],
  pairs: MetricsPayload['pairs'],
  w: number,
  h: number,
  nowMs: number,
  state: NetworkDrawState = {},
): NetworkRenderResult {
  const selectedId = state.selectedId ?? null;
  const hoveredId = state.hoveredId ?? null;
  const socialEdges = state.socialEdges ?? [];
  const socialDyads = state.socialDyads ?? [];
  const mode = state.mode ?? 'choice';
  const lens = state.lens ?? 'overall';
  const threshold = Math.max(0, Math.min(1, state.threshold ?? 0));
  const egoId = state.egoId ?? null;
  const selectedEdgeId = state.selectedEdgeId ?? null;
  const hoveredEdgeId = state.hoveredEdgeId ?? null;
  ctx.fillStyle = '#09111d';
  ctx.fillRect(0, 0, w, h);
  if (!agents.length) {
    ctx.fillStyle = '#95a7bd';
    ctx.font = '14px "Microsoft YaHei UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('等待伙伴选择数据', w / 2, h / 2);
    ctx.textAlign = 'left';
    return { nodes: [], edges: [], totalEdges: 0, missingEdges: 0, countUnit: 'edge' };
  }

  const n = agents.length;
  const indexById = new Map(agents.map((agent, index) => [agent.id, index]));
  const dyadByKey = new Map(socialDyads.map((dyad) => [graphDyadKey(dyad.aId, dyad.bId), dyad]));
  const socialDirectionByKey = new Map(socialEdges.map((edge) => [graphDirectionKey(edge.fromId, edge.toId), edge]));
  const lensLevel = mode === 'social' ? networkLensLevel(lens) : 'directed';
  let totalEdges = 0;
  let missingEdges = 0;
  let totalActors = 0;
  let visibleActors = 0;
  let missingActors = 0;
  const actorValues = new Map<string, number | null>();
  const actorValueVisible = new Set<string>();
  const edges: GraphEdge[] = [];

  if (mode === 'social' && lensLevel === 'actor') {
    const observedConcentration = new Map<string, number>();
    for (const edge of socialEdges) {
      const value = edge.measures.partnerConcentration.value;
      if (value !== null && Number.isFinite(value) && !observedConcentration.has(edge.fromId)) {
        observedConcentration.set(edge.fromId, value);
      }
    }
    for (const agent of agents) {
      if (egoId && agent.id !== egoId) continue;
      totalActors++;
      const value = observedConcentration.get(agent.id) ?? null;
      actorValues.set(agent.id, value);
      if (value === null) {
        missingActors++;
        continue;
      }
      const normalizedValue = Math.max(0, Math.min(1, value));
      if (normalizedValue >= threshold) {
        visibleActors++;
        actorValueVisible.add(agent.id);
      }
    }
  } else if (mode === 'social' && lensLevel === 'dyad') {
    const dyadLens = lens as 'reciprocity' | 'dependenceAsymmetry' | 'embeddedness';
    for (const dyad of socialDyads) {
      const from = indexById.get(dyad.aId);
      const to = indexById.get(dyad.bId);
      if (from === undefined || to === undefined || from === to) continue;
      if (egoId && dyad.aId !== egoId && dyad.bId !== egoId) continue;
      totalEdges++;
      const measure = dyad.measures[dyadLens];
      const displayValue = measure.value;
      if (displayValue === null || !Number.isFinite(displayValue)) {
        missingEdges++;
        continue;
      }
      const normalizedValue = Math.max(0, Math.min(1, displayValue));
      if (normalizedValue < threshold) continue;
      const aToB = socialDirectionByKey.get(graphDirectionKey(dyad.aId, dyad.bId));
      const bToA = socialDirectionByKey.get(graphDirectionKey(dyad.bId, dyad.aId));
      const choiceObservations = (aToB?.measures.choiceCount ?? 0) + (bToA?.measures.choiceCount ?? 0);
      const interactionObservations = (aToB?.measures.interactionEventCount ?? 0)
        + (bToA?.measures.interactionEventCount ?? 0);
      const observationCount = dyadLens === 'dependenceAsymmetry'
        ? choiceObservations
        : dyadLens === 'reciprocity' && choiceObservations > 0
          ? choiceObservations
          : choiceObservations + interactionObservations;
      edges.push({
        id: networkDyadEdgeId('social', dyad.aId, dyad.bId),
        from, to, fromId: dyad.aId, toId: dyad.bId,
        weight: 1 + normalizedValue * 10,
        strength: Math.max(0, Math.min(1, dyad.strength)),
        displayValue: normalizedValue,
        recentChange: dyad.recentChange,
        valence: 0,
        evidenceCount: observationCount,
        tieType: dyad.tieType,
        directed: false,
        level: 'dyad',
        relationshipStateObserved: Boolean(
          (aToB && aToB.relationshipStateObserved !== false)
          || (bToA && bToA.relationshipStateObserved !== false),
        ),
      });
    }
  } else if (mode === 'social') {
    for (const edge of socialEdges) {
      const from = indexById.get(edge.fromId);
      const to = indexById.get(edge.toId);
      if (from === undefined || to === undefined || from === to) continue;
      if (egoId && edge.fromId !== egoId && edge.toId !== egoId) continue;
      totalEdges++;
      const displayValue = networkLensValue(edge, dyadByKey.get(graphDyadKey(edge.fromId, edge.toId)), lens);
      if (displayValue === null || !Number.isFinite(displayValue)) {
        missingEdges++;
        continue;
      }
      const normalizedValue = Math.max(0, Math.min(1, displayValue));
      if (normalizedValue < threshold) continue;
      edges.push({
        id: networkEdgeId('social', edge.fromId, edge.toId),
        from, to, fromId: edge.fromId, toId: edge.toId,
        weight: 1 + normalizedValue * 10,
        strength: Math.max(0, Math.min(1, edge.strength)),
        displayValue: normalizedValue,
        recentChange: edge.recentChange,
        valence: edge.valence,
        evidenceCount: directedObservationCount(edge, lens),
        tieType: edge.tieType,
        directed: true,
        level: 'directed',
        relationshipStateObserved: edge.relationshipStateObserved !== false,
      });
    }
  } else {
    const maxChoiceCount = Math.max(1, ...pairs.map((item) => Math.max(0, item.count)));
    for (const pair of pairs) {
      const edge = parsePair(pair.pair, pair.count, n);
      if (!edge) continue;
      const fromId = agents[edge.from].id;
      const toId = agents[edge.to].id;
      if (egoId && fromId !== egoId && toId !== egoId) continue;
      totalEdges++;
      const normalizedValue = edge.count / maxChoiceCount;
      if (normalizedValue < threshold) continue;
      edges.push({
        id: networkEdgeId('choice', fromId, toId),
        from: edge.from, to: edge.to, fromId, toId, weight: edge.count,
        strength: normalizedValue, displayValue: edge.count, recentChange: 0,
        valence: 0, evidenceCount: edge.count, tieType: 'choice',
        directed: true,
        level: 'directed',
        relationshipStateObserved: null,
      });
    }
  }
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
  const directed = new Set(edges.filter((edge) => edge.directed).map((edge) => `${edge.from}:${edge.to}`));
  const undirected = new Map<string, number>();
  for (const edge of edges) {
    const key = edge.from < edge.to ? `${edge.from}:${edge.to}` : `${edge.to}:${edge.from}`;
    undirected.set(key, (undirected.get(key) ?? 0) + edge.weight);
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
      const topBoundary = h >= 230 ? 82 : 42;
      p.y = Math.max(topBoundary, Math.min(h - 48, p.y));
    }
  }

  const selectedIndex = agents.findIndex((agent) => agent.id === selectedId);
  const hoveredIndex = agents.findIndex((agent) => agent.id === hoveredId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const edgeLayouts: NetworkEdgeLayout[] = [];
  ctx.lineCap = 'round';
  for (const edge of edges) {
    const from = positions[edge.from];
    const to = positions[edge.to];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / distance;
    const uy = dy / distance;
    const hasReverse = edge.directed && directed.has(`${edge.to}:${edge.from}`);
    // 每个方向都沿自身法线取同一侧；反向边的法线自然翻转，因此得到两条平行边。
    const side = hasReverse ? 1 : 0;
    const ox = -uy * side * 9;
    const oy = ux * side * 9;
    const startX = from.x + ux * 27 + ox;
    const startY = from.y + uy * 27 + oy;
    const endX = to.x - ux * 29 + ox;
    const endY = to.y - uy * 29 + oy;
    const ego = selectedIndex < 0 || edge.from === selectedIndex || edge.to === selectedIndex;
    const hover = hoveredIndex < 0 || edge.from === hoveredIndex || edge.to === hoveredIndex;
    const isSelected = edge.id === selectedEdgeId;
    const isHovered = edge.id === hoveredEdgeId;
    const isReverse = Boolean(selectedEdge && selectedEdge.fromId === edge.toId && selectedEdge.toId === edge.fromId);
    const focus = ego && hover;
    const visualValue = mode === 'choice' ? edge.strength : edge.displayValue;
    const baseWidth = 1.3 + visualValue * 5.4;
    const lineWidth = isSelected ? baseWidth + 2.6 : isHovered ? baseWidth + 1.6 : isReverse ? baseWidth + .7 : focus ? baseWidth : 1;
    const alpha = isSelected ? 1 : isHovered ? .96 : isReverse ? .72 : focus ? Math.min(.92, .28 + visualValue * .62) : .09;
    const rgb = mode === 'choice' ? '119,184,255' : socialEdgeRgb(edge, lens);
    const behaviorOnly = mode === 'social' && edge.relationshipStateObserved === false;
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash(behaviorOnly ? [5, 4] : []);
    if (isSelected) {
      ctx.strokeStyle = 'rgba(255,255,255,.92)';
      ctx.lineWidth = lineWidth + 3;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
    }
    ctx.strokeStyle = `rgba(${rgb},${alpha})`;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    if (edge.directed) {
      const arrow = 7;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(endX, endY);
      ctx.lineTo(endX - ux * arrow - uy * arrow * .55, endY - uy * arrow + ux * arrow * .55);
      ctx.lineTo(endX - ux * arrow + uy * arrow * .55, endY - uy * arrow - ux * arrow * .55);
      ctx.closePath();
      ctx.fill();
    }
    edgeLayouts.push({
      id: edge.id,
      mode,
      fromId: edge.fromId,
      toId: edge.toId,
      startX, startY, endX, endY,
      hitWidth: Math.max(7, lineWidth / 2 + 4),
      lineWidth,
      displayValue: edge.displayValue,
      evidenceCount: edge.evidenceCount,
      directed: edge.directed,
      level: edge.level,
      relationshipStateObserved: edge.relationshipStateObserved,
    });
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    if (mode === 'social' && lens === 'overall' && (isSelected || isHovered) && Math.abs(edge.recentChange) >= 0.01) {
      ctx.fillStyle = edge.recentChange > 0 ? '#7dd7a0' : '#f58f8f';
      ctx.font = '700 11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      const change = `${edge.recentChange > 0 ? '+' : ''}${edge.recentChange.toFixed(2)}`;
      ctx.fillText(change, (startX + endX) / 2, (startY + endY) / 2 - 7);
    }
  }

  const nodes: NetworkNodeLayout[] = [];
  for (let i = 0; i < n; i++) {
    const agent = agents[i];
    const p = positions[i];
    const selected = agent.id === selectedId;
    const hovered = agent.id === hoveredId;
    const pulse = agent.state === 'acting' ? Math.sin(nowMs / 300) * 1.5 : 0;
    const radius = (selected ? 26 : hovered ? 25 : 23) + pulse;
    const actorValue = actorValues.get(agent.id) ?? null;
    const showActorValue = actorValueVisible.has(agent.id);
    if (lensLevel === 'actor' && showActorValue && actorValue !== null) {
      ctx.strokeStyle = `rgba(242,198,109,${Math.min(.98, .48 + actorValue * .5)})`;
      ctx.lineWidth = 2 + actorValue * 5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 7, 0, Math.PI * 2);
      ctx.stroke();
    }
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
    nodes.push({
      agentId: agent.id,
      x: p.x,
      y: p.y,
      radius: Math.max(23, radius),
      actorValue,
      actorValueVisible: showActorValue,
    });
  }
  ctx.textAlign = 'left';
  return lensLevel === 'actor'
    ? {
      nodes,
      edges: edgeLayouts,
      totalEdges,
      missingEdges,
      countUnit: 'actor',
      totalActors,
      visibleActors,
      missingActors,
    }
    : { nodes, edges: edgeLayouts, totalEdges, missingEdges, countUnit: 'edge' };
}

function metricAvailabilityText(availability: MetricAvailability): string {
  if (availability.state === 'no_observations') {
    return availability.requiredConsecutiveChoiceDays > 2
      ? `尚无伙伴选择观测；需要连续 ${availability.requiredConsecutiveChoiceDays} 个选择日（两个完整 7 日窗口）后开始估计。`
      : availability.requiredConsecutiveChoiceDays === 2
        ? '尚无伙伴选择观测；需要连续 2 个选择日后开始估计。'
        : '尚无伙伴选择观测；完成首轮选择后开始估计。';
  }
  if (availability.state === 'awaiting_adjacent_days') {
    return `需要连续 2 个选择日；目前最长连续 ${availability.longestConsecutiveChoiceDays} 日。`;
  }
  if (availability.state === 'awaiting_window') {
    return `需要连续 ${availability.requiredConsecutiveChoiceDays} 个选择日（两个完整 7 日窗口）；目前最长连续 ${availability.longestConsecutiveChoiceDays} 日，累计记录 ${availability.observedChoiceDays} 个选择日。`;
  }
  return `共 ${availability.observedPoints} 个有效观测点。`;
}

/** 当前指标的文本等价描述，供 canvas 辅助说明和研究者核对。 */
export function metricStatusText(metrics: MetricsPayload, key: MetricKey): string {
  const spec = METRIC_DEFINITIONS.find((item) => item.key === key) ?? METRIC_DEFINITIONS[0];
  const data = metrics[spec.key];
  const latest = data.at(-1);
  const value = latest === undefined ? '' : ` 当前值 ${latest.toFixed(3)}。`;
  return `${spec.label}。${spec.description}。${value}${metricAvailabilityText(metrics.availability[spec.key])}`;
}

/** 单指标主图；指标切换由 DOM tabs 驱动，保证在窄视窗中仍可阅读。 */
export function drawMetrics(ctx: CanvasRenderingContext2D, metrics: MetricsPayload, w: number, h: number, key: MetricKey = 'repeat'): void {
  const spec = METRIC_DEFINITIONS.find((item) => item.key === key) ?? METRIC_DEFINITIONS[0];
  const data = metrics[spec.key];
  const dataDays = metrics.seriesDays[spec.key]?.length === data.length
    ? metrics.seriesDays[spec.key]
    : data.map((_, index) => index + 1);
  const referenceData = spec.reference?.series ? metrics[spec.reference.series] : [];
  const referenceDays = spec.reference?.series === 'recipBaseline'
    ? metrics.seriesDays.recipRate
    : [];
  ctx.fillStyle = '#09111d';
  ctx.fillRect(0, 0, w, h);

  const latest = data.at(-1);
  ctx.fillStyle = spec.color;
  ctx.font = '600 14px "Microsoft YaHei UI", sans-serif';
  ctx.fillText(spec.label, 18, 72);
  ctx.font = '700 24px ui-monospace, monospace';
  ctx.fillText(latest === undefined ? '—' : latest.toFixed(3), 18, 101);
  ctx.fillStyle = '#9cafc4';
  ctx.font = '12px "Microsoft YaHei UI", sans-serif';
  ctx.fillText(spec.description, 18, 122, Math.max(80, w - 36));

  const left = 54;
  const right = 24;
  const top = 142;
  const bottom = 31;
  const chartW = Math.max(20, w - left - right);
  const chartH = Math.max(20, h - top - bottom);
  const observedMax = Math.max(0, ...data, ...referenceData, spec.reference?.value ?? 0);
  const max = spec.fixedMax ?? Math.max(1, Math.ceil(observedMax * 10) / 10);
  const span = Math.max(Number.EPSILON, max - spec.min);
  const scaleY = (value: number) => top + chartH - ((Math.max(spec.min, Math.min(max, value)) - spec.min) / span) * chartH;
  const allDays = [...dataDays, ...referenceDays];
  const firstDay = allDays.length ? Math.min(...allDays) : 1;
  const lastDay = allDays.length ? Math.max(...allDays) : firstDay;
  const scaleX = (day: number) => firstDay === lastDay
    ? left + chartW / 2
    : left + (chartW * (day - firstDay)) / (lastDay - firstDay);

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
    const availability = metrics.availability[spec.key];
    const primary = availability.requiredConsecutiveChoiceDays > 2
      ? `需连续 ${availability.requiredConsecutiveChoiceDays} 个选择日后估计`
      : availability.requiredConsecutiveChoiceDays === 2
        ? '需连续 2 个选择日后估计'
        : '完成伙伴选择后开始估计';
    ctx.fillText(primary, left + chartW / 2, top + chartH / 2 - 8);
    ctx.font = '12px "Microsoft YaHei UI", sans-serif';
    ctx.fillText(
      `已记录 ${availability.observedChoiceDays} 日 · 最长连续 ${availability.longestConsecutiveChoiceDays} 日`,
      left + chartW / 2,
      top + chartH / 2 + 16,
    );
    ctx.textAlign = 'left';
    return;
  }

  const drawSeries = (values: number[], days: number[], color: string, width: number, dashed: boolean): void => {
    if (!values.length || values.length !== days.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash?.(dashed ? [6, 5] : []);
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = scaleX(days[index]);
      const y = scaleY(value);
      if (index === 0 || days[index] !== days[index - 1] + 1) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash?.([]);
  };

  if (spec.reference?.value !== undefined && spec.reference.value >= spec.min && spec.reference.value <= max) {
    ctx.strokeStyle = 'rgba(183,201,221,.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash?.([6, 5]);
    ctx.beginPath();
    ctx.moveTo(left, scaleY(spec.reference.value));
    ctx.lineTo(left + chartW, scaleY(spec.reference.value));
    ctx.stroke();
    ctx.setLineDash?.([]);
  } else if (referenceData.length === referenceDays.length) {
    drawSeries(referenceData, referenceDays, 'rgba(183,201,221,.62)', 1.5, true);
  }

  drawSeries(data, dataDays, spec.color, 2.5, false);
  if (typeof ctx.arc === 'function') {
    ctx.fillStyle = spec.color;
    data.forEach((value, index) => {
      ctx.beginPath();
      ctx.arc(scaleX(dataDays[index]), scaleY(value), 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  if (spec.reference) {
    ctx.fillStyle = '#a8b8ca';
    ctx.font = '11px "Microsoft YaHei UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`虚线：${spec.reference.label}`, left + chartW, top + 14);
  }
  ctx.fillStyle = '#9cafc4';
  ctx.font = '11px "Microsoft YaHei UI", sans-serif';
  if (firstDay === lastDay) {
    ctx.textAlign = 'center';
    ctx.fillText(`第 ${firstDay} 天 · ${data.length} 个有效点`, left + chartW / 2, h - 9);
  } else {
    ctx.textAlign = 'left';
    ctx.fillText(`第 ${firstDay} 天`, left, h - 9);
    ctx.textAlign = 'right';
    ctx.fillText(`第 ${lastDay} 天 · ${data.length} 个有效点`, left + chartW, h - 9);
  }
  ctx.textAlign = 'left';
}

const METRIC_KEYS = METRIC_DEFINITIONS.map((definition) => definition.key);

function normalizeMetricPayload(result: Partial<MetricsPayload>): MetricsPayload {
  const series = (key: MetricKey): number[] => {
    const value = result[key];
    return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : [];
  };
  const repeat = series('repeat');
  const recipRate = series('recipRate');
  const recip = series('recip');
  const clus = series('clus');
  const div = series('div');
  const hhi = series('hhi');
  const persistence = series('persistence');
  const hub = series('hub');
  const values: Record<MetricKey, number[]> = { repeat, recipRate, recip, clus, div, hhi, persistence, hub };
  const seriesDays = {} as MetricSeriesDays;
  for (const key of METRIC_KEYS) {
    const candidate = result.seriesDays?.[key];
    seriesDays[key] = Array.isArray(candidate) && candidate.length === values[key].length
      ? candidate.map((day) => Number(day)).filter((day) => Number.isFinite(day))
      : values[key].map((_, index) => index + 1);
    if (seriesDays[key].length !== values[key].length) seriesDays[key] = values[key].map((_, index) => index + 1);
  }
  const observedChoiceDays = Math.max(0, ...METRIC_KEYS.map((key) => result.availability?.[key]?.observedChoiceDays ?? seriesDays[key].length));
  const availability = {} as MetricAvailabilityMap;
  for (const key of METRIC_KEYS) {
    const supplied = result.availability?.[key];
    const required = key === 'persistence' ? 14 : key === 'repeat' || key === 'recipRate' || key === 'recip' ? 2 : 1;
    availability[key] = supplied ?? {
      state: values[key].length > 0 ? 'ready' : observedChoiceDays === 0 ? 'no_observations' : required > 2 ? 'awaiting_window' : 'awaiting_adjacent_days',
      observedPoints: values[key].length,
      observedChoiceDays,
      longestConsecutiveChoiceDays: observedChoiceDays,
      requiredConsecutiveChoiceDays: required,
    };
  }
  const recipBaseline = Array.isArray(result.recipBaseline)
    ? result.recipBaseline.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    : [];
  const pairs = Array.isArray(result.pairs)
    ? result.pairs.filter((item): item is { pair: string; count: number } => (
      typeof item?.pair === 'string' && typeof item.count === 'number' && Number.isFinite(item.count)
    ))
    : [];
  return { ...values, recipBaseline, seriesDays, availability, pairs };
}

export function emptyMetricsPayload(): MetricsPayload {
  return normalizeMetricPayload({});
}

/** 拉取当前平行世界的实验指标。 */
export async function fetchMetrics(worldId?: string, signal?: AbortSignal): Promise<MetricsPayload> {
  const query = worldId ? `?worldId=${encodeURIComponent(worldId)}` : '';
  const res = await fetch(`/api/experiment/metrics${query}`, { signal });
  if (!res.ok) throw new Error(`metrics unavailable (${res.status})`);
  const result = (await res.json()) as Partial<MetricsPayload> & { worldId?: string };
  if (worldId && result.worldId && result.worldId !== worldId) throw new Error('metrics world mismatch');
  return normalizeMetricPayload(result);
}

/** 拉取只读社会关系投影；该结果不参与实验处理或 agent 决策。 */
export async function fetchSocialNetwork(
  worldId: string,
  windowDays: number | null = 7,
  signal?: AbortSignal,
): Promise<SocialNetworkPayload> {
  const window = windowDays === null ? 'all' : String(windowDays);
  const res = await fetch(
    `/api/relationships?worldId=${encodeURIComponent(worldId)}&windowDays=${encodeURIComponent(window)}`,
    { signal },
  );
  if (!res.ok) throw new Error(`relationships unavailable (${res.status})`);
  const result = (await res.json()) as SocialNetworkPayload;
  if (result.worldId !== worldId) throw new Error('relationships world mismatch');
  return {
    worldId: result.worldId,
    modelVersion: result.modelVersion,
    generatedGameTime: result.generatedGameTime,
    window: result.window,
    proxyNotice: result.proxyNotice,
    measureSchema: result.measureSchema ?? [],
    dataQuality: result.dataQuality ?? [],
    observationSummary: result.observationSummary ?? { relationshipEvidence: 0, partnerChoices: 0 },
    directions: result.directions ?? [],
    dyads: result.dyads ?? [],
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
