// 对话引擎：自然会话保持 4–6 句、每 2 游戏分钟一句，结束后摘要写回双方记忆流（spec §5.7）

import { randomUUID } from 'node:crypto';
import type { Agent, GameEvent, WorldObject } from '../core/types';
import type { WorldState } from '../core/world';
import type { EventLog } from '../store/events';
import { keywordSimilarity, type MemoryStore } from '../store/memory';
import type { RelationshipStore } from '../store/relationships';
import type { RumorTracker } from './rumors';
import type { LLMGateway } from '../llm/gateway';
import type { LLMRequest } from '../llm/types';
import { reviewDialogueTurn, DIALOGUE_REVIEW_TEMPLATE, type DialogueReviewContext, type DialogueReviewResult } from './dialogue-review';
import { DIALOGUE_TEMPLATE, DIALOGUE_SUMMARY_TEMPLATE, dialogueMessages, dialogueSummaryMessages } from '../llm/prompts';
import { personalityOf } from './town-model';
import {
  assessDialogueTurn,
  conservativeDialogueReply,
  dialogueRepairInstruction,
  selectDialogueAnswerEvidence,
  isConversationalEvidence,
} from './dialogue-quality';

const MIN_NATURAL_TURNS = 4;
const MAX_NATURAL_TURNS = 6;

const DIALOGUE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['utterance', 'end_dialogue'],
  properties: {
    utterance: { type: 'string', minLength: 1, maxLength: 120 },
    end_dialogue: { type: 'boolean' },
  },
} as const;

const DIALOGUE_SUMMARY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'affection_delta', 'respect_delta'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 100 },
    affection_delta: { type: 'number', minimum: -0.2, maximum: 0.2 },
    respect_delta: { type: 'number', minimum: -0.2, maximum: 0.2 },
  },
} as const;

interface Session {
  a: string; aName: string; b: string; bName: string;
  turns: { from: string; content: string }[];
  lastUtterAt: number;
  phase: 'active' | 'finishing' | 'completed';
  conversationId: string;
  lifecycle: boolean;
  source: NonNullable<DialogueStartOptions['source']>;
  locationId: string | null;
  requestedGameTime: number;
  openingEvidence: string[];
  evidenceEventIds: string[];
  initiatorId: string;
  triggerReason: NonNullable<DialogueStartOptions['trigger']>['reason'] | null;
}

interface Reservation {
  conversationId: string;
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  requestedGameTime: number;
  locationId: string | null;
  options: DialogueStartOptions;
}

interface Pending {
  resolved: { utterance: string; end: boolean; quality: DialogueQualityResult } | null;
  error: string | null;
  queuedAtMs: number;
  dispatchedAtMs: number | null;
  lastQueueWaitMs: number;
  stage: 'generate' | 'review';
}

interface DialogueReviewAudit {
  candidateKind: 'model' | 'fallback';
  attempt: number;
  utterance: string;
  result: DialogueReviewResult;
}

export interface DialogueQualityResult {
  status: 'validated' | 'safe_fallback';
  attempts: number;
  rejectedReasons: string[];
  validator: 'dialogue-turn/v5';
  semanticReview: { status: 'accepted' | 'not_required'; sourceMemoryIds: string[]; reviews: DialogueReviewAudit[] };
}

export interface ActiveConversation {
  conversationId: string;
  aId: string;
  bId: string;
  speakerId: string | null;
  phase?: 'queued_model' | 'generating_model' | 'ready' | 'summarizing';
  waitMs?: number;
  queueWaitMs?: number;
  generationMs?: number;
  stage?: 'generate' | 'review';
}

export interface DialogueStartOptions {
  /** 日常社交默认要求相邻；正式实验可用 arranged 表示已安排的一对一会面。 */
  requireAdjacent?: boolean;
  source?: 'proximity' | 'experiment' | 'manual';
  /** 用于把首轮台词约束在真实地点、物件与可执行功能内。 */
  world?: WorldState;
  /** 自发会话的现场观察依据；进入提示词与 chat_start 审计，不改写为已经完成的共同经历。 */
  trigger?: {
    initiatorId: string;
    reason: 'co_presence' | 'observed_event';
    evidence: string[];
    evidenceEventIds: string[];
  };
}

export interface DialogueReservation {
  conversationId: string;
  status: 'queued';
}

