// 事件驱动反思：重要记忆触发即时修正，跨日生成证据约束的第一人称日记。
// 客观事实保留在 events/memories；日记、心态与信念属于 agent 的主观解释，并携带证据 ID。

import { randomUUID } from 'node:crypto';
import type { Agent, GameEvent } from '../core/types';
import type { EventLog } from '../store/events';
import { normalizeInsightKey } from '../store/memory';
import type {
  BeliefUpdate,
  InsightRevision,
  Memory,
  MemoryStore,
  ReflectionKind,
  ReflectionMindState,
} from '../store/memory';
import type { LLMGateway } from '../llm/gateway';
import { initialMindStateOf } from './agent-profile';
import {
  REFLECTION_INSIGHTS_TEMPLATE,
  REFLECTION_JOURNAL_JSON_SCHEMA,
  REFLECTION_JOURNAL_TEMPLATE,
  REFLECTION_QUESTIONS_TEMPLATE,
  reflectionInsightsMessages,
  reflectionJournalMessages,
  reflectionQuestionsMessages,
} from '../llm/prompts';

const REFLECTION_THRESHOLD = 150;
const MAX_TRIGGERED_PER_DAY = 2;

interface JournalRaw {
  diary?: unknown;
  mind_state?: unknown;
  insights?: unknown;
  beliefs?: unknown;
  revisions?: unknown;
  behavior_guidance?: unknown;
}

export class ReflectionEngine {
  private thresholdPending = new Set<string>();
  private dailyScheduled = new Set<string>();
  private chains = new Map<string, Promise<void>>();
  private active = new Set<Promise<void>>();

  constructor(
    private llm: LLMGateway,
    private store: MemoryStore,
    private log: EventLog,
    private scopeId = 'default',
  ) {}

  tick(agent: Agent, day: number, now: number): void {
    const count = this.store.triggeredReflectionCount(agent.id, day);
    if (count >= MAX_TRIGGERED_PER_DAY || this.thresholdPending.has(agent.id)) return;
    const triggerScore = this.store.accumulator(agent.id);
    if (triggerScore <= REFLECTION_THRESHOLD) return;
    if (this.evidenceFor(agent.id, day, 'triggered').length === 0) {
      this.store.resetAccumulator(agent.id);
      return;
    }

    this.store.resetAccumulator(agent.id);
    this.thresholdPending.add(agent.id);
    void this.enqueue(agent.id, async () => {
      try {
        await this.run(agent, day, now, 'triggered', triggerScore);
      } finally {
        this.thresholdPending.delete(agent.id);
      }
    });
  }

  /** 每个居民每天恰好一份日记；重复调度和恢复后重放均保持幂等。 */
  summarizeDay(agent: Agent, day: number, now: number): Promise<void> {
    const key = `${agent.id}:${day}`;
    if (this.store.dailyReflectionFor(agent.id, day) || this.dailyScheduled.has(key)) return Promise.resolve();
    const triggerScore = this.store.accumulator(agent.id);
    this.store.resetAccumulator(agent.id);
    this.dailyScheduled.add(key);
    return this.enqueue(agent.id, async () => {
      try {
        if (!this.store.dailyReflectionFor(agent.id, day)) {
          await this.run(agent, day, now, 'daily', triggerScore);
        }
      } finally {
        this.dailyScheduled.delete(key);
      }
    });
  }

