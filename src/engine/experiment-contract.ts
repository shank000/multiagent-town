// AgentSociety² 正式实验的跨运行时协议：固定处理变量、候选集合与 Replay 审计字段。

import { createHash } from 'node:crypto';

export const STUDY_SCHEMA_VERSION = 'partner-choice.study/v1' as const;
export const PROTOCOL_SCHEMA_VERSION = 'partner-choice.protocol/v1' as const;
export const OBSERVATION_SCHEMA_VERSION = 'partner-choice.observation/v1' as const;
export const EVENT_SCHEMA_VERSION = 'partner-choice.event/v1' as const;

export type HistoryMode = 'none' | 'recent_k' | 'full';
export type DecisionSource = 'llm' | 'seeded_fallback';

export interface PartnerChoiceConditionV1 {
  id: string;
  historyMode: HistoryMode;
  recentK?: number;
  giftExchange: boolean;
}

export interface PartnerChoiceStudyManifestV1 {
  schemaVersion: typeof STUDY_SCHEMA_VERSION;
  platform: {
    package: 'agentsociety2';
    version: string;
    python: string;
  };
  participantCount: number;
  days: number;
  seeds: number[];
  roundMinute: number;
  candidatePolicy: 'all_other_participants';
  candidateOrderPolicy: 'paired_seeded_shuffle';
  decision: {
    policy: 'llm';
    promptVersion: string;
    fallback: 'seeded_uniform';
    modelRole: string;
    temperature: number;
    topP: number;
    maxTokens: number;
    maxAttempts: number;
  };
  coreConditions: PartnerChoiceConditionV1[];
  robustnessConditions: PartnerChoiceConditionV1[];
  replay: {
    choiceDatasetId: string;
    defaultOrder: string[];
  };
}

export interface PartnerChoiceProtocolV1 {
  schemaVersion: typeof PROTOCOL_SCHEMA_VERSION;
  studyId: string;
  runId: string;
  pairingBlockId: string;
  conditionId: string;
  replicate: number;
  seed: number;
  agentIds: string[];
  profileSetHash: string;
  days: number;
  roundMinute: number;
  manipulation: {
    historyMode: HistoryMode;
    recentK?: number;
    giftExchange: boolean;
  };
  decision: {
    policy: 'llm';
    promptVersion: string;
    fallback: 'seeded_uniform';
    modelRole: string;
    temperature: number;
    topP: number;
    maxTokens: number;
    maxAttempts: number;
  };
}

export interface InteractionRefV1 {
  id: string;
  day: number;
  gameTime: number;
  summary: string;
}

export interface CandidateAuditV1 {
  id: string;
  name: string;
  affection: number;
  lastInteraction: number | null;
  interactionCount: number;
}

export interface PartnerChoiceReplayV1 {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  eventType: 'partner_choice';
  eventId: string;
  eventSeq: number;
  runId: string;
  pairingBlockId: string;
  conditionId: string;
  protocolHash: string;
  profileSetHash: string;
  replicate: number;
  seed: number;
  day: number;
  roundId: string;
  step: number;
  t: string;
  chooserId: string;
  candidateIds: string[];
  chosenId: string;
  historyMode: HistoryMode;
  giftExchange: boolean;
  visibleHistory: Record<string, InteractionRefV1[]>;
  preChoiceCandidates: CandidateAuditV1[];
  decision: {
    source: DecisionSource;
    modelId: string;
    temperature: number;
    topP: number;
    maxTokens: number;
    promptHash: string;
    observationHash: string;
    rawResponse: string | null;
    parsedChosenId: string | null;
    parseStatus: 'valid' | 'invalid' | 'error';
    attemptCount: number;
    rationale?: string;
    fallbackReason?: string;
  };
}

export interface LegacyChoicePayload {
  kind: 'experiment_pair_choice';
  fromId: string;
  toId: string;
  mode: 'on' | 'off';
  candidates: Array<{ id: string; name: string; affection: number; lastInteraction: number }>;
  chosen: string;
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  runId: string;
  conditionId: string;
  seed: number;
  day: number;
  roundId: string;
  decisionSource: DecisionSource;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`partner-choice contract: ${message}`);
}

