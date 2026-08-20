// 对话引擎：多轮对话（≤12 轮、每 2 游戏分钟一句）+ 结束摘要写回双方记忆流（spec §5.7）

import { randomUUID } from 'node:crypto';
import type { Agent, GameEvent } from '../core/types';
import type { WorldState } from '../core/world';
import type { EventLog } from '../store/events';
import type { MemoryStore } from '../store/memory';
import type { RelationshipStore } from '../store/relationships';
import type { RumorTracker } from './rumors';
import type { LLMGateway } from '../llm/gateway';
import { DIALOGUE_TEMPLATE, DIALOGUE_SUMMARY_TEMPLATE, dialogueMessages, dialogueSummaryMessages } from '../llm/prompts';
import { personalityOf } from './town-model';

interface Session {
  a: string; aName: string; b: string; bName: string;
  turns: { from: string; content: string }[];
  lastUtterAt: number;
  ended: boolean;
  conversationId: string;
}

interface Pending { resolved: { utterance: string; end: boolean } | null; error: string | null }

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class DialogueEngine {
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Pending>();

  constructor(
    private llm: LLMGateway,
    private store: MemoryStore,
    private log: EventLog,
    private maxRounds = 12,
    private rels?: RelationshipStore,
    private rumors?: RumorTracker
  ) {}

  isActive(aId: string, bId: string): boolean {
    return this.sessions.has(pairKey(aId, bId));
  }

  start(a: Agent, b: Agent, now: number): void {
    const key = pairKey(a.id, b.id);
    if (this.sessions.has(key)) return;
    const s: Session = { a: a.id, aName: a.name, b: b.id, bName: b.name, turns: [], lastUtterAt: now, ended: false, conversationId: randomUUID() };
    this.sessions.set(key, s);
    this.speak(a, b, s, now);
  }

  tick(world: WorldState, dt: number, now: number): void {
    for (const [key, s] of this.sessions) {
      if (s.ended) {
        this.sessions.delete(key);
        this.pending.delete(key);
        continue;
      }
      const p = this.pending.get(key);
      if (p?.error) {
        this.sessions.delete(key);
        this.pending.delete(key);
        continue;
      }
      if (p?.resolved) {
        this.pending.delete(key);
        this.deliver(s, p.resolved, now);
        continue;
      }
      if (!p && now - s.lastUtterAt >= 2) {
        const speaker = world.getAgent(s.turns.length % 2 === 0 ? s.a : s.b);
        const other = world.getAgent(speaker.id === s.a ? s.b : s.a);
        this.speak(speaker, other, s, now);
      }
    }
  }

  private speak(speaker: Agent, other: Agent, s: Session, now: number): void {
    const key = pairKey(s.a, s.b);
    s.lastUtterAt = now;
    const entry: Pending = { resolved: null, error: null };
    this.pending.set(key, entry);
    void (async () => {
      try {
        const carried = this.rumors ? this.rumors.carriedBy(speaker.id).map((r) => ({ id: r.id, content: r.content })) : [];
        const affection = this.rels ? this.rels.getOrCreate(speaker.id, other.id).affection : 0;
        const honesty = personalityOf(speaker.persona).honesty;
        const ctx = {
          speakerName: speaker.name,
          speakerPool: speaker.persona.greetingPool ?? [],
          otherName: other.name,
          goal: speaker.persona.goals[0] ?? '',
          turns: s.turns.length,
          rumors: carried,
          affection,
          honesty,
        };
        const res = await this.llm.complete({ tier: 'large', template: DIALOGUE_TEMPLATE, jsonMode: true, maxTokens: 256, messages: dialogueMessages(ctx) });
        const parsed = res.parsed as { utterance?: string; end_dialogue?: boolean } | null;
        entry.resolved = {
          utterance: (parsed?.utterance ?? '……').slice(0, 120),
          end: !!parsed?.end_dialogue || s.turns.length + 1 >= this.maxRounds,
        };
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
      }
    })();
  }

  private deliver(s: Session, u: { utterance: string; end: boolean }, now: number): void {
    const fromId = s.turns.length % 2 === 0 ? s.a : s.b;
    const toId = fromId === s.a ? s.b : s.a;
    const fromName = fromId === s.a ? s.aName : s.bName;
    const toName = toId === s.a ? s.aName : s.bName;
    s.turns.push({ from: fromId, content: u.utterance });
    this.log.addEvent({
      id: randomUUID(), type: 'chat', actorId: fromId, targetIds: [toId],
      description: `「${fromName}」对「${toName}」说：「${u.utterance}」`,
      location: null, gameTime: now,
      payload: { kind: 'chat', line: u.utterance, fromId, toId, conversationId: s.conversationId },
    });
    this.store.addMessage({ eventId: null, fromAgent: fromId, toAgent: toId, content: u.utterance, gameTime: now });
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
    if (u.end) void this.finish(s, now);
  }

  private async finish(s: Session, now: number): Promise<void> {
    s.ended = true;
    const lines = s.turns.map((t) => t.content);
    let summary = '两人简单聊了几句。';
    let summaryRes: { parsed: unknown } | null = null;
    try {
      summaryRes = await this.llm.complete({ tier: 'large', template: DIALOGUE_SUMMARY_TEMPLATE, jsonMode: true, maxTokens: 256, messages: dialogueSummaryMessages(lines) });
      summary = (((summaryRes.parsed as { summary?: string } | null)?.summary) ?? summary).slice(0, 100);
    } catch {
      /* 保留默认摘要 */
    }
    if (this.rels) {
      // 优先消费真机输出的渐进增量（夹紧由 RelationshipStore 负责），缺省 0.1/0.05
      const parsed = (summaryRes?.parsed) as { affection_delta?: number; respect_delta?: number } | null;
      const aD = Number(parsed?.affection_delta ?? 0.1);
      const rD = Number(parsed?.respect_delta ?? 0.05);
      this.rels.update(s.a, s.b, { affectionDelta: aD, respectDelta: rD, knowledge: [summary] }, now);
      this.rels.update(s.b, s.a, { affectionDelta: aD, respectDelta: rD, knowledge: [summary] }, now);
    }
    for (const id of [s.a, s.b]) {
      this.store.addMemory({ agentId: id, kind: 'dialogue_summary', content: `第${Math.floor(now / 1440) + 1}天 对话摘要：${summary}`, importance: 7, createdGameTime: now });
    }
    this.log.addEvent({
      id: randomUUID(), type: 'chat', actorId: null, targetIds: [s.a, s.b],
      description: `「${s.aName}」和「${s.bName}」的对话结束：${summary}`,
      location: null, gameTime: now,
      payload: { kind: 'chat_summary', line: summary, fromId: s.a, toId: s.b, conversationId: s.conversationId },
    });
  }
}
