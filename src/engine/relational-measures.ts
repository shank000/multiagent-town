// “互动 → 关系 → 结构”6+4 只读测量层。
// 所有输出均为描述性观察量或代理，不写回 agent 心智、关系状态或实验处理。

import type { Relationship, RelationshipEvidence } from '../store/relationships';

export const DEFAULT_RELATION_WINDOW_DAYS = 7;
const DAY = 1440;
const RECENCY_HALF_LIFE = 7 * DAY;
const CORE_CHANNELS = ['communication', 'resource_exchange', 'shared_activity', 'partner_choice'] as const;

export type RelationalMeasureKey =
  | 'partnerReturn'
  | 'tiePersistence'
  | 'recencyEffect'
  | 'reciprocity'
  | 'relationalCarryOver'
  | 'partnerConcentration'
  | 'interactionIntensity'
  | 'multiplexity'
  | 'dependenceAsymmetry'
  | 'embeddedness';

export interface RelationalMeasureDefinition {
  key: RelationalMeasureKey;
  label: string;
  shortLabel: string;
  family: 'existing-six' | 'added-four';
  level: 'directed' | 'dyad' | 'actor';
  source: 'partner_choice' | 'relationship_evidence' | 'mixed' | 'network_topology';
  description: string;
  caveat: string;
}

/** 两份研究文档提出的六项既有测量与四项新增测量。 */
export const RELATIONAL_MEASURE_SCHEMA: readonly RelationalMeasureDefinition[] = [
  {
    key: 'partnerReturn', label: '伙伴回返', shortLabel: '回返', family: 'existing-six', level: 'directed',
    source: 'partner_choice', description: '选择某伙伴后，下一次可观测选择仍返回该伙伴的比例。',
    caveat: '描述选择连续性，不单独证明关系已经形成。',
  },
  {
    key: 'tiePersistence', label: '关系持续性', shortLabel: '持续', family: 'existing-six', level: 'directed',
    source: 'partner_choice', description: '相邻等长观察窗中同一有向选择边计数的重叠程度。',
    caveat: '无可比较选择时返回缺失，不以零代替。',
  },
  {
    key: 'recencyEffect', label: '近因效应（暴露代理）', shortLabel: '近因', family: 'existing-six', level: 'directed',
    source: 'mixed', description: '距离最近一次关系证据或伙伴选择的时间衰减值。',
    caveat: '这是近因暴露，不是近期互动影响后续选择的因果效应估计。',
  },
  {
    key: 'reciprocity', label: '互惠交换', shortLabel: '互惠', family: 'existing-six', level: 'dyad',
    source: 'mixed', description: '观察窗内两个方向的选择计数或关系证据计数之平衡程度。',
    caveat: '机械双向写入会提高该描述量，必须结合来源审查。',
  },
  {
    key: 'relationalCarryOver', label: '关系延续效应', shortLabel: '延续', family: 'existing-six', level: 'directed',
    source: 'partner_choice', description: '首次选择该伙伴后，后续选择仍投向该伙伴的比例。',
    caveat: '这是行为延续描述量，不替代正式历史效应模型。',
  },
  {
    key: 'partnerConcentration', label: '伙伴集中度', shortLabel: '集中', family: 'existing-six', level: 'actor',
    source: 'partner_choice', description: '行动者在观察窗内伙伴选择份额的 HHI。',
    caveat: '这是行动者组合指标；显示在边上仅说明该边所处的选择组合。',
  },
  {
    key: 'interactionIntensity', label: '互动强度', shortLabel: '强度', family: 'added-four', level: 'directed',
    source: 'relationship_evidence', description: '观察窗内关系更新证据的去重事件数及每周化强度。',
    caveat: '当前证据不覆盖全部接触或全部对话轮次。',
  },
  {
    key: 'multiplexity', label: '关系多重性', shortLabel: '多重', family: 'added-four', level: 'directed',
    source: 'mixed', description: '沟通、资源交换、共同活动与伙伴选择等可观测渠道的多样性。',
    caveat: '渠道由事件类型操作化；馈礼是实验处理后的描述量。',
  },
  {
    key: 'dependenceAsymmetry', label: '依赖不对称', shortLabel: '依赖差', family: 'added-four', level: 'dyad',
    source: 'partner_choice', description: '双方将自身有效选择投向对方的份额差。',
    caveat: '这是伙伴选择依赖代理，不等同于心理依赖、权力或支配关系。',
  },
  {
    key: 'embeddedness', label: '网络嵌入性', shortLabel: '嵌入', family: 'added-four', level: 'dyad',
    source: 'network_topology', description: '观察窗互动网络中双方共同邻居占邻居并集的比例。',
    caveat: '结果依赖网络层、时间窗与事件覆盖。',
  },
] as const;

