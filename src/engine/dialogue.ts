// 对话引擎：多轮对话（≤12 轮、每 2 游戏分钟一句）+ 结束摘要写回双方记忆流（spec §5.7）

import { randomUUID } from 'node:crypto';
import type { Agent, GameEvent, WorldObject } from '../core/types';
import type { WorldState } from '../core/world';
import type { EventLog } from '../store/events';
import { keywordSimilarity, type MemoryStore } from '../store/memory';
import type { RelationshipStore } from '../store/relationships';
import type { RumorTracker } from './rumors';
import type { LLMGateway } from '../llm/gateway';
import { DIALOGUE_TEMPLATE, DIALOGUE_SUMMARY_TEMPLATE, dialogueMessages, dialogueSummaryMessages } from '../llm/prompts';
import { personalityOf } from './town-model';
import { assessDialogueTurn, conservativeDialogueReply, dialogueRepairInstruction } from './dialogue-quality';

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
}

interface Pending {
  resolved: { utterance: string; end: boolean; quality: DialogueQualityResult } | null;
  error: string | null;
  queuedAtMs: number;
  dispatchedAtMs: number | null;
  lastQueueWaitMs: number;
}

interface DialogueQualityResult {
  status: 'validated' | 'safe_fallback';
  attempts: number;
  rejectedReasons: string[];
  validator: 'dialogue-turn/v1';
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
}

export interface DialogueStartOptions {
  /** 日常社交默认要求相邻；正式实验可用 arranged 表示已安排的一对一会面。 */
  requireAdjacent?: boolean;
  source?: 'proximity' | 'experiment' | 'manual';
  /** 用于把首轮台词约束在真实地点、物件与可执行功能内。 */
  world?: WorldState;
}