export interface DialogueEngineOptions {
  scopeId?: string;
  turnTimeoutMs?: number;
  turnQueueTimeoutMs?: number;
  summaryTimeoutMs?: number;
  summaryQueueTimeoutMs?: number;
  /** 自定义工程 provider 可显式演练审校链路；Ollama/API 始终启用。 */
  reviewCustomProvider?: boolean;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class DialogueEngine {
  private sessions = new Map<string, Session>();
  private reservations: Reservation[] = [];
  private pending = new Map<string, Pending>();
  private activeTasks = new Set<Promise<void>>();
  private knownResidentNames = new Set<string>();
  private closed = false;
  private terminationPromise: Promise<void> | null = null;

  constructor(
    private llm: LLMGateway,
    private store: MemoryStore,
    private log: EventLog,
    private maxRounds = MAX_NATURAL_TURNS,
    private rels?: RelationshipStore,
    private rumors?: RumorTracker,
    private options: DialogueEngineOptions = {},
  ) {
    if (!Number.isSafeInteger(this.turnTimeoutMs) || this.turnTimeoutMs <= 0) throw new Error('turnTimeoutMs 必须是正整数');
    if (!Number.isSafeInteger(this.turnQueueTimeoutMs) || this.turnQueueTimeoutMs <= 0) throw new Error('turnQueueTimeoutMs 必须是正整数');
    if (!Number.isSafeInteger(this.summaryTimeoutMs) || this.summaryTimeoutMs <= 0) throw new Error('summaryTimeoutMs 必须是正整数');
    if (!Number.isSafeInteger(this.summaryQueueTimeoutMs) || this.summaryQueueTimeoutMs <= 0) throw new Error('summaryQueueTimeoutMs 必须是正整数');
  }

  private get scopeId(): string { return this.options.scopeId?.trim() || 'default'; }
  private get turnTimeoutMs(): number { return this.options.turnTimeoutMs ?? 90_000; }
  private get turnQueueTimeoutMs(): number { return this.options.turnQueueTimeoutMs ?? 240_000; }
  private get summaryTimeoutMs(): number { return this.options.summaryTimeoutMs ?? 60_000; }
  private get summaryQueueTimeoutMs(): number { return this.options.summaryQueueTimeoutMs ?? 180_000; }
  private get naturalTurnLimit(): number {
    const configured = Number.isSafeInteger(this.maxRounds) ? this.maxRounds : MAX_NATURAL_TURNS;
    return Math.min(MAX_NATURAL_TURNS, Math.max(MIN_NATURAL_TURNS, configured));
  }

  isActive(aId: string, bId: string): boolean {
    return this.sessions.has(pairKey(aId, bId));
  }

  /** 世界模拟层的移动/决策锁：active 与摘要落库中的 finishing 均视为会话参与。 */
  isParticipantActive(agentId: string): boolean {
    return [...this.sessions.values()].some((session) => (
      session.phase !== 'completed' && (session.a === agentId || session.b === agentId)
    ));
  }

  private isParticipantReserved(agentId: string): boolean {
    return this.reservations.some((reservation) => (
      reservation.aId === agentId || reservation.bId === agentId
    ));
  }

  /** 快照用只读投影；不暴露可变 turns/session 引用。 */
  activeSessions(): ActiveConversation[] {
    return [...this.sessions.values()]
      .filter((session) => session.phase !== 'completed')
      .map((session) => {
        const pending = this.pending.get(pairKey(session.a, session.b));
        const phase = session.phase === 'finishing'
          ? 'summarizing'
          : pending
            ? pending.dispatchedAtMs === null ? 'queued_model' : 'generating_model'
            : 'ready';
        const now = Date.now();
        return {
          conversationId: session.conversationId,
          aId: session.a,
          bId: session.b,
          speakerId: phase === 'ready' ? (session.turns.length % 2 === 0 ? session.a : session.b) : null,
          phase,
          stage: pending?.stage,
          waitMs: pending ? Math.max(0, now - pending.queuedAtMs) : 0,
          queueWaitMs: pending
            ? pending.dispatchedAtMs === null ? Math.max(0, now - pending.queuedAtMs) : pending.lastQueueWaitMs
            : 0,
          generationMs: pending?.dispatchedAtMs ? Math.max(0, now - pending.dispatchedAtMs) : 0,
        };
      });
  }

  /** 只有相邻且都未参加其他会话的居民才能开始新会话。 */
  start(a: Agent, b: Agent, now: number, options: DialogueStartOptions = {}): boolean {
    if (this.closed) return false;
    this.knownResidentNames.add(a.name);
    this.knownResidentNames.add(b.name);
    const requireAdjacent = options.requireAdjacent ?? true;
    if (a.id === b.id || (requireAdjacent && Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) > 1)) return false;
    if (this.isParticipantReserved(a.id) || this.isParticipantReserved(b.id)) return false;
    if (this.isParticipantActive(a.id) || this.isParticipantActive(b.id)) return false;
    const key = pairKey(a.id, b.id);
    if (this.sessions.has(key)) return false;
    this.startSession(a, b, now, options, randomUUID(), false);
    return true;
  }