export type MeasureBasis =
  | 'partner_choice'
  | 'relationship_evidence'
  | 'mixed'
  | 'network_topology'
  | 'none';

export interface RelationalMeasureValue {
  /** 图形编码值；0..1。没有可识别观察时为 null。 */
  value: number | null;
  observed: boolean;
  numerator: number | null;
  denominator: number | null;
  basis: MeasureBasis;
}

export interface DirectedRelationalMeasures {
  partnerReturn: RelationalMeasureValue;
  tiePersistence: RelationalMeasureValue;
  recencyEffect: RelationalMeasureValue;
  relationalCarryOver: RelationalMeasureValue;
  partnerConcentration: RelationalMeasureValue;
  interactionIntensity: RelationalMeasureValue;
  multiplexity: RelationalMeasureValue;
  /** 依赖不对称的有向组成：A 的有效选择中投向 B 的份额。 */
  partnerDependence: RelationalMeasureValue;
  channels: string[];
  interactionEventCount: number;
  choiceCount: number;
}

export interface DyadRelationalMeasures {
  reciprocity: RelationalMeasureValue;
  dependenceAsymmetry: RelationalMeasureValue;
  embeddedness: RelationalMeasureValue;
  commonNeighborCount: number;
  unionNeighborCount: number;
}

export interface PartnerChoiceObservation {
  fromId: string;
  toId: string;
  gameTime: number;
  eventId?: string;
}

export interface RelationalMeasurementOptions {
  windowDays?: number | null;
  choices?: readonly PartnerChoiceObservation[];
}