  async drain(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active]);
  }

  private enqueue(agentId: string, job: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(agentId) ?? Promise.resolve();
    let task: Promise<void>;
    task = previous
      .catch(() => undefined)
      .then(job)
      .catch((error) => console.error('[reflection]', error))
      .finally(() => {
        this.active.delete(task);
        if (this.chains.get(agentId) === task) this.chains.delete(agentId);
      });
    this.chains.set(agentId, task);
    this.active.add(task);
    return task;
  }

  private async run(agent: Agent, day: number, now: number, kind: ReflectionKind, triggerScore: number): Promise<void> {
    const evidence = this.evidenceFor(agent.id, day, kind);
    if (kind === 'triggered' && evidence.length === 0) return;
    const prior = this.store.reflectionsFor(agent.id)[0] ?? null;
    const priorDaily = this.store.previousDailyReflection(agent.id, day);
    const priorInsights = this.store.recentInsights(agent.id, 8);
    const consumedEvidence = kind === 'triggered'
      ? new Set(this.store.reflectionsFor(agent.id)
        .flatMap((record) => record.evidenceIds))
      : new Set<string>();

    const questionResponse = await this.askQuestions(agent.id, evidence.map((item) => item.content));
    const questions = uniqueStrings(questionResponse.questions, 3, 120);
    const candidateInsights: string[] = [];
    const evidenceIds = new Set(evidence.map((item) => item.id));

    for (const question of questions) {
      const questionEvidence = kind === 'daily'
        ? evidence.slice().sort((a, b) => b.importance - a.importance || b.createdGameTime - a.createdGameTime).slice(0, 6)
        : this.store.retrieve(agent.id, question, now, 12)
          .filter((item) => isEventEvidence(item) && !consumedEvidence.has(item.id))
          .slice(0, 6);
      for (const item of questionEvidence) evidenceIds.add(item.id);
      const response = await this.askInsights(agent.id, question, questionEvidence.map((item) => item.content));
      candidateInsights.push(...uniqueStrings(response.insights, 5, 160));
    }

    const boundedEvidence = this.loadEvidence(agent.id, [...evidenceIds], evidence, kind);
    const journalResponse = await this.askJournal(
      agent, day, kind, boundedEvidence, questions, candidateInsights, priorInsights, prior, priorDaily?.diary ?? ''
    );
    const allowedEvidence = new Set(boundedEvidence.map((item) => item.id));
    const insights = uniqueInsightStrings(journalResponse.insights, 5, 180);
    const proposedInsights = boundedEvidence.length
      ? (insights.length ? insights : uniqueInsightStrings(candidateInsights, 5, 180))
      : [];
    const priorInsightKeys = new Set(priorInsights.map(normalizeInsightKey));
    const finalInsights = proposedInsights.filter((insight) => !priorInsightKeys.has(normalizeInsightKey(insight)));
    const mindState = normalizeMindState(journalResponse.mind_state, prior?.mindState ?? initialMindStateOf(agent.persona), boundedEvidence);
    const diary = reflectionDiaryOf(agent, day, boundedEvidence, mindState);
    const revisions = normalizeRevisions(journalResponse.revisions, priorInsights, allowedEvidence);
    const beliefs = normalizeBeliefs(journalResponse.beliefs, finalInsights, revisions, allowedEvidence);
    const guidance = uniqueStrings(journalResponse.behavior_guidance, 5, 180);
    const finalGuidance = guidance.length ? guidance : fallbackGuidance(agent, mindState);
    const reflectionId = randomUUID();

    this.store.addReflection({
      id: reflectionId,
      agentId: agent.id,
      parentId: prior?.id ?? null,
      depth: prior ? prior.depth + 1 : 0,
      kind,
      day,
      questions,
      insights: finalInsights,
      evidenceIds: [...allowedEvidence],
      diary,
      mindState,
      beliefs,
      revisions,
      guidance: finalGuidance,
      version: (prior?.version ?? 0) + 1,
      triggerScore,
      createdGameTime: now,
    });
    for (const insight of finalInsights) {
      this.store.addMemory({
        agentId: agent.id,
        kind: 'insight',
        content: insight,
        importance: 8,
        createdGameTime: now,
        countTowardsReflection: false,
      });
    }
    this.store.addMemory({
      agentId: agent.id,
      kind: 'reflection',
      content: `第${day}天日记：${diary}`,
      importance: kind === 'daily' ? 8 : 7,
      createdGameTime: now,
      countTowardsReflection: false,
    });
    this.log.addEvent(reflectionEvent({
      agent,
      reflectionId,
      kind,
      day,
      now,
      diary,
      insight: finalInsights[0] ?? '',
      mindState,
      guidance: finalGuidance,
      revisions,
      evidenceIds: [...allowedEvidence],
    }));
  }

  private evidenceFor(agentId: string, day: number, kind: ReflectionKind): Memory[] {
    const source = kind === 'daily'
      ? this.store.memoriesForDay(agentId, day, 240)
      : this.store.unreflectedEventMemories(agentId, 100);
    return source
      .filter(isEventEvidence)
      .slice(0, kind === 'daily' ? 240 : 100);
  }

  private loadEvidence(agentId: string, ids: string[], current: Memory[], kind: ReflectionKind): Memory[] {
    const byId = new Map(current.map((item) => [item.id, item]));
    // retrieve() 可能为事件触发反思补充更早证据；recentMemories 提供有界回查。
    for (const item of this.store.recentMemories(agentId, 300).filter(isEventEvidence)) byId.set(item.id, item);
    const resolved = ids.map((id) => byId.get(id)).filter((item): item is Memory => !!item);
    if (kind !== 'daily') return resolved.slice(0, 80);
    return resolved
      .sort((a, b) => b.importance - a.importance || b.createdGameTime - a.createdGameTime)
      .slice(0, 80)
      .sort((a, b) => a.createdGameTime - b.createdGameTime || a.id.localeCompare(b.id));
  }

  private async askQuestions(agentId: string, memories: string[]): Promise<{ questions?: unknown }> {
    const result = await this.llm.complete({
      tier: 'small', template: REFLECTION_QUESTIONS_TEMPLATE, jsonMode: true, maxTokens: 512, temperature: 0.45,
      messages: reflectionQuestionsMessages(memories),
      agentId,
      reasoning: false,
      priority: 'reflection',
      scopeId: this.scopeId,
      timeoutMs: 120_000,
    });
    return (result.parsed ?? {}) as { questions?: unknown };
  }

  private async askInsights(agentId: string, question: string, evidence: string[]): Promise<{ insights?: unknown }> {
    const result = await this.llm.complete({
      tier: 'small', template: REFLECTION_INSIGHTS_TEMPLATE, jsonMode: true, maxTokens: 512, temperature: 0.35,
      messages: reflectionInsightsMessages(question, evidence),
      agentId,
      reasoning: false,
      priority: 'reflection',
      scopeId: this.scopeId,
      timeoutMs: 120_000,
    });
    return (result.parsed ?? {}) as { insights?: unknown };
  }

  private async askJournal(
    agent: Agent,
    day: number,
    kind: ReflectionKind,
    evidence: Memory[],
    questions: string[],
    candidateInsights: string[],
    priorInsights: string[],
    prior: { diary: string; mindState: ReflectionMindState } | null,
    priorDiary: string,
  ): Promise<JournalRaw> {
    const result = await this.llm.complete({
      tier: 'large', template: REFLECTION_JOURNAL_TEMPLATE, jsonMode: true,
      jsonSchema: REFLECTION_JOURNAL_JSON_SCHEMA, maxTokens: 1024, temperature: 0.2,
      messages: reflectionJournalMessages({
        agent,
        day,
        kind,
        evidence: evidence.map((item) => ({ id: item.id, content: item.content, kind: item.kind, importance: item.importance })),
        questions,
        candidateInsights,
        priorInsights,
        priorDiary,
        priorMindState: prior?.mindState ?? null,
      }),
      agentId: agent.id,
      reasoning: false,
      priority: 'reflection',
      scopeId: this.scopeId,
      timeoutMs: 180_000,
    });
    return (result.parsed ?? {}) as JournalRaw;
  }
}