  /**
   * 为一次必须履行的安排会话取得稳定 ID 并进入有序队列。
   * 排队本身不占用参与者锁；实际启动仍复用 start 的会话锁和生成流程。
   */
  reserve(a: Agent, b: Agent, now: number, options: DialogueStartOptions = {}): DialogueReservation {
    if (this.closed) throw new Error('对话引擎已终止，不能新增预留');
    if (a.id === b.id) throw new Error('不能为同一居民预留自我对话');
    const requireAdjacent = options.requireAdjacent ?? true;
    if (requireAdjacent && Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) > 1) {
      throw new Error('相邻会话只能为当前相邻的居民预留');
    }
    this.knownResidentNames.add(a.name);
    this.knownResidentNames.add(b.name);
    const conversationId = randomUUID();
    const reservation: Reservation = {
      conversationId,
      aId: a.id,
      aName: a.name,
      bId: b.id,
      bName: b.name,
      requestedGameTime: now,
      locationId: a.locationId,
      options: { ...options },
    };
    this.reservations.push(reservation);
    this.emitLifecycle(reservation, 'queued', now);
    return { conversationId, status: 'queued' };
  }

  /** 尝试启动所有参与者已空闲的预留；返回本次实际启动数。 */
  dispatchReservations(world: WorldState, now: number): number {
    if (this.closed) return 0;
    return this.startReservations(world, now);
  }

  private startSession(
    a: Agent,
    b: Agent,
    now: number,
    options: DialogueStartOptions,
    conversationId: string,
    lifecycle: boolean,
    requestedGameTime = now,
  ): void {
    const key = pairKey(a.id, b.id);
    const requireAdjacent = options.requireAdjacent ?? true;
    const s: Session = {
      a: a.id, aName: a.name, b: b.id, bName: b.name,
      turns: [], lastUtterAt: now, phase: 'active', conversationId, lifecycle,
      source: options.source ?? 'manual', locationId: a.locationId,
      requestedGameTime,
      openingEvidence: options.trigger?.evidence.slice(0, 3).map((item) => item.slice(0, 180)) ?? [],
      evidenceEventIds: options.trigger?.evidenceEventIds.slice(0, 3) ?? [],
      initiatorId: options.trigger?.initiatorId ?? a.id,
      triggerReason: options.trigger?.reason ?? null,
    };
    this.store.startConversation({ id: s.conversationId, agentA: s.a, agentB: s.b, startedGameTime: now });
    this.sessions.set(key, s);
    this.log.addEvent({
      id: randomUUID(), type: 'chat', actorId: a.id, targetIds: [b.id],
      description: `「${a.name}」和「${b.name}」开始一对一对话`,
      location: a.locationId, gameTime: now,
      payload: {
        kind: 'chat_start', conversationId: s.conversationId,
        fromId: a.id, toId: b.id, source: options.source ?? 'manual',
        arranged: !requireAdjacent,
        initiatorId: s.initiatorId,
        triggerReason: s.triggerReason,
        evidenceEventIds: s.evidenceEventIds,
        openingEvidence: s.openingEvidence,
      },
    });
    if (lifecycle) this.emitLifecycle(s, 'started', now);
    this.speak(a, b, s, now, options.world);
  }

  /** 等待已发出的说话与摘要任务落定，保证安全关闭后不再访问数据库。 */
  async drain(): Promise<void> {
    while (this.activeTasks.size > 0) await Promise.allSettled([...this.activeTasks]);
  }

  /**
   * 世界停止时的唯一会话终止边界：先等模型调用落定，再中断仍活跃的持久化会话，
   * 并让未启动/已启动的安排会话获得兼容的 failed 生命周期审计。
   */
  terminate(now: number, reason = '世界运行结束'): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise;
    this.closed = true;
    const endedGameTime = Math.max(0, Math.floor(Number.isFinite(now) ? now : 0));
    const terminationReason = reason.trim().slice(0, 240) || '世界运行结束';
    this.terminationPromise = this.terminateActive(endedGameTime, terminationReason);
    return this.terminationPromise;
  }

  private async terminateActive(now: number, reason: string): Promise<void> {
    await this.drain();
    for (const [key, session] of this.sessions) {
      if (session.phase !== 'completed') {
        const terminalGameTime = Math.max(now, session.requestedGameTime);
        const interrupted = this.store.interruptConversation(session.conversationId, terminalGameTime, reason);
        if (interrupted && session.lifecycle) {
          this.emitLifecycle(session, 'failed', terminalGameTime, reason, 'interrupted');
        }
        session.phase = 'completed';
      }
      this.pending.delete(key);
    }
    this.sessions.clear();
    for (const reservation of this.reservations) {
      this.emitLifecycle(reservation, 'failed', Math.max(now, reservation.requestedGameTime), reason, 'interrupted');
    }
    this.reservations = [];
  }

  tick(world: WorldState, dt: number, now: number): void {
    if (this.closed) return;
    for (const agent of world.allAgents()) this.knownResidentNames.add(agent.name);
    for (const [key, s] of this.sessions) {
      if (s.phase === 'completed') {
        this.sessions.delete(key);
        this.pending.delete(key);
        continue;
      }
      const p = this.pending.get(key);
      if (p?.error) {
        try {
          this.store.finishConversation(s.conversationId, 'error', now, { errorText: p.error });
          if (s.lifecycle) this.emitLifecycle(s, 'failed', now, p.error);
        } finally {
          s.phase = 'completed';
          this.sessions.delete(key);
          this.pending.delete(key);
        }
        continue;
      }
      if (p?.resolved) {
        this.pending.delete(key);
        this.deliver(s, p.resolved, now);
        continue;
      }
      if (s.phase === 'active' && !p && now - s.lastUtterAt >= 2) {
        const speaker = world.getAgent(s.turns.length % 2 === 0 ? s.a : s.b);
        const other = world.getAgent(speaker.id === s.a ? s.b : s.a);
        this.speak(speaker, other, s, now, world);
      }
    }
    this.dispatchReservations(world, now);
  }

  private startReservations(world: WorldState, now: number): number {
    if (!this.reservations.length) return 0;
    const remaining: Reservation[] = [];
    const deferredParticipants = new Set<string>();
    let started = 0;
    for (const reservation of this.reservations) {
      if (
        deferredParticipants.has(reservation.aId)
        || deferredParticipants.has(reservation.bId)
        || this.isParticipantActive(reservation.aId)
        || this.isParticipantActive(reservation.bId)
      ) {
        remaining.push(reservation);
        deferredParticipants.add(reservation.aId);
        deferredParticipants.add(reservation.bId);
        continue;
      }
      try {
        const a = world.getAgent(reservation.aId);
        const b = world.getAgent(reservation.bId);
        const requireAdjacent = reservation.options.requireAdjacent ?? true;
        if (requireAdjacent && Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) > 1) {
          remaining.push(reservation);
          deferredParticipants.add(reservation.aId);
          deferredParticipants.add(reservation.bId);
          continue;
        }
        this.startSession(
          a,
          b,
          now,
          reservation.options,
          reservation.conversationId,
          true,
          reservation.requestedGameTime,
        );
        started += 1;
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        this.emitLifecycle(reservation, 'failed', now, errorText);
      }
    }
    this.reservations = remaining;
    return started;
  }

  private speak(speaker: Agent, other: Agent, s: Session, now: number, world?: WorldState): void {
    const key = pairKey(s.a, s.b);
    s.lastUtterAt = now;
    const entry: Pending = {
      resolved: null,
      error: null,
      queuedAtMs: Date.now(),
      dispatchedAtMs: null,
      lastQueueWaitMs: 0,
      stage: 'generate',
    };
    this.pending.set(key, entry);
    const task = (async () => {
      const latestPrompt = s.turns.at(-1)?.content ?? '';
      const priorTurns = s.turns.map((turn) => turn.content);
      const minuteOfDay = ((now % 1440) + 1440) % 1440;
      let qualityEvidence: string[] = [];
      let eventEvidence: string[] = [];
      let recentSpeakerUtterances: string[] = [];
      const mode = this.llm.runtimeSnapshot().mode;
      const reviewRequired = mode === 'ollama' || mode === 'api' || (mode === 'custom' && this.options.reviewCustomProvider === true);
      const reviews: DialogueReviewAudit[] = [];
      let sourceMemoryIds: string[] = [];
      let reviewContext: Omit<DialogueReviewContext, 'utterance'> | null = null;
      let executionRemainingMs = this.turnTimeoutMs;
      let queueRemainingMs = this.turnQueueTimeoutMs;
      const completeWithinTurn = async (request: LLMRequest) => {
        if (this.closed) throw new Error('世界正在安全关闭');
        if (reviewRequired && (executionRemainingMs <= 0 || queueRemainingMs <= 0)) throw new Error('本轮生成与审校共用预算已用尽');
        entry.stage = request.template === DIALOGUE_REVIEW_TEMPLATE ? 'review' : 'generate';
        entry.queuedAtMs = Date.now();
        entry.dispatchedAtMs = null;
        entry.lastQueueWaitMs = 0;
        let dispatchedAt: number | null = null;
        try {
          return await this.llm.complete({
            ...request, priority: 'dialogue', scopeId: this.scopeId,
            timeoutMs: reviewRequired ? Math.max(1, Math.floor(executionRemainingMs)) : this.turnTimeoutMs,
            queueTimeoutMs: reviewRequired ? Math.max(1, Math.floor(queueRemainingMs)) : this.turnQueueTimeoutMs,
            onDispatch: (queueWaitMs) => {
              dispatchedAt = Date.now();
              entry.dispatchedAtMs = dispatchedAt;
              entry.lastQueueWaitMs = queueWaitMs;
            },
          });
        } finally {
          const finishedAt = Date.now();
          queueRemainingMs -= (dispatchedAt ?? finishedAt) - entry.queuedAtMs;
          if (dispatchedAt !== null) executionRemainingMs -= finishedAt - dispatchedAt;
        }
      };
      const semanticQuality = (): DialogueQualityResult['semanticReview'] => ({
        status: reviewRequired ? 'accepted' : 'not_required', sourceMemoryIds: [...sourceMemoryIds], reviews: [...reviews],
      });
      const reviewCandidate = async (utterance: string, candidateKind: 'model' | 'fallback', attempt: number): Promise<string[]> => {
        if (!reviewRequired) return [];
        if (!reviewContext) throw new Error('本轮审校上下文未就绪');
        const result = await reviewDialogueTurn({ complete: completeWithinTurn }, { ...reviewContext, utterance }, { agentId: speaker.id, scopeId: this.scopeId });
        const audit = { candidateKind, attempt, utterance, result };
        reviews.push(audit);
        console.info(`[dialogue-review] ${JSON.stringify({ scopeId: this.scopeId, conversationId: s.conversationId, turnIndex: s.turns.length, speakerId: speaker.id, sourceMemoryIds, ...audit })}`);
        if (result.status === 'unavailable') throw new Error(`语义审校未完成：${result.error}`);
        return result.issues.map((issue) => `语义审校 ${issue.kind}：「${issue.quote}」${issue.reason}`);
      };
      const resolveFallback = async (evidence: string[], attempts: number, rejectedReasons: string[], rumorEvidence: string[] = []) => {
        const utterance = conservativeDialogueReply(latestPrompt, evidence, {
          priorTurns, recentSpeakerUtterances, rumorEvidence, speakerName: speaker.name, otherName: other.name,
        });
        const end = s.turns.length + 1 >= MIN_NATURAL_TURNS;
        const assessment = assessDialogueTurn({
          utterance, latestPrompt, priorTurns, minuteOfDay,
          evidence: qualityEvidence, eventEvidence, answerEvidence: selectDialogueAnswerEvidence(latestPrompt, qualityEvidence, priorTurns),
          speakerName: speaker.name, otherName: other.name, endDialogue: end,
          knownResidentNames: [...this.knownResidentNames],
        });
        if (!assessment.ok) {
          entry.error = `对话质量检查未通过：${assessment.reasons.join('；')}`;
          console.warn(`[dialogue-quality] conversation=${s.conversationId} speaker=${speaker.id} reason=${entry.error}`);
          return;
        }
        const semanticReasons = await reviewCandidate(utterance, 'fallback', attempts);
        if (semanticReasons.length) {
          entry.error = `对话兜底未通过语义审校：${semanticReasons.join('；')}`;
          return;
        }
        entry.resolved = { utterance, end, quality: { status: 'safe_fallback', attempts, rejectedReasons, validator: 'dialogue-turn/v5', semanticReview: semanticQuality() } };
      };
      try {
        const carried = this.rumors ? this.rumors.carriedBy(speaker.id).map((r) => ({ id: r.id, content: r.content })) : [];
        const relationship = this.rels ? this.rels.getOrCreate(speaker.id, other.id) : null;
        const affection = relationship?.affection ?? 0;
        const honesty = personalityOf(speaker.persona).honesty;
        const retrievalTopic = priorTurns.slice(-4).join(' ');
        const retrievedMemories = retrievalTopic
          ? this.store.retrieve(speaker.id, retrievalTopic, now, 24)
            .filter((item) => keywordSimilarity(retrievalTopic, item.content) > 0)
          : this.store.recentMemories(speaker.id, 24);
        const observations = retrievedMemories.filter((item) => item.kind === 'observation' && isConversationalEvidence(item.content)).slice(0, 4);
        sourceMemoryIds = observations.map((item) => item.id);
        const speakerMemories = observations.map((item) => item.content);
        recentSpeakerUtterances = this.store.messagesFor(speaker.id, 48)
          .filter((message) => message.fromAgent === speaker.id && message.conversationId !== s.conversationId)
          .slice(0, 6).map((message) => message.content);
        const relationshipHistory = relationship?.knowledge ?? [];
        const worldFacts = world ? dialogueWorldFacts(world, speaker) : [];
        const ctx = {
          speakerName: speaker.name,
          speakerPool: speaker.persona.greetingPool ?? [],
          otherName: other.name,
          goal: speaker.persona.goals[0] ?? '',
          turns: s.turns.length,
          rumors: carried,
          affection,
          honesty,
          speakerPersona: speaker.persona,
          otherPersona: other.persona,
          locationId: speaker.locationId,
          relationshipHistory: relationshipHistory.slice(-3),
          speakerMemories,
          worldFacts,
          openingEvidence: s.openingEvidence.filter(isConversationalEvidence),
          minuteOfDay,
          recentSpeakerUtterances,
          includeMockContext: this.llm.runtimeSnapshot().mode === 'mock',
          conversationId: s.conversationId,
          participants: [s.a, s.b] as [string, string],
          history: s.turns.map((turn, turnIndex) => {
            const speakerName = turn.from === s.a ? s.aName : s.bName;
            const listenerName = turn.from === s.a ? s.bName : s.aName;
            return { turnIndex, speakerName, listenerName, content: turn.content };
          }),
        };
        const baseMessages = dialogueMessages(ctx);
        reviewContext = {
          speaker: { name: speaker.name, occupation: speaker.persona.occupation, background: speaker.persona.background },
          listener: { name: other.name, occupation: other.persona.occupation },
          history: ctx.history.map((turn) => ({ speaker: turn.speakerName, listener: turn.listenerName, content: turn.content })),
          observations: speakerMemories, scene: [...ctx.openingEvidence, ...worldFacts.slice(0, 6)],
          rumors: carried.map((item) => item.content), locationId: speaker.locationId, minuteOfDay,
        };
        const conversationalEvidence = [
          ...speakerMemories,
          ...carried.map((item) => item.content),
          ...worldFacts,
          ...ctx.openingEvidence,
        ];
        qualityEvidence = [
          ...speakerMemories, ...carried.map((item) => item.content), speaker.persona.background,
          ...worldFacts, ...ctx.openingEvidence,
        ];
        eventEvidence = [...speakerMemories, ...ctx.openingEvidence];
        const answerEvidence = selectDialogueAnswerEvidence(latestPrompt, qualityEvidence, priorTurns);
        let rejectedReasons: string[] = [];
        let rejectedUtterance = '';
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const messages = baseMessages.map((message) => ({ ...message }));
          if (attempt > 1) messages[messages.length - 1].content += dialogueRepairInstruction(rejectedReasons, rejectedUtterance);
          const res = await completeWithinTurn({
            tier: 'small', template: DIALOGUE_TEMPLATE, jsonMode: true, jsonSchema: DIALOGUE_JSON_SCHEMA,
            maxTokens: 192, temperature: attempt === 1 ? 0.3 : 0.1,
            messages, agentId: speaker.id, reasoning: false,
          });
          const parsed = res.parsed as { utterance?: string; end_dialogue?: boolean } | null;
          const utterance = typeof parsed?.utterance === 'string' ? parsed.utterance.trim() : '';
          const assessment = assessDialogueTurn({
            utterance,
            latestPrompt,
            priorTurns: s.turns.map((turn) => turn.content),
            recentSpeakerUtterances,
            minuteOfDay,
            evidence: qualityEvidence,
            eventEvidence,
            answerEvidence,
            speakerName: speaker.name,
            otherName: other.name,
            knownResidentNames: [...this.knownResidentNames],
            endDialogue: !!parsed?.end_dialogue,
          });
          if (typeof parsed?.end_dialogue !== 'boolean') assessment.reasons.push('会话结束标记必须为布尔值');
          if (assessment.ok && assessment.reasons.length === 0) {
            assessment.reasons.push(...await reviewCandidate(utterance, 'model', attempt));
          }
          if (assessment.ok && assessment.reasons.length === 0) {
            const nextTurnCount = s.turns.length + 1;
            entry.resolved = {
              utterance,
              end: nextTurnCount >= this.naturalTurnLimit
                || (!!parsed?.end_dialogue && nextTurnCount >= MIN_NATURAL_TURNS),
              quality: { status: 'validated', attempts: attempt, rejectedReasons, validator: 'dialogue-turn/v5', semanticReview: semanticQuality() },
            };
            return;
          }
          rejectedReasons = assessment.reasons;
          rejectedUtterance = utterance;
        }
        await resolveFallback(conversationalEvidence, 2, rejectedReasons, carried.map((item) => item.content));
      } catch (err) {
        const failure = dialogueFailureReason(err);
        if (reviewRequired) {
          entry.error = `对话生成或语义审校未完成：${failure}`;
          console.warn(`[dialogue-review-unavailable] conversation=${s.conversationId} speaker=${speaker.id} reason=${failure}`);
          return;
        }
        await resolveFallback(qualityEvidence.filter(isConversationalEvidence), 1, [failure]);
        console.warn(`[dialogue-fallback] conversation=${s.conversationId} speaker=${speaker.id} reason=${failure}`);
      }
    })();
    this.track(task);
  }

  private deliver(s: Session, u: { utterance: string; end: boolean; quality: DialogueQualityResult }, now: number): void {
    const fromId = s.turns.length % 2 === 0 ? s.a : s.b;
    const toId = fromId === s.a ? s.b : s.a;
    const fromName = fromId === s.a ? s.aName : s.bName;
    const toName = toId === s.a ? s.aName : s.bName;
    const turnIndex = s.turns.length;
    s.turns.push({ from: fromId, content: u.utterance });
    const eventId = randomUUID();
    this.log.addEvent({
      id: eventId, type: 'chat', actorId: fromId, targetIds: [toId],
      description: `「${fromName}」对「${toName}」说：「${u.utterance}」`,
      location: null, gameTime: now,
      payload: {
        kind: 'chat', line: u.utterance, fromId, toId, conversationId: s.conversationId, turnIndex,
        quality: u.quality,
      },
    });
    this.store.addMessage({
      eventId,
      conversationId: s.conversationId,
      turnIndex,
      fromAgent: fromId,
      toAgent: toId,
      content: u.utterance,
      gameTime: now,
    });
    if (this.rumors) {
      // 引擎侧复核选择性披露（真机不依赖 mock 行为）：关系 ≥0.2 才传播
      const affection = this.rels ? this.rels.getOrCreate(fromId, toId).affection : 0.2;
      if (affection >= 0.2) {
        const carried = this.rumors.carriedBy(fromId);
        for (const r of carried) {
          if (u.utterance.includes(r.content.slice(0, 8))) {
            this.rumors.spread(fromId, toId, r.id, u.utterance, now);
          }
        }
      }
    }
    if (u.end) {
      s.phase = 'finishing';
      this.track(this.finish(s, now));
    }
  }

  private track(task: Promise<void>): void {
    this.activeTasks.add(task);
    void task.then(
      () => this.activeTasks.delete(task),
      () => this.activeTasks.delete(task),
    );
  }

  private async finish(s: Session, now: number): Promise<void> {
    const lines = s.turns.map((t) => t.content);
    let summary = '两人简单聊了几句。';
    let summaryRes: { parsed: unknown } | null = null;
    try {
      summaryRes = await this.llm.complete({
        tier: 'small', template: DIALOGUE_SUMMARY_TEMPLATE, jsonMode: true, jsonSchema: DIALOGUE_SUMMARY_JSON_SCHEMA,
        maxTokens: 192, temperature: 0.1,
        messages: dialogueSummaryMessages(lines), agentId: s.a, reasoning: false,
        priority: 'dialogue', scopeId: this.scopeId,
        timeoutMs: this.summaryTimeoutMs, queueTimeoutMs: this.summaryQueueTimeoutMs,
      });
      summary = (((summaryRes.parsed as { summary?: string } | null)?.summary) ?? summary).slice(0, 100);
    } catch {
      /* 保留默认摘要 */
    }
    try {
      const summaryEventId = randomUUID();
      const parsed = (summaryRes?.parsed) as { affection_delta?: number; respect_delta?: number } | null;
      const affectionDelta = finiteRelationshipDelta(parsed?.affection_delta);
      const respectDelta = finiteRelationshipDelta(parsed?.respect_delta);
      const trustDelta = affectionDelta * 0.2 + respectDelta * 0.6;
      const tensionDelta = Math.max(0, -affectionDelta) + Math.max(0, -respectDelta);
      this.log.addEvent({
        id: summaryEventId, type: 'chat', actorId: null, targetIds: [s.a, s.b],
        description: `「${s.aName}」和「${s.bName}」的对话结束：${summary}`,
        location: null, gameTime: now,
        payload: {
          kind: 'chat_summary', line: summary, fromId: s.a, toId: s.b, conversationId: s.conversationId,
          affectionDelta, respectDelta, trustDelta, tensionDelta,
        },
      });
      if (this.rels) {
        // 只消费模型明确返回的有限数值；缺失或无效字段不推断正向关系变化。
        for (const [from, to] of [[s.a, s.b], [s.b, s.a]] as const) {
          this.rels.update(from, to, {
            affectionDelta,
            respectDelta,
            knowledge: [summary],
            evidence: {
              kind: 'dialogue',
              eventId: summaryEventId,
              text: summary,
              trustDelta,
              tensionDelta,
              metadata: { conversationId: s.conversationId },
            },
          }, now);
        }
      }
      for (const id of [s.a, s.b]) {
        this.store.addMemory({ agentId: id, kind: 'dialogue_summary', content: `第${Math.floor(now / 1440) + 1}天 对话摘要：${summary}`, importance: 7, createdGameTime: now });
      }
      this.store.finishConversation(s.conversationId, 'completed', now, { summary });
      if (s.lifecycle) this.emitLifecycle(s, 'completed', now);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      console.warn(`[dialogue-summary] conversation=${s.conversationId} failed: ${errorText}`);
      try {
        this.store.finishConversation(s.conversationId, 'error', now, { errorText });
        if (s.lifecycle) this.emitLifecycle(s, 'failed', now, errorText);
      } catch {
        /* 会话锁仍须在最终阶段释放，持久层错误由调用方健康检查捕获。 */
      }
    } finally {
      // 直到摘要、关系证据与会话状态均完成写入后才释放模拟层参与者锁。
      s.phase = 'completed';
    }
  }

  private emitLifecycle(
    conversation: Pick<Reservation, 'conversationId' | 'aId' | 'aName' | 'bId' | 'bName' | 'locationId' | 'options' | 'requestedGameTime'>
      | Session,
    status: 'queued' | 'started' | 'completed' | 'failed',
    now: number,
    errorText?: string,
    termination?: 'interrupted',
  ): void {
    const reservation = 'aId' in conversation
      ? conversation
      : {
          conversationId: conversation.conversationId,
          aId: conversation.a,
          aName: conversation.aName,
          bId: conversation.b,
          bName: conversation.bName,
          locationId: conversation.locationId,
          options: { source: conversation.source },
          requestedGameTime: conversation.requestedGameTime,
        };
    this.log.addEvent({
      id: randomUUID(),
      type: 'system',
      actorId: reservation.aId,
      targetIds: [reservation.bId],
      description: `「${reservation.aName}」与「${reservation.bName}」的安排会话${lifecycleLabel(status, termination)}`,
      location: reservation.locationId,
      gameTime: now,
      payload: {
        kind: 'dialogue_lifecycle',
        conversationId: reservation.conversationId,
        status,
        fromId: reservation.aId,
        toId: reservation.bId,
        source: reservation.options.source ?? 'manual',
        requestedGameTime: reservation.requestedGameTime,
        waitMinutes: Math.max(0, now - reservation.requestedGameTime),
        ...(errorText ? { errorText } : {}),
        ...(termination ? { termination } : {}),
      },
    });
  }
}

function dialogueFailureReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (text.startsWith('语义审校未完成：')) return text.slice(0, 180);
  if (text === '本轮生成与审校共用预算已用尽' || text === '世界正在安全关闭') return text;
  if (/context|上下文|exceeds the available context size|exceed_context_size/iu.test(text)) return '模型上下文不足';
  if (/queue|排队|执行槽/iu.test(text) && /timeout|期限|未完成|超时/iu.test(text)) return '模型排队或生成超时';
  if (/timeout|期限|未完成|超时/iu.test(text)) return '模型生成超时';
  return '模型调用失败';
}

function lifecycleLabel(status: 'queued' | 'started' | 'completed' | 'failed', termination?: 'interrupted'): string {
  if (status === 'queued') return '已排队';
  if (status === 'started') return '已开始';
  if (status === 'completed') return '已完成';
  if (termination === 'interrupted') return '因世界结束而中断';
  return '执行失败';
}

function dialogueWorldFacts(world: WorldState, speaker: Agent): string[] {
  const current = world.objectAt({ x: speaker.x, y: speaker.y });
  const facts = current
    ? [`当前实际位置：${current.name}${current.description ? `；${current.description}` : ''}`]
    : ['当前实际位置：小镇公共区域'];
  const nearby = world.allObjects()
    .filter((object) => object.affordances?.length && distanceToObject(speaker, object) <= Math.max(3, object.observationRadius ?? 0))
    .sort((left, right) => distanceToObject(speaker, left) - distanceToObject(speaker, right))
    .slice(0, 6);
  for (const object of nearby) {
    facts.push(`现场物件「${object.name}」可执行：${object.affordances!.map((item) => item.verb).join('、')}`);
    if (object.state) facts.push(`现场状态「${object.name}」：${object.state.label}；${object.state.detail}`);
  }
  const mechanisms = world.allObjects()
    .filter((object) => object.affordances?.some((item) => /参加|集市|读书会|派对|购买|订购|配送|赠送/u.test(item.verb)))
    .slice(0, 8)
    .map((object) => `小镇功能「${object.name}」：${object.affordances!.map((item) => item.verb).join('、')}（功能存在不代表事件已经发生）`);
  return [...facts, ...mechanisms];
}

function distanceToObject(agent: Agent, object: WorldObject): number {
  const dx = agent.x < object.x ? object.x - agent.x : agent.x >= object.x + object.w ? agent.x - (object.x + object.w - 1) : 0;
  const dy = agent.y < object.y ? object.y - agent.y : agent.y >= object.y + object.h ? agent.y - (object.y + object.h - 1) : 0;
  return dx + dy;
}

function finiteRelationshipDelta(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(-0.2, Math.min(0.2, value)) : 0;
}