export interface RelationalMeasurementProjection {
  window: { days: number | null; startGameTime: number; endGameTime: number; label: string };
  measureSchema: readonly RelationalMeasureDefinition[];
  dataQuality: string[];
  observationSummary: { relationshipEvidence: number; partnerChoices: number };
  directed: ReadonlyMap<string, DirectedRelationalMeasures>;
  dyads: ReadonlyMap<string, DyadRelationalMeasures>;
  observedDyads: readonly [string, string][];
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const rounded = (value: number) => Math.round(value * 10_000) / 10_000;
export const relationDirectionKey = (a: string, b: string) => `${a}\u0000${b}`;
export const relationDyadKey = (a: string, b: string) => a < b
  ? relationDirectionKey(a, b)
  : relationDirectionKey(b, a);

export function missingMeasure(basis: MeasureBasis = 'none'): RelationalMeasureValue {
  return { value: null, observed: false, numerator: null, denominator: null, basis };
}

function measured(
  value: number,
  numerator: number | null,
  denominator: number | null,
  basis: MeasureBasis,
): RelationalMeasureValue {
  return { value: rounded(clamp(value, 0, 1)), observed: true, numerator, denominator, basis };
}

export function emptyDirectedRelationalMeasures(): DirectedRelationalMeasures {
  return {
    partnerReturn: missingMeasure('partner_choice'),
    tiePersistence: missingMeasure('partner_choice'),
    recencyEffect: missingMeasure(),
    relationalCarryOver: missingMeasure('partner_choice'),
    partnerConcentration: missingMeasure('partner_choice'),
    interactionIntensity: missingMeasure('relationship_evidence'),
    multiplexity: missingMeasure('relationship_evidence'),
    partnerDependence: missingMeasure('partner_choice'),
    channels: [], interactionEventCount: 0, choiceCount: 0,
  };
}

export function emptyDyadRelationalMeasures(): DyadRelationalMeasures {
  return {
    reciprocity: missingMeasure(),
    dependenceAsymmetry: missingMeasure('partner_choice'),
    embeddedness: missingMeasure('network_topology'),
    commonNeighborCount: 0,
    unionNeighborCount: 0,
  };
}

function evidenceChannel(item: RelationshipEvidence): string {
  if (item.sourceKind === 'dialogue') return 'communication';
  if (item.sourceKind === 'gift_sent' || item.sourceKind === 'gift_received') return 'resource_exchange';
  if (item.sourceKind === 'shared_activity') return 'shared_activity';
  if (item.sourceKind === 'assistance' || item.sourceKind === 'collaboration') return 'shared_activity';
  if (item.sourceKind === 'information_share' || item.sourceKind === 'invitation') return 'communication';
  if (item.sourceKind === 'observation') return 'attention';
  return 'other';
}

function uniqueEvidence(items: readonly RelationshipEvidence[]): RelationshipEvidence[] {
  const seen = new Set<string>();
  const result: RelationshipEvidence[] = [];
  for (const item of items) {
    const key = item.sourceEventId ? `event:${item.sourceEventId}` : `evidence:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function countDirections<T extends { fromId: string; toId: string }>(items: readonly T[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of items) {
    const key = relationDirectionKey(item.fromId, item.toId);
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function addUndirected(adjacency: Map<string, Set<string>>, a: string, b: string): void {
  if (!a || !b || a === b) return;
  const aNeighbors = adjacency.get(a) ?? new Set<string>();
  const bNeighbors = adjacency.get(b) ?? new Set<string>();
  aNeighbors.add(b);
  bNeighbors.add(a);
  adjacency.set(a, aNeighbors);
  adjacency.set(b, bNeighbors);
}

function sanitizeWindowDays(value: number | null | undefined): number | null {
  if (value === null) return null;
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_RELATION_WINDOW_DAYS;
  return Math.max(1, Math.min(3650, Math.floor(value)));
}

/** 计算 6+4 观察量；相同输入始终得到相同输出。 */
export function computeRelationalMeasurements(
  relationships: readonly Relationship[],
  evidence: readonly RelationshipEvidence[],
  now: number,
  options: RelationalMeasurementOptions = {},
): RelationalMeasurementProjection {
  const safeNow = Number.isFinite(now) ? Math.max(0, Math.floor(now)) : 0;
  const windowDays = sanitizeWindowDays(options.windowDays);
  const windowMinutes = windowDays === null ? safeNow + 1 : windowDays * DAY;
  const windowStart = windowDays === null ? 0 : Math.max(0, safeNow - windowMinutes + 1);
  const previousWindowStart = Math.max(0, windowStart - windowMinutes);
  const observedDays = Math.max(1 / DAY, (safeNow - windowStart + 1) / DAY);

  const pastEvidence = evidence
    .filter((item) => item.gameTime <= safeNow)
    .slice()
    .sort((left, right) => right.gameTime - left.gameTime || right.id.localeCompare(left.id));
  const windowEvidence = pastEvidence.filter((item) => item.gameTime >= windowStart);
  const pastChoices = (options.choices ?? [])
    .filter((item) => item.fromId && item.toId && item.fromId !== item.toId && item.gameTime <= safeNow)
    .slice()
    .sort((left, right) => left.gameTime - right.gameTime || (left.eventId ?? '').localeCompare(right.eventId ?? ''));
  const windowChoices = pastChoices.filter((item) => item.gameTime >= windowStart);
  const previousChoices = pastChoices.filter((item) => item.gameTime >= previousWindowStart && item.gameTime < windowStart);

  const evidenceWindowByDirection = new Map<string, RelationshipEvidence[]>();
  for (const item of pastEvidence) {
    const key = relationDirectionKey(item.agentA, item.agentB);
    if (item.gameTime >= windowStart) {
      const current = evidenceWindowByDirection.get(key) ?? [];
      current.push(item);
      evidenceWindowByDirection.set(key, current);
    }
  }
  const choicesWindowByFrom = new Map<string, PartnerChoiceObservation[]>();
  for (const item of windowChoices) {
    const current = choicesWindowByFrom.get(item.fromId) ?? [];
    current.push(item);
    choicesWindowByFrom.set(item.fromId, current);
  }
  const choiceCountCurrent = countDirections(windowChoices);
  const choiceCountPrevious = countDirections(previousChoices);

  const directionIds = new Map<string, [string, string]>();
  const dyadIds = new Map<string, [string, string]>();
  const register = (a: string, b: string) => {
    if (!a || !b || a === b) return;
    directionIds.set(relationDirectionKey(a, b), [a, b]);
    const left = a < b ? a : b;
    const right = a < b ? b : a;
    dyadIds.set(relationDyadKey(left, right), [left, right]);
  };
  for (const item of relationships) register(item.agentA, item.agentB);
  for (const item of pastEvidence) register(item.agentA, item.agentB);
  for (const item of pastChoices) register(item.fromId, item.toId);
  // 依赖份额的结构零仍是可观测值：只要行动者在当前窗有选择分母，
  // 就为每个已观察 dyad 建立对应方向，即使该方向的配对计数为零。
  for (const [a, b] of dyadIds.values()) {
    if ((choicesWindowByFrom.get(a)?.length ?? 0) > 0) {
      directionIds.set(relationDirectionKey(a, b), [a, b]);
    }
    if ((choicesWindowByFrom.get(b)?.length ?? 0) > 0) {
      directionIds.set(relationDirectionKey(b, a), [b, a]);
    }
  }

  const directed = new Map<string, DirectedRelationalMeasures>();
  for (const [key, [fromId, toId]] of directionIds) {
    const currentChoices = choicesWindowByFrom.get(fromId) ?? [];
    const pairChoices = currentChoices.filter((item) => item.toId === toId);
    let returnNumerator = 0;
    let returnDenominator = 0;
    for (let index = 0; index + 1 < currentChoices.length; index++) {
      if (currentChoices[index].toId !== toId) continue;
      returnDenominator++;
      if (currentChoices[index + 1].toId === toId) returnNumerator++;
    }
    const partnerReturn = returnDenominator > 0
      ? measured(returnNumerator / returnDenominator, returnNumerator, returnDenominator, 'partner_choice')
      : missingMeasure('partner_choice');

    const currentCount = choiceCountCurrent.get(key) ?? 0;
    const previousCount = choiceCountPrevious.get(key) ?? 0;
    const persistenceDenominator = Math.max(currentCount, previousCount);
    const hasCompletePreviousWindow = windowDays !== null && windowStart >= windowMinutes;
    const tiePersistence = hasCompletePreviousWindow && persistenceDenominator > 0
      ? measured(Math.min(currentCount, previousCount) / persistenceDenominator, Math.min(currentCount, previousCount), persistenceDenominator, 'partner_choice')
      : missingMeasure('partner_choice');

    const currentDirectionEvidence = evidenceWindowByDirection.get(key) ?? [];
    const lastEvidence = currentDirectionEvidence[0]?.gameTime;
    const lastChoice = pairChoices.at(-1)?.gameTime;
    const lastObserved = Math.max(lastEvidence ?? -1, lastChoice ?? -1);
    const recencyBasis: MeasureBasis = lastEvidence !== undefined && lastChoice !== undefined
      ? 'mixed'
      : lastChoice !== undefined ? 'partner_choice' : lastEvidence !== undefined ? 'relationship_evidence' : 'none';
    const recencyEffect = lastObserved >= 0
      ? measured(Math.pow(0.5, Math.max(0, safeNow - lastObserved) / RECENCY_HALF_LIFE), Math.max(0, safeNow - lastObserved), RECENCY_HALF_LIFE, recencyBasis)
      : missingMeasure();

    const firstPairChoiceIndex = currentChoices.findIndex((item) => item.toId === toId);
    const laterChoices = firstPairChoiceIndex >= 0 ? currentChoices.slice(firstPairChoiceIndex + 1) : [];
    const laterPairChoices = laterChoices.filter((item) => item.toId === toId).length;
    const relationalCarryOver = laterChoices.length > 0
      ? measured(laterPairChoices / laterChoices.length, laterPairChoices, laterChoices.length, 'partner_choice')
      : missingMeasure('partner_choice');

    let partnerConcentration = missingMeasure('partner_choice');
    if (currentChoices.length > 0) {
      const counts = new Map<string, number>();
      for (const item of currentChoices) counts.set(item.toId, (counts.get(item.toId) ?? 0) + 1);
      const hhi = [...counts.values()].reduce((sum, count) => sum + (count / currentChoices.length) ** 2, 0);
      partnerConcentration = measured(hhi, null, currentChoices.length, 'partner_choice');
    }

    const currentEvidence = uniqueEvidence(evidenceWindowByDirection.get(key) ?? []);
    const weeklyRate = (currentEvidence.length / observedDays) * 7;
    const interactionIntensity = currentEvidence.length > 0
      ? measured(1 - Math.exp(-weeklyRate / 4), currentEvidence.length, rounded(observedDays), 'relationship_evidence')
      : missingMeasure('relationship_evidence');
    const observedChannels = new Set(currentEvidence.map(evidenceChannel));
    if (pairChoices.length > 0) observedChannels.add('partner_choice');
    const channels = [...observedChannels].sort();
    const recognizedChannels = channels.filter((channel) => (CORE_CHANNELS as readonly string[]).includes(channel));
    const multiplexityBasis: MeasureBasis = currentEvidence.length > 0 && pairChoices.length > 0
      ? 'mixed'
      : pairChoices.length > 0 ? 'partner_choice' : 'relationship_evidence';
    const multiplexity = recognizedChannels.length > 0
      ? measured(recognizedChannels.length / CORE_CHANNELS.length, recognizedChannels.length, CORE_CHANNELS.length, multiplexityBasis)
      : missingMeasure(multiplexityBasis);
    const partnerDependence = currentChoices.length > 0
      ? measured(pairChoices.length / currentChoices.length, pairChoices.length, currentChoices.length, 'partner_choice')
      : missingMeasure('partner_choice');

    directed.set(key, {
      partnerReturn, tiePersistence, recencyEffect, relationalCarryOver, partnerConcentration,
      interactionIntensity, multiplexity, partnerDependence, channels,
      interactionEventCount: currentEvidence.length, choiceCount: pairChoices.length,
    });
  }

  const adjacency = new Map<string, Set<string>>();
  const topologySources = new Map<string, Set<'partner_choice' | 'relationship_evidence'>>();
  const addTopologyEdge = (
    a: string,
    b: string,
    source: 'partner_choice' | 'relationship_evidence',
  ) => {
    addUndirected(adjacency, a, b);
    if (!a || !b || a === b) return;
    const key = relationDyadKey(a, b);
    const sources = topologySources.get(key) ?? new Set<'partner_choice' | 'relationship_evidence'>();
    sources.add(source);
    topologySources.set(key, sources);
  };
  for (const item of windowEvidence) addTopologyEdge(item.agentA, item.agentB, 'relationship_evidence');
  for (const item of windowChoices) addTopologyEdge(item.fromId, item.toId, 'partner_choice');
  const evidenceCountWindow = new Map<string, number>();
  for (const [key, items] of evidenceWindowByDirection) evidenceCountWindow.set(key, uniqueEvidence(items).length);

  const dyads = new Map<string, DyadRelationalMeasures>();
  for (const [key, [a, b]] of dyadIds) {
    const choiceAB = choiceCountCurrent.get(relationDirectionKey(a, b)) ?? 0;
    const choiceBA = choiceCountCurrent.get(relationDirectionKey(b, a)) ?? 0;
    const evidenceAB = evidenceCountWindow.get(relationDirectionKey(a, b)) ?? 0;
    const evidenceBA = evidenceCountWindow.get(relationDirectionKey(b, a)) ?? 0;
    const useChoices = choiceAB + choiceBA > 0;
    const reciprocalA = useChoices ? choiceAB : evidenceAB;
    const reciprocalB = useChoices ? choiceBA : evidenceBA;
    const reciprocalDenominator = Math.max(reciprocalA, reciprocalB);
    const reciprocity = reciprocalDenominator > 0
      ? measured(Math.min(reciprocalA, reciprocalB) / reciprocalDenominator, Math.min(reciprocalA, reciprocalB), reciprocalDenominator, useChoices ? 'partner_choice' : 'relationship_evidence')
      : missingMeasure(useChoices ? 'partner_choice' : 'relationship_evidence');

    const totalChoicesA = choicesWindowByFrom.get(a)?.length ?? 0;
    const totalChoicesB = choicesWindowByFrom.get(b)?.length ?? 0;
    const dependencyA = totalChoicesA > 0 ? choiceAB / totalChoicesA : null;
    const dependencyB = totalChoicesB > 0 ? choiceBA / totalChoicesB : null;
    const dependencyDifference = dependencyA !== null && dependencyB !== null
      ? Math.abs(dependencyA - dependencyB)
      : null;
    const dependenceAsymmetry = dependencyDifference !== null
      ? measured(dependencyDifference, dependencyDifference, 1, 'partner_choice')
      : missingMeasure('partner_choice');

    const aNeighbors = new Set(adjacency.get(a) ?? []);
    const bNeighbors = new Set(adjacency.get(b) ?? []);
    const hasObservedTie = aNeighbors.has(b) || bNeighbors.has(a);
    const focalSources = new Set<'partner_choice' | 'relationship_evidence'>();
    for (const [node, neighbors] of [[a, aNeighbors], [b, bNeighbors]] as const) {
      for (const neighbor of neighbors) {
        for (const source of topologySources.get(relationDyadKey(node, neighbor)) ?? []) {
          focalSources.add(source);
        }
      }
    }
    const topologyBasis: MeasureBasis = focalSources.size > 1
      ? 'mixed'
      : focalSources.has('partner_choice')
        ? 'partner_choice'
        : focalSources.has('relationship_evidence')
          ? 'relationship_evidence'
          : 'network_topology';
    aNeighbors.delete(b);
    bNeighbors.delete(a);
    const common = [...aNeighbors].filter((id) => bNeighbors.has(id)).length;
    const union = new Set([...aNeighbors, ...bNeighbors]).size;
    const embeddedness = hasObservedTie
      ? measured(union > 0 ? common / union : 0, common, union, topologyBasis)
      : missingMeasure(topologyBasis);

    dyads.set(key, {
      reciprocity, dependenceAsymmetry, embeddedness,
      commonNeighborCount: common, unionNeighborCount: union,
    });
  }

  return {
    window: {
      days: windowDays,
      startGameTime: windowStart,
      endGameTime: safeNow,
      label: windowDays === null ? '全部可观测历史' : `近 ${windowDays} 日`,
    },
    measureSchema: RELATIONAL_MEASURE_SCHEMA,
    dataQuality: [
      '关系证据记录触发状态更新的互动摘要，不覆盖全部接触与全部对话轮次。',
      '关系 API 按精确游戏时间区间读取完整证据账本；长时段 all 查询的计算成本随历史规模增长。',
      '本地伙伴选择事件用于探索性可视化；正式推断应按 AgentSociety² Replay 的 runId 与 conditionId 分层。',
      '馈礼同时改变旧关系字段并形成资源交换渠道，涉及馈礼条件的比较必须单独分层。',
    ],
    observationSummary: { relationshipEvidence: windowEvidence.length, partnerChoices: windowChoices.length },
    directed,
    dyads,
    observedDyads: [...dyadIds.values()],
  };
}
