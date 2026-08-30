// 社会关系只读投影：从旧关系状态与不可变证据生成多维、有向、可解释视图。
// 本模块不写数据库，也不参与伙伴选择、LLM 提示或研究指标计算。

import type { Relationship, RelationshipEvidence } from '../store/relationships';
import {
  computeRelationalMeasurements,
  emptyDirectedRelationalMeasures,
  emptyDyadRelationalMeasures,
  relationDirectionKey,
  relationDyadKey,
  type DirectedRelationalMeasures,
  type DyadRelationalMeasures,
  type PartnerChoiceObservation,
  type RelationalMeasureDefinition,
} from './relational-measures';

export {
  DEFAULT_RELATION_WINDOW_DAYS,
  RELATIONAL_MEASURE_SCHEMA,
  type DirectedRelationalMeasures,
  type DyadRelationalMeasures,
  type PartnerChoiceObservation,
  type RelationalMeasureDefinition,
  type RelationalMeasureKey,
  type RelationalMeasureValue,
} from './relational-measures';

export const SOCIAL_RELATION_MODEL_VERSION = 'social-relations-v2' as const;
const DAY = 1440;
const FREQUENCY_HALF_LIFE = 7 * DAY;

export type SocialTieType =
  | 'close'
  | 'supportive'
  | 'respect_based'
  | 'familiar'
  | 'strained'
  | 'asymmetric'
  | 'acquaintance';

export const SOCIAL_TIE_LABELS: Record<SocialTieType, string> = {
  close: '高亲密画像',
  supportive: '高支持画像',
  respect_based: '高尊重画像',
  familiar: '高暴露画像',
  strained: '高张力画像',
  asymmetric: '方向差异画像',
  acquaintance: '证据稀疏画像',
};

export interface SocialDimensions {
  /** 旧 affection，有向，-1..1。 */
  closeness: number;
  /** 基于带来源增量的信任代理，-1..1。 */
  trust: number;
  /** 旧 respect，有向，-1..1。 */
  respect: number;
  /** 馈礼等资源行为的支持代理，0..1。 */
  support: number;
  /** 负向变化与负关系状态的张力代理，0..1。 */
  tension: number;
  /** 近期关系更新暴露的时间衰减强度，0..1。 */
  frequency: number;
}

export interface DirectedSocialRelation {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  directionLabel: string;
  /** 该方向是否存在持久化 Relationship 状态；选择观察本身不会伪造关系状态。 */
  relationshipStateObserved: boolean;
  legacy: {
    affection: number;
    respect: number;
    knowledgeCount: number;
    updatedGameTime: number;
  } | null;
  dimensions: SocialDimensions;
  measures: DirectedRelationalMeasures;
  /** 关系连接强度，不代表正向情感，0..1。 */
  strength: number;
  /** 综合方向，-1 紧张到 +1 正向。 */
  valence: number;
  /** 最近七日有向净变化，-1..1。 */
  recentChange: number;
  lastInteraction: number;
  evidenceCount: number;
  evidence: RelationshipEvidence[];
  tieType: SocialTieType;
  tieLabel: string;
}

export interface SocialDyad {
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  aToB: DirectedSocialRelation | null;
  bToA: DirectedSocialRelation | null;
  /** 双向方向与强度的一致程度；缺少反向记录时为 0。 */
  reciprocity: number;
  /** 同时考虑强度差与情感方向差，0..1。 */
  asymmetry: number;
  strength: number;
  recentChange: number;
  aToBMeasures: DirectedRelationalMeasures;
  bToAMeasures: DirectedRelationalMeasures;
  measures: DyadRelationalMeasures;
  tieType: SocialTieType;
  tieLabel: string;
}

export interface SocialProjectionOptions {
  evidencePerDirection?: number;
  /** null 表示从世界开始至 generatedGameTime。 */
  windowDays?: number | null;
  choices?: readonly PartnerChoiceObservation[];
}