function assertNonEmpty(value: string, field: string): void {
  invariant(value.trim().length > 0, `${field} must be non-empty`);
}

function assertPositiveInteger(value: number, field: string): void {
  invariant(Number.isSafeInteger(value) && value > 0, `${field} must be a positive safe integer`);
}

function assertHistoryConfig(mode: HistoryMode, recentK: number | undefined, field: string): void {
  if (mode === 'recent_k') {
    assertPositiveInteger(recentK ?? 0, `${field}.recentK`);
    return;
  }
  invariant(recentK === undefined, `${field}.recentK is valid only for recent_k`);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameMembers(left: string[], right: string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalValue(item)]));
  }
  if (typeof value === 'number') invariant(Number.isFinite(value), 'canonical JSON rejects non-finite numbers');
  return value;
}

/** 跨 TypeScript/Python 使用的稳定 JSON 表示，键按字典序递归排序。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

/** 完整运行协议哈希；包含 run、condition 与 seed，唯一标识一条实验运行。 */
export function hashPartnerChoiceProtocol(protocol: PartnerChoiceProtocolV1): string {
  assertPartnerChoiceProtocol(protocol);
  return `sha256:${createHash('sha256').update(canonicalJson(protocol)).digest('hex')}`;
}

/** 研究者可重建的精确候选观察；客观关系分数不进入该对象。 */
export function partnerChoiceObservation(event: PartnerChoiceReplayV1): Record<string, unknown> {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    runId: event.runId,
    conditionId: event.conditionId,
    day: event.day,
    roundId: event.roundId,
    chooserId: event.chooserId,
    candidates: event.preChoiceCandidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      historyMode: event.historyMode,
      history: event.visibleHistory[candidate.id] ?? [],
    })),
  };
}

export function hashPartnerChoiceObservation(event: PartnerChoiceReplayV1): string {
  return `sha256:${createHash('sha256').update(canonicalJson(partnerChoiceObservation(event))).digest('hex')}`;
}

/** 标签派生候选顺序；配对条件共享 seed/pairingBlockId，且不依赖可变 RNG 游标。 */
export function candidateOrderFor(protocol: PartnerChoiceProtocolV1, day: number, chooserId: string): string[] {
  invariant(Number.isSafeInteger(day) && day >= 1 && day <= protocol.days, 'candidate order day is outside protocol range');
  invariant(protocol.agentIds.includes(chooserId), 'candidate order chooser is not a participant');
  const rank = (candidateId: string): string => createHash('sha256')
    .update(canonicalJson([protocol.seed, protocol.pairingBlockId, 'candidate_order', day, chooserId, candidateId]))
    .digest('hex');
  return protocol.agentIds
    .filter((id) => id !== chooserId)
    .map((id) => ({ id, rank: rank(id) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id }) => id);
}