function uniqueStrings(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = textOf(item, maxLength);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function uniqueInsightStrings(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = textOf(item, maxLength);
    const key = normalizeInsightKey(text);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(text);
    }
    if (out.length >= limit) break;
  }
  return out;
}

function textOf(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function finite(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeMindState(raw: unknown, prior: ReflectionMindState | null, evidence: Memory[]): ReflectionMindState {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const fallback = prior ?? fallbackMindState(evidence);
  return {
    valence: finite(value.valence, fallback.valence, -1, 1),
    energy: finite(value.energy, fallback.energy, 0, 1),
    stress: finite(value.stress, fallback.stress, 0, 1),
    socialNeed: finite(value.social_need ?? value.socialNeed, fallback.socialNeed, 0, 1),
    occupationalFocus: finite(value.occupational_focus ?? value.occupationalFocus, fallback.occupationalFocus, 0, 1),
    summary: textOf(value.summary, 180) || fallback.summary,
  };
}

function fallbackMindState(evidence: Memory[]): ReflectionMindState {
  const text = evidence.map((item) => item.content).join('；');
  const negative = (text.match(/失败|争执|拒绝|压力|疲惫|堵住|事故/g) ?? []).length;
  const positive = (text.match(/完成|帮助|愉快|喜欢|成功|感谢/g) ?? []).length;
  const valence = Math.max(-1, Math.min(1, (positive - negative) / Math.max(2, positive + negative)));
  const stress = Math.max(0, Math.min(1, 0.25 + negative * 0.12));
  return {
    valence,
    energy: Math.max(0, Math.min(1, 0.7 - stress * 0.3)),
    stress,
    socialNeed: 0.5,
    occupationalFocus: 0.6,
    summary: `${valence >= 0 ? '情绪较平稳' : '情绪略低'}，${stress >= 0.65 ? '压力偏高' : '压力可控'}。`,
  };
}

function normalizeRevisions(raw: unknown, priorInsights: string[], allowed: Set<string>): InsightRevision[] {
  if (!Array.isArray(raw)) return [];
  const out: InsightRevision[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const previous = textOf(value.previous, 180);
    const revised = textOf(value.revised, 180);
    const reason = textOf(value.reason, 240);
    const evidenceIds = uniqueStrings(value.evidence_ids ?? value.evidenceIds, 12, 80).filter((id) => allowed.has(id));
    if (!previous || !revised || !reason || !priorInsights.includes(previous) || evidenceIds.length === 0) continue;
    out.push({ previous, revised, reason, evidenceIds });
    if (out.length >= 4) break;
  }
  return out;
}

function normalizeBeliefs(
  raw: unknown,
  insights: string[],
  revisions: InsightRevision[],
  allowed: Set<string>,
): BeliefUpdate[] {
  if (allowed.size === 0) return [];
  const rows = Array.isArray(raw) ? raw : [];
  const out: BeliefUpdate[] = [];
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const statement = textOf(value.statement, 180);
    if (!statement) continue;
    const status = value.status === 'reinforced' || value.status === 'revised' ? value.status : 'new';
    const evidenceIds = uniqueStrings(value.evidence_ids ?? value.evidenceIds, 12, 80).filter((id) => allowed.has(id));
    if (evidenceIds.length === 0) continue;
    const supersedes = status === 'revised' ? textOf(value.supersedes, 180) || null : null;
    out.push({ statement, confidence: finite(value.confidence, 0.5, 0, 1), evidenceIds, status, supersedes });
    if (out.length >= 6) break;
  }
  if (out.length) return out;
  return insights.slice(0, 4).map((statement) => {
    const revision = revisions.find((item) => item.revised === statement);
    return {
      statement,
      confidence: allowed.size ? Math.min(0.9, 0.5 + allowed.size * 0.04) : 0.35,
      evidenceIds: [...allowed].slice(0, 12),
      status: revision ? 'revised' : 'new',
      supersedes: revision?.previous ?? null,
    };
  });
}

function isEventEvidence(item: Memory): boolean {
  return item.kind !== 'insight' && item.kind !== 'reflection' && item.kind !== 'plan';
}

function fallbackDiary(agent: Agent, day: number, evidence: Memory[]): string {
  if (!evidence.length) return `第${day}天没有足够的事件证据。我会继续履行${agent.persona.occupation}的职责，并留意自己的判断。`;
  const highlights = evidence.slice(-3).map((item) => item.content).join('；');
  return `今天作为${agent.persona.occupation}，我记得：${highlights}。这些是我对已发生事情的个人理解。`;
}

type DiaryEvidence = Pick<Memory, 'content' | 'importance'> & { createdGameTime?: number };

/** 将客观事件、主观心态与人物价值分层组织，防止模型修辞被误记为发生过的事实。 */
export function reflectionDiaryOf(
  agent: Agent,
  day: number,
  evidence: readonly DiaryEvidence[],
  mindState: ReflectionMindState,
): string {
  if (!evidence.length) return fallbackDiary(agent, day, []);
  const highlights = [...evidence]
    .sort((a, b) => b.importance - a.importance || (b.createdGameTime ?? 0) - (a.createdGameTime ?? 0))
    .slice(0, 4)
    .sort((a, b) => (a.createdGameTime ?? 0) - (b.createdGameTime ?? 0))
    .map((item) => item.content.trim().replace(/\s+/g, ' ').replace(/[。！？；]+$/u, '').slice(0, 220))
    .filter(Boolean);
  const mood = mindState.stress >= 0.65
    ? '我现在有些紧绷，需要放慢判断并核对细节'
    : mindState.valence >= 0.35
      ? '我现在感到踏实，也愿意继续留意新的变化'
      : mindState.valence <= -0.25
        ? '我现在有些低落，需要先照顾好精力再作决定'
        : '我现在心绪平稳，会继续观察自己的判断如何变化';
  const value = agent.persona.values[0]?.trim();
  const valueLine = value ? `我仍然看重「${value}」；` : '';
  const socialLine = mindState.socialNeed >= 0.65 ? '也会主动留意与邻里的联系' : '并依据新的观察修正行动';
  return `第${day}天，我记下：${highlights.join('；')}。${mood}。作为${agent.persona.occupation}，${valueLine}我会把职责放进下一份计划，${socialLine}。`.slice(0, 1200);
}

function fallbackGuidance(agent: Agent, state: ReflectionMindState): string[] {
  return [
    `优先履行${agent.persona.occupation}的核心职责，并检查行动结果。`,
    state.stress >= 0.65 ? '在下一次重要决定前先短暂休息。' : '保持稳定节奏，并对重要互动做出回应。',
  ];
}

function reflectionEvent(input: {
  agent: Agent;
  reflectionId: string;
  kind: ReflectionKind;
  day: number;
  now: number;
  diary: string;
  insight: string;
  mindState: ReflectionMindState;
  guidance: string[];
  revisions: InsightRevision[];
  evidenceIds: string[];
}): GameEvent {
  const label = input.kind === 'daily' ? '写下日记' : '重新思考';
  return {
    id: randomUUID(),
    type: 'system',
    actorId: input.agent.id,
    targetIds: [],
    description: `「${input.agent.name}」${label}：${input.insight || input.diary.slice(0, 100)}`,
    location: null,
    gameTime: input.now,
    payload: {
      kind: 'reflection',
      reflectionKind: input.kind,
      reflectionId: input.reflectionId,
      day: input.day,
      diary: input.diary,
      mindState: input.mindState,
      guidance: input.guidance,
      revisions: input.revisions.length,
      evidenceIds: input.evidenceIds,
    },
  };
}