export interface DialogueEngineOptions {
  scopeId?: string;
  turnTimeoutMs?: number;
  turnQueueTimeoutMs?: number;
  summaryTimeoutMs?: number;
  summaryQueueTimeoutMs?: number;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class DialogueEngine {
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Pending>();
  private activeTasks = new Set<Promise<void>>();
  private knownResidentNames = new Set<string>();

  constructor(
    private llm: LLMGateway,
    private store: MemoryStore,
    private log: EventLog,
    private maxRounds = 12,
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

  isActive(aId: string, bId: string): boolean {
    return this.sessions.has(pairKey(aId, bId));
  }

  /** 世界模拟层的移动/决策锁：active 与摘要落库中的 finishing 均视为会话参与。 */
  isParticipantActive(agentId: string): boolean {
    return [...this.sessions.values()].some((session) => (
      session.phase !== 'completed' && (session.a === agentId || session.b === agentId)
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
    this.knownResidentNames.add(a.name);
    this.knownResidentNames.add(b.name);
    const requireAdjacent = options.requireAdjacent ?? true;
    if (a.id === b.id || (requireAdjacent && Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) > 1)) return false;
    if (this.isParticipantActive(a.id) || this.isParticipantActive(b.id)) return false;
    const key = pairKey(a.id, b.id);
    if (this.sessions.has(key)) return false;
    const s: Session = {
      a: a.id, aName: a.name, b: b.id, bName: b.name,
      turns: [], lastUtterAt: now, phase: 'active', conversationId: randomUUID(),
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
      },
    });
    this.speak(a, b, s, now, options.world);
    return true;
  }

  /** 等待已发出的说话与摘要任务落定，保证安全关闭后不再访问数据库。 */
  async drain(): Promise<void> {
    while (this.activeTasks.size > 0) await Promise.allSettled([...this.activeTasks]);
  }

  tick(world: WorldState, dt: number, now: number): void {
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
    };
    this.pending.set(key, entry);
    const task = (async () => {
      try {
        const carried = this.rumors ? this.rumors.carriedBy(speaker.id).map((r) => ({ id: r.id, content: r.content })) : [];
        const relationship = this.rels ? this.rels.getOrCreate(speaker.id, other.id) : null;
        const affection = relationship?.affection ?? 0;
        const honesty = personalityOf(speaker.persona).honesty;
        const latestPrompt = s.turns.at(-1)?.content ?? '';
        const speakerMemories = latestPrompt
          ? this.store.retrieve(speaker.id, latestPrompt, now, 12)
            .filter((item) => keywordSimilarity(latestPrompt, item.content) > 0)
            .slice(0, 8)
            .map((item) => item.content)
          : this.store.recentMemories(speaker.id, 8).map((item) => item.content);
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
          relationshipHistory: relationship?.knowledge.slice(-3) ?? [],
          speakerMemories,
          worldFacts: world ? dialogueWorldFacts(world, speaker) : [],
          conversationId: s.conversationId,
          participants: [s.a, s.b] as [string, string],
          history: s.turns.map((turn, turnIndex) => {
            const speakerName = turn.from === s.a ? s.aName : s.bName;
            const listenerName = turn.from === s.a ? s.bName : s.aName;
            return { turnIndex, speakerName, listenerName, content: turn.content };
          }),
        };
        const baseMessages = dialogueMessages(ctx);
        const qualityEvidence = [
          ...speakerMemories, ...(relationship?.knowledge ?? []), ...carried.map((item) => item.content),
          speaker.persona.background,
        ];
        let rejectedReasons: string[] = [];
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          entry.queuedAtMs = Date.now();
          entry.dispatchedAtMs = null;
          entry.lastQueueWaitMs = 0;
          const messages = baseMessages.map((message) => ({ ...message }));
          if (attempt > 1) messages[messages.length - 1].content += dialogueRepairInstruction(rejectedReasons);
          const res = await this.llm.complete({
            tier: 'small', template: DIALOGUE_TEMPLATE, jsonMode: true, jsonSchema: DIALOGUE_JSON_SCHEMA,
            maxTokens: 192, temperature: attempt === 1 ? 0.25 : 0.1,
            messages, agentId: speaker.id, reasoning: false,
            priority: 'dialogue', scopeId: this.scopeId,
            timeoutMs: this.turnTimeoutMs, queueTimeoutMs: this.turnQueueTimeoutMs,
            onDispatch: (queueWaitMs) => {
              entry.dispatchedAtMs = Date.now();
              entry.lastQueueWaitMs = queueWaitMs;
            },
          });
          const parsed = res.parsed as { utterance?: string; end_dialogue?: boolean } | null;
          const utterance = (parsed?.utterance ?? '').trim().slice(0, 120);
          const assessment = assessDialogueTurn({
            utterance,
            latestPrompt,
            priorTurns: s.turns.map((turn) => turn.content),
            evidence: qualityEvidence,
            speakerName: speaker.name,
            otherName: other.name,
            knownResidentNames: [...this.knownResidentNames],
          });
          if (assessment.ok) {
            entry.resolved = {
              utterance,
              end: !!parsed?.end_dialogue || s.turns.length + 1 >= this.maxRounds,
              quality: { status: 'validated', attempts: attempt, rejectedReasons, validator: 'dialogue-turn/v1' },
            };
            return;
          }
          rejectedReasons = assessment.reasons;
        }
        entry.resolved = {
          utterance: conservativeDialogueReply(latestPrompt, qualityEvidence),
          end: s.turns.length + 1 >= Math.min(this.maxRounds, 4),
          quality: { status: 'safe_fallback', attempts: 2, rejectedReasons, validator: 'dialogue-turn/v1' },
        };
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
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
      this.log.addEvent({
        id: summaryEventId, type: 'chat', actorId: null, targetIds: [s.a, s.b],
        description: `「${s.aName}」和「${s.bName}」的对话结束：${summary}`,
        location: null, gameTime: now,
        payload: { kind: 'chat_summary', line: summary, fromId: s.a, toId: s.b, conversationId: s.conversationId },
      });
      if (this.rels) {
        // 优先消费真机输出的渐进增量（夹紧由 RelationshipStore 负责），缺省 0.1/0.05
        const parsed = (summaryRes?.parsed) as { affection_delta?: number; respect_delta?: number } | null;
        const aD = Number(parsed?.affection_delta ?? 0.1);
        const rD = Number(parsed?.respect_delta ?? 0.05);
        const trustDelta = (Number.isFinite(aD) ? aD : 0) * 0.2 + (Number.isFinite(rD) ? rD : 0) * 0.6;
        const tensionDelta = Math.max(0, -(Number.isFinite(aD) ? aD : 0))
          + Math.max(0, -(Number.isFinite(rD) ? rD : 0));
        for (const [from, to] of [[s.a, s.b], [s.b, s.a]] as const) {
          this.rels.update(from, to, {
            affectionDelta: aD,
            respectDelta: rD,
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
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      try {
        this.store.finishConversation(s.conversationId, 'error', now, { errorText });
      } catch {
        /* 会话锁仍须在最终阶段释放，持久层错误由调用方健康检查捕获。 */
      }
    } finally {
      // 直到摘要、关系证据与会话状态均完成写入后才释放模拟层参与者锁。
      s.phase = 'completed';
    }
  }
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