export interface SocialRelationshipProjection {
  modelVersion: typeof SOCIAL_RELATION_MODEL_VERSION;
  generatedGameTime: number;
  window: { days: number | null; startGameTime: number; endGameTime: number; label: string };
  proxyNotice: string;
  measureSchema: readonly RelationalMeasureDefinition[];
  dataQuality: string[];
  observationSummary: { relationshipEvidence: number; partnerChoices: number };
  directions: DirectedSocialRelation[];
  dyads: SocialDyad[];
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const rounded = (value: number) => Math.round(value * 10_000) / 10_000;
const pairKey = (a: string, b: string) => `${a}\u0000${b}`;
const dyadKey = (a: string, b: string) => a < b ? pairKey(a, b) : pairKey(b, a);

function sourceTypeForDirection(dimensions: SocialDimensions, valence: number): SocialTieType {
  if (dimensions.tension >= 0.32 || valence <= -0.2) return 'strained';
  if (dimensions.support >= 0.3 && dimensions.trust >= 0.18) return 'supportive';
  if (dimensions.closeness >= 0.42 && dimensions.trust >= 0.2) return 'close';
  if (dimensions.respect >= 0.42 && dimensions.closeness < 0.35) return 'respect_based';
  if (dimensions.frequency >= 0.3) return 'familiar';
  return 'acquaintance';
}

function dyadType(
  aToB: DirectedSocialRelation | null,
  bToA: DirectedSocialRelation | null,
  reciprocity: number,
  asymmetry: number
): SocialTieType {
  const directions = [aToB, bToA].filter((item): item is DirectedSocialRelation => item !== null);
  if (directions.some((item) => item.tieType === 'strained')) return 'strained';
  if (!aToB || !bToA || asymmetry >= 0.34) return 'asymmetric';
  const average = (key: keyof SocialDimensions) => (
    directions.reduce((sum, item) => sum + item.dimensions[key], 0) / directions.length
  );
  if (average('support') >= 0.3 && average('trust') >= 0.18) return 'supportive';
  if (average('closeness') >= 0.42 && reciprocity >= 0.65) return 'close';
  if (average('respect') >= 0.42) return 'respect_based';
  if (average('frequency') >= 0.3) return 'familiar';
  return 'acquaintance';
}

function directionProjection(
  relationship: Relationship | null,
  fromId: string,
  toId: string,
  evidence: RelationshipEvidence[],
  windowEvidence: RelationshipEvidence[],
  names: ReadonlyMap<string, string>,
  now: number,
  windowStart: number,
  evidencePerDirection: number,
  measures: DirectedRelationalMeasures,
  lastChoice: number | null,
): DirectedSocialRelation {
  let trust = 0;
  let support = 0;
  let decayedTension = 0;
  let exposure = 0;
  let recentChange = 0;
  for (const item of evidence) {
    trust += item.trustDelta;
    support += item.supportDelta;
    const age = Math.max(0, now - item.gameTime);
    const weight = Math.pow(0.5, age / FREQUENCY_HALF_LIFE);
    exposure += weight;
    decayedTension += item.tensionDelta * weight;
    if (item.gameTime >= windowStart) {
      recentChange += item.affectionDelta * 0.45
        + item.respectDelta * 0.25
        + item.trustDelta * 0.2
        + item.supportDelta * 0.1
        - item.tensionDelta * 0.45;
    }
  }

  const dimensions: SocialDimensions = {
    closeness: rounded(clamp(relationship?.affection ?? 0, -1, 1)),
    trust: rounded(clamp(trust, -1, 1)),
    respect: rounded(clamp(relationship?.respect ?? 0, -1, 1)),
    support: rounded(clamp(support, 0, 1)),
    tension: rounded(clamp(Math.max(
      decayedTension,
      Math.max(0, -(relationship?.affection ?? 0)),
      Math.max(0, -(relationship?.respect ?? 0))
    ), 0, 1)),
    frequency: rounded(clamp(1 - Math.exp(-exposure / 4), 0, 1)),
  };
  const positiveStrength = Math.max(0, dimensions.closeness) * 0.3
    + Math.max(0, dimensions.respect) * 0.2
    + Math.max(0, dimensions.trust) * 0.2
    + dimensions.support * 0.15
    + dimensions.frequency * 0.15;
  const negativeStrength = dimensions.tension * 0.55
    + Math.max(0, -dimensions.closeness) * 0.25
    + Math.max(0, -dimensions.respect) * 0.2;
  const strength = rounded(clamp(Math.max(positiveStrength, negativeStrength, dimensions.frequency * 0.35), 0, 1));
  const valence = rounded(clamp(
    dimensions.closeness * 0.45
      + dimensions.trust * 0.25
      + dimensions.respect * 0.2
      + dimensions.support * 0.1
      - dimensions.tension * 0.45,
    -1,
    1
  ));
  const type = sourceTypeForDirection(dimensions, valence);
  const fromName = names.get(fromId) ?? fromId;
  const toName = names.get(toId) ?? toId;
  const lastInteraction = Math.max(
    evidence[0]?.gameTime ?? -1,
    lastChoice ?? -1,
    relationship?.updatedGameTime ?? -1,
    0,
  );

  return {
    fromId,
    fromName,
    toId,
    toName,
    directionLabel: `${fromName} → ${toName}`,
    relationshipStateObserved: relationship !== null,
    legacy: relationship === null ? null : {
      affection: relationship.affection,
      respect: relationship.respect,
      knowledgeCount: relationship.knowledge.length,
      updatedGameTime: relationship.updatedGameTime,
    },
    dimensions,
    measures,
    strength,
    valence,
    recentChange: rounded(clamp(recentChange, -1, 1)),
    lastInteraction,
    evidenceCount: windowEvidence.length,
    evidence: windowEvidence.slice(0, evidencePerDirection),
    tieType: type,
    tieLabel: SOCIAL_TIE_LABELS[type],
  };
}

/**
 * 生成全网只读投影。输入证据应按时间倒序；函数不会修改任一输入对象。
 */
export function projectSocialRelationships(
  relationships: readonly Relationship[],
  evidence: readonly RelationshipEvidence[],
  names: ReadonlyMap<string, string>,
  now: number,
  inputOptions: number | SocialProjectionOptions = {},
): SocialRelationshipProjection {
  const safeNow = Number.isFinite(now) ? Math.max(0, Math.floor(now)) : 0;
  const options = typeof inputOptions === 'number'
    ? { evidencePerDirection: inputOptions }
    : inputOptions;
  const evidenceLimit = Math.max(1, Math.min(100, Math.floor(options.evidencePerDirection ?? 6)));
  const measurement = computeRelationalMeasurements(relationships, evidence, safeNow, {
    windowDays: options.windowDays,
    choices: options.choices,
  });
  const relationshipByDirection = new Map<string, Relationship>();
  const directionIds = new Map<string, [string, string]>();
  const registerDirection = (fromId: string, toId: string) => {
    if (!fromId || !toId || fromId === toId) return;
    directionIds.set(pairKey(fromId, toId), [fromId, toId]);
  };
  for (const relationship of relationships) {
    const key = pairKey(relationship.agentA, relationship.agentB);
    relationshipByDirection.set(key, relationship);
    registerDirection(relationship.agentA, relationship.agentB);
  }

  const byDirection = new Map<string, RelationshipEvidence[]>();
  for (const item of evidence) {
    if (item.gameTime > safeNow) continue;
    const key = pairKey(item.agentA, item.agentB);
    registerDirection(item.agentA, item.agentB);
    const list = byDirection.get(key) ?? [];
    list.push(item);
    byDirection.set(key, list);
  }
  for (const list of byDirection.values()) {
    list.sort((left, right) => right.gameTime - left.gameTime || right.id.localeCompare(left.id));
  }
  const windowEvidenceByDirection = new Map([...byDirection].map(([key, items]) => [
    key,
    items.filter((item) => item.gameTime >= measurement.window.startGameTime),
  ]));
  const lastChoiceByDirection = new Map<string, number>();
  for (const choice of options.choices ?? []) {
    if (!choice.fromId || !choice.toId || choice.fromId === choice.toId
      || !Number.isFinite(choice.gameTime) || choice.gameTime > safeNow) continue;
    const key = pairKey(choice.fromId, choice.toId);
    registerDirection(choice.fromId, choice.toId);
    lastChoiceByDirection.set(key, Math.max(lastChoiceByDirection.get(key) ?? -1, choice.gameTime));
  }

  const directions = [...directionIds.values()]
    .map(([fromId, toId]) => {
      const key = pairKey(fromId, toId);
      return directionProjection(
        relationshipByDirection.get(key) ?? null,
        fromId,
        toId,
        byDirection.get(key) ?? [],
        windowEvidenceByDirection.get(key) ?? [],
        names,
        safeNow,
        measurement.window.startGameTime,
        evidenceLimit,
        measurement.directed.get(relationDirectionKey(fromId, toId))
          ?? emptyDirectedRelationalMeasures(),
        lastChoiceByDirection.get(key) ?? null,
      );
    })
    .sort((left, right) => right.strength - left.strength
      || left.fromId.localeCompare(right.fromId)
      || left.toId.localeCompare(right.toId));

  const directionByKey = new Map(directions.map((direction) => [pairKey(direction.fromId, direction.toId), direction]));
  const dyadIds = new Map<string, [string, string]>();
  for (const direction of directions) {
    const a = direction.fromId < direction.toId ? direction.fromId : direction.toId;
    const b = direction.fromId < direction.toId ? direction.toId : direction.fromId;
    dyadIds.set(dyadKey(a, b), [a, b]);
  }
  for (const [a, b] of measurement.observedDyads) dyadIds.set(dyadKey(a, b), [a, b]);
  const dyads = [...dyadIds.values()].map(([a, b]): SocialDyad => {
    const aToB = directionByKey.get(pairKey(a, b)) ?? null;
    const bToA = directionByKey.get(pairKey(b, a)) ?? null;
    const asymmetry = aToB && bToA
      ? rounded(clamp(
        Math.abs(aToB.strength - bToA.strength) * 0.55
          + (Math.abs(aToB.valence - bToA.valence) / 2) * 0.45,
        0,
        1
      ))
      : 1;
    const reciprocity = aToB && bToA ? rounded(1 - asymmetry) : 0;
    const strength = rounded((Math.max(aToB?.strength ?? 0, bToA?.strength ?? 0)
      + ((aToB?.strength ?? 0) + (bToA?.strength ?? 0)) / 2) / 2);
    const recentChange = rounded(((aToB?.recentChange ?? 0) + (bToA?.recentChange ?? 0)) / 2);
    const type = dyadType(aToB, bToA, reciprocity, asymmetry);
    return {
      aId: a,
      aName: names.get(a) ?? a,
      bId: b,
      bName: names.get(b) ?? b,
      aToB,
      bToA,
      reciprocity,
      asymmetry,
      strength,
      recentChange,
      aToBMeasures: measurement.directed.get(relationDirectionKey(a, b))
        ?? emptyDirectedRelationalMeasures(),
      bToAMeasures: measurement.directed.get(relationDirectionKey(b, a))
        ?? emptyDirectedRelationalMeasures(),
      measures: measurement.dyads.get(relationDyadKey(a, b)) ?? emptyDyadRelationalMeasures(),
      tieType: type,
      tieLabel: SOCIAL_TIE_LABELS[type],
    };
  }).sort((left, right) => right.strength - left.strength
    || left.aId.localeCompare(right.aId)
    || left.bId.localeCompare(right.bId));

  return {
    modelVersion: SOCIAL_RELATION_MODEL_VERSION,
    generatedGameTime: safeNow,
    window: measurement.window,
    proxyNotice: '所有关系数值均为事件驱动的只读观察量或描述性代理，不作为实验处理、agent 内部关系标签或决策输入。',
    measureSchema: measurement.measureSchema,
    dataQuality: measurement.dataQuality,
    observationSummary: measurement.observationSummary,
    directions,
    dyads,
  };
}