export function assertStudyManifest(manifest: PartnerChoiceStudyManifestV1): void {
  invariant(manifest.schemaVersion === STUDY_SCHEMA_VERSION, `schemaVersion must be ${STUDY_SCHEMA_VERSION}`);
  invariant(manifest.platform.package === 'agentsociety2', 'platform.package must be agentsociety2');
  invariant(manifest.platform.version === '2.8.4', 'platform.version must be pinned to 2.8.4');
  invariant(manifest.platform.python === '>=3.11,<3.14', 'platform.python must match AgentSociety² 2.8.4');
  assertPositiveInteger(manifest.participantCount, 'participantCount');
  invariant(manifest.participantCount >= 3, 'participantCount must be at least 3');
  assertPositiveInteger(manifest.days, 'days');
  invariant(manifest.seeds.length > 0, 'seeds must not be empty');
  invariant(new Set(manifest.seeds).size === manifest.seeds.length, 'seeds must be unique');
  for (const seed of manifest.seeds) assertPositiveInteger(seed, 'seed');
  invariant(Number.isInteger(manifest.roundMinute) && manifest.roundMinute >= 0 && manifest.roundMinute < 1440, 'roundMinute must be within one day');
  invariant(manifest.candidatePolicy === 'all_other_participants', 'candidatePolicy must keep candidate counts equal');
  invariant(manifest.candidateOrderPolicy === 'paired_seeded_shuffle', 'candidate ordering must be paired across conditions');
  invariant(manifest.decision.policy === 'llm', 'core conditions must use one LLM decision policy');
  invariant(manifest.decision.fallback === 'seeded_uniform', 'fallback must be seeded_uniform');
  assertNonEmpty(manifest.decision.promptVersion, 'decision.promptVersion');
  assertNonEmpty(manifest.decision.modelRole, 'decision.modelRole');
  invariant(Number.isFinite(manifest.decision.temperature) && manifest.decision.temperature >= 0, 'decision.temperature must be non-negative');
  invariant(Number.isFinite(manifest.decision.topP) && manifest.decision.topP > 0 && manifest.decision.topP <= 1, 'decision.topP must be within (0, 1]');
  assertPositiveInteger(manifest.decision.maxTokens, 'decision.maxTokens');
  assertPositiveInteger(manifest.decision.maxAttempts, 'decision.maxAttempts');

  const allConditions = [...manifest.coreConditions, ...manifest.robustnessConditions];
  invariant(allConditions.length > 0, 'conditions must not be empty');
  invariant(new Set(allConditions.map((condition) => condition.id)).size === allConditions.length, 'condition ids must be unique');
  for (const condition of allConditions) {
    assertNonEmpty(condition.id, 'condition.id');
    assertHistoryConfig(condition.historyMode, condition.recentK, `condition ${condition.id}`);
  }

  const coreCells = new Set(manifest.coreConditions.map((condition) => `${condition.historyMode}:${condition.giftExchange}`));
  const expectedCells = ['none:false', 'none:true', 'full:false', 'full:true'];
  invariant(manifest.coreConditions.length === expectedCells.length && expectedCells.every((cell) => coreCells.has(cell)), 'coreConditions must be the complete memory × gift 2×2 matrix');
  invariant(manifest.robustnessConditions.some((condition) => condition.historyMode === 'recent_k'), 'robustnessConditions must include bounded memory');
  invariant(manifest.replay.choiceDatasetId === 'partner_choice.choice_event', 'choice replay dataset id must be stable');
  const replayOrder = ['day', 'round_id', 'chooser_id', 'event_seq'];
  invariant(manifest.replay.defaultOrder.length === replayOrder.length && manifest.replay.defaultOrder.every((key, index) => key === replayOrder[index]), 'Replay defaultOrder must deterministically order choice rows');
}

export function assertPartnerChoiceProtocol(protocol: PartnerChoiceProtocolV1): void {
  invariant(protocol.schemaVersion === PROTOCOL_SCHEMA_VERSION, `schemaVersion must be ${PROTOCOL_SCHEMA_VERSION}`);
  assertNonEmpty(protocol.studyId, 'studyId');
  assertNonEmpty(protocol.runId, 'runId');
  assertNonEmpty(protocol.pairingBlockId, 'pairingBlockId');
  assertNonEmpty(protocol.conditionId, 'conditionId');
  assertPositiveInteger(protocol.replicate, 'replicate');
  assertPositiveInteger(protocol.seed, 'seed');
  invariant(protocol.agentIds.length >= 2, 'agentIds must contain at least two participants');
  invariant(sortedUnique(protocol.agentIds).length === protocol.agentIds.length, 'agentIds must be unique');
  for (const id of protocol.agentIds) assertNonEmpty(id, 'agentId');
  assertNonEmpty(protocol.profileSetHash, 'profileSetHash');
  assertPositiveInteger(protocol.days, 'days');
  invariant(Number.isInteger(protocol.roundMinute) && protocol.roundMinute >= 0 && protocol.roundMinute < 1440, 'roundMinute must be within one day');
  assertHistoryConfig(protocol.manipulation.historyMode, protocol.manipulation.recentK, 'manipulation');
  invariant(protocol.decision.policy === 'llm', 'decision.policy must be llm in the confirmatory experiment');
  invariant(protocol.decision.fallback === 'seeded_uniform', 'decision.fallback must be seeded_uniform');
  assertNonEmpty(protocol.decision.promptVersion, 'decision.promptVersion');
  assertNonEmpty(protocol.decision.modelRole, 'decision.modelRole');
  invariant(Number.isFinite(protocol.decision.temperature) && protocol.decision.temperature >= 0, 'decision.temperature must be non-negative');
  invariant(Number.isFinite(protocol.decision.topP) && protocol.decision.topP > 0 && protocol.decision.topP <= 1, 'decision.topP must be within (0, 1]');
  assertPositiveInteger(protocol.decision.maxTokens, 'decision.maxTokens');
  assertPositiveInteger(protocol.decision.maxAttempts, 'decision.maxAttempts');
}

export function assertPartnerChoiceRound(protocol: PartnerChoiceProtocolV1, events: PartnerChoiceReplayV1[]): void {
  assertPartnerChoiceProtocol(protocol);
  invariant(events.length === protocol.agentIds.length, 'each round must contain exactly one choice per participant');
  invariant(new Set(events.map((event) => event.chooserId)).size === events.length, 'each participant may choose only once per round');
  invariant(new Set(events.map((event) => event.eventId)).size === events.length, 'eventId must be unique within a round');
  invariant(new Set(events.map((event) => event.eventSeq)).size === events.length, 'eventSeq must be unique within a round');
  invariant(new Set(events.map((event) => event.roundId)).size === 1, 'all rows must share one roundId');
  invariant(new Set(events.map((event) => event.day)).size === 1, 'all rows must share one day');
  const expectedHash = hashPartnerChoiceProtocol(protocol);

  for (const event of events) {
    invariant(event.schemaVersion === EVENT_SCHEMA_VERSION, 'choice schemaVersion mismatch');
    invariant(event.eventType === 'partner_choice', 'eventType must be partner_choice');
    assertNonEmpty(event.eventId, 'eventId');
    invariant(Number.isSafeInteger(event.eventSeq) && event.eventSeq >= 0, 'eventSeq must be non-negative');
    invariant(event.runId === protocol.runId, 'runId does not match protocol');
    invariant(event.pairingBlockId === protocol.pairingBlockId, 'pairingBlockId does not match protocol');
    invariant(event.conditionId === protocol.conditionId, 'conditionId does not match protocol');
    invariant(event.protocolHash === expectedHash, 'protocolHash does not match protocol');
    invariant(event.profileSetHash === protocol.profileSetHash, 'profileSetHash does not match protocol');
    invariant(event.replicate === protocol.replicate, 'replicate does not match protocol');
    invariant(event.seed === protocol.seed, 'seed does not match protocol');
    invariant(Number.isInteger(event.day) && event.day >= 1 && event.day <= protocol.days, 'day is outside protocol range');
    assertNonEmpty(event.roundId, 'roundId');
    invariant(Number.isSafeInteger(event.step) && event.step >= 0, 'step must be a non-negative safe integer');
    invariant(Number.isFinite(Date.parse(event.t)), 't must be an ISO-8601 timestamp');
    invariant(protocol.agentIds.includes(event.chooserId), 'chooserId is not a participant');

    const expectedCandidates = candidateOrderFor(protocol, event.day, event.chooserId);
    invariant(event.candidateIds.length === protocol.agentIds.length - 1, 'candidate count must equal N-1');
    invariant(sortedUnique(event.candidateIds).length === event.candidateIds.length, 'candidateIds must be unique');
    invariant(event.candidateIds.every((id, index) => id === expectedCandidates[index]), 'candidateIds must preserve the paired candidate order');
    invariant(event.candidateIds.includes(event.chosenId), 'chosenId must be in candidateIds');
    invariant(event.historyMode === protocol.manipulation.historyMode, 'historyMode does not match protocol');
    invariant(event.giftExchange === protocol.manipulation.giftExchange, 'giftExchange does not match protocol');

    const auditIds = event.preChoiceCandidates.map((candidate) => candidate.id);
    invariant(auditIds.every((id, index) => id === expectedCandidates[index]), 'preChoiceCandidates must preserve candidateIds order');
    invariant(sortedUnique(auditIds).length === auditIds.length, 'preChoiceCandidates ids must be unique');
    for (const candidate of event.preChoiceCandidates) {
      assertNonEmpty(candidate.name, 'candidate.name');
      invariant(Number.isFinite(candidate.affection), 'candidate.affection must be finite');
      invariant(candidate.lastInteraction === null || (Number.isSafeInteger(candidate.lastInteraction) && candidate.lastInteraction >= 0), 'candidate.lastInteraction must be null or non-negative');
      invariant(Number.isSafeInteger(candidate.interactionCount) && candidate.interactionCount >= 0, 'candidate.interactionCount must be non-negative');
    }

    const visibleIds = Object.keys(event.visibleHistory);
    if (event.historyMode === 'none') {
      invariant(visibleIds.length === 0, 'none condition must expose no partner history');
    } else {
      invariant(sameMembers(visibleIds, expectedCandidates), 'memory conditions must record exposure for every candidate');
      for (const [partnerId, history] of Object.entries(event.visibleHistory)) {
        invariant(expectedCandidates.includes(partnerId), 'visibleHistory contains a non-candidate');
        if (event.historyMode === 'recent_k') {
          invariant(history.length <= (protocol.manipulation.recentK ?? 0), 'visibleHistory exceeds recentK');
        }
        for (const interaction of history) {
          assertNonEmpty(interaction.id, 'interaction.id');
          invariant(Number.isSafeInteger(interaction.day) && interaction.day >= 1, 'interaction.day must be positive');
          invariant(Number.isSafeInteger(interaction.gameTime) && interaction.gameTime >= 0, 'interaction.gameTime must be non-negative');
          assertNonEmpty(interaction.summary, 'interaction.summary');
        }
      }
    }

    invariant(event.decision.source === 'llm' || event.decision.source === 'seeded_fallback', 'decision.source is invalid');
    assertNonEmpty(event.decision.modelId, 'decision.modelId');
    invariant(Number.isFinite(event.decision.temperature) && event.decision.temperature >= 0, 'decision.temperature must be non-negative');
    invariant(event.decision.temperature === protocol.decision.temperature, 'decision.temperature does not match protocol');
    invariant(Number.isFinite(event.decision.topP) && event.decision.topP > 0 && event.decision.topP <= 1, 'decision.topP must be within (0, 1]');
    invariant(event.decision.topP === protocol.decision.topP, 'decision.topP does not match protocol');
    assertPositiveInteger(event.decision.maxTokens, 'decision.maxTokens');
    invariant(event.decision.maxTokens === protocol.decision.maxTokens, 'decision.maxTokens does not match protocol');
    assertNonEmpty(event.decision.promptHash, 'decision.promptHash');
    assertNonEmpty(event.decision.observationHash, 'decision.observationHash');
    invariant(event.decision.observationHash === hashPartnerChoiceObservation(event), 'decision.observationHash does not match the visible observation');
    invariant(event.decision.parseStatus === 'valid' || event.decision.parseStatus === 'invalid' || event.decision.parseStatus === 'error', 'decision.parseStatus is invalid');
    assertPositiveInteger(event.decision.attemptCount, 'decision.attemptCount');
    invariant(event.decision.attemptCount <= protocol.decision.maxAttempts, 'decision.attemptCount exceeds maxAttempts');
    if (event.decision.source === 'llm') {
      invariant(event.decision.parseStatus === 'valid', 'LLM choice must have a valid parsed response');
      invariant(event.decision.parsedChosenId === event.chosenId, 'parsedChosenId must equal chosenId for an LLM choice');
      assertNonEmpty(event.decision.rawResponse ?? '', 'decision.rawResponse');
    } else {
      invariant(event.decision.parseStatus !== 'valid', 'seeded fallback must follow an invalid or errored response');
      assertNonEmpty(event.decision.fallbackReason ?? '', 'decision.fallbackReason');
    }
  }
}

/** 保留叙事前台依赖的 mode/candidates/chosen，同时附加运行审计键。 */
export function toLegacyChoicePayload(event: PartnerChoiceReplayV1): LegacyChoicePayload {
  return {
    kind: 'experiment_pair_choice',
    fromId: event.chooserId,
    toId: event.chosenId,
    mode: event.historyMode === 'none' ? 'off' : 'on',
    candidates: event.preChoiceCandidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      affection: candidate.affection,
      lastInteraction: candidate.lastInteraction ?? 0,
    })),
    chosen: event.chosenId,
    schemaVersion: event.schemaVersion,
    runId: event.runId,
    conditionId: event.conditionId,
    seed: event.seed,
    day: event.day,
    roundId: event.roundId,
    decisionSource: event.decision.source,
  };
}
