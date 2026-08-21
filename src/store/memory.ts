// 记忆层：记忆流 + 三因子检索（recency/importance/关键词）+ 反思树 + 计划 + 对话消息
// M1-lite 检索：relevance 用中文双字 shingle 的 Jaccard 相似度（用户批准，不引向量）

import { randomUUID } from 'node:crypto';
import type { DbHandle } from './db';

export interface Memory {
  id: string; agentId: string; kind: string; content: string;
  importance: number; createdGameTime: number; lastAccessGameTime: number;
}
export interface ReflectionRecord {
  id: string; agentId: string; parentId: string | null; depth: number;
  questions: string[]; insights: string[]; evidenceIds: string[]; triggerScore: number; createdGameTime: number;
}
export interface AgendaItem { time: string; action: string; location: string }
export interface PlanRecord {
  id: string; agentId: string; day: number; broadPlan: string;
  hourly: AgendaItem[]; status: string; createdGameTime: number;
}

export const RECENCY_ALPHA = 0.25;
export const IMPORTANCE_ALPHA = 0.35;
export const RELEVANCE_ALPHA = 0.40;

/** 双字 shingle：去标点空白后滑窗取二元组（中文为主，含字母数字） */
export function shingles(text: string): string[] {
  const normalized = text.replace(/[^\p{Script=Han}a-z0-9]/giu, '');
  const set = new Set<string>();
  for (let i = 0; i + 1 < normalized.length; i++) set.add(normalized.slice(i, i + 2));
  if (normalized.length === 1) set.add(normalized);
  return [...set];
}

/** Jaccard 相似度（0~1） */
export function keywordSimilarity(a: string, b: string): number {
  const A = shingles(a);
  const B = shingles(b);
  if (!A.length || !B.length) return 0;
  const setB = new Set(B);
  let inter = 0;
  for (const s of A) if (setB.has(s)) inter++;
  return inter / (A.length + B.length - inter);
}

interface RawMem { id: string; agent_id: string; kind: string; content: string; importance: number; created_game_time: number; last_access_game_time: number }
interface RawRef { id: string; agent_id: string; parent_id: string | null; depth: number; questions_json: string; insights_json: string; evidence_ids_json: string; trigger_score: number; created_game_time: number }
interface RawPlan { id: string; agent_id: string; day: number; broad_plan: string; hourly_json: string; status: string; created_game_time: number }
interface RawMsg { from_agent: string; to_agent: string; content: string; game_time: number }

function toMem(r: RawMem): Memory {
  return { id: r.id, agentId: r.agent_id, kind: r.kind, content: r.content, importance: r.importance, createdGameTime: r.created_game_time, lastAccessGameTime: r.last_access_game_time };
}

export class MemoryStore {
  private accumulators = new Map<string, number>();

  constructor(private db: DbHandle) {}

  addMemory(m: Omit<Memory, 'id' | 'lastAccessGameTime'> & { id?: string; sourceEventId?: string }): void {
    this.db.raw.prepare(
      `INSERT INTO memories(id, agent_id, kind, content, importance, created_game_time, last_access_game_time, source_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(m.id ?? randomUUID(), m.agentId, m.kind, m.content.slice(0, 200), m.importance, m.createdGameTime, m.createdGameTime, m.sourceEventId ?? null);
    this.accumulators.set(m.agentId, (this.accumulators.get(m.agentId) ?? 0) + m.importance);
  }

  /** 三因子检索：0.25·recency(0.995^Δt) + 0.35·importance/10 + 0.40·关键词Jaccard */
  retrieve(agentId: string, query: string, now: number, k = 20): Memory[] {
    const rows = this.db.raw.prepare('SELECT * FROM memories WHERE agent_id = ?').all(agentId) as unknown as RawMem[];
    const scored = rows
      .map((r) => {
        const mem = toMem(r);
        const recency = 0.995 ** (now - mem.lastAccessGameTime);
        const relevance = keywordSimilarity(query, mem.content);
        const score = RECENCY_ALPHA * recency + IMPORTANCE_ALPHA * (mem.importance / 10) + RELEVANCE_ALPHA * relevance;
        return { mem, score };
      })
      .sort((x, y) => y.score - x.score || y.mem.createdGameTime - x.mem.createdGameTime);
    const top = scored.slice(0, k).map((s) => s.mem);
    const upd = this.db.raw.prepare('UPDATE memories SET last_access_game_time = ? WHERE id = ?');
    for (const m of top) {
      upd.run(now, m.id);
      m.lastAccessGameTime = now;
    }
    return top;
  }

  recentMemories(agentId: string, n: number): Memory[] {
    const rows = this.db.raw.prepare('SELECT * FROM memories WHERE agent_id = ? ORDER BY created_game_time DESC LIMIT ?').all(agentId, n) as unknown as RawMem[];
    return rows.map(toMem);
  }

  countFor(agentId: string): number {
    const row = this.db.raw.prepare('SELECT COUNT(*) AS n FROM memories WHERE agent_id = ?').get(agentId) as { n: number };
    return row.n;
  }

  /** importance 累计（自上次反思起，内存态） */
  accumulator(agentId: string): number { return this.accumulators.get(agentId) ?? 0; }
  resetAccumulator(agentId: string): void { this.accumulators.set(agentId, 0); }

  addReflection(r: Omit<ReflectionRecord, 'id'> & { id?: string }): void {
    this.db.raw.prepare(
      `INSERT INTO reflections(id, agent_id, parent_id, depth, questions_json, insights_json, evidence_ids_json, trigger_score, created_game_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(r.id ?? randomUUID(), r.agentId, r.parentId, r.depth, JSON.stringify(r.questions), JSON.stringify(r.insights), JSON.stringify(r.evidenceIds), r.triggerScore, r.createdGameTime);
  }

  reflectionsFor(agentId: string): ReflectionRecord[] {
    const rows = this.db.raw.prepare('SELECT * FROM reflections WHERE agent_id = ? ORDER BY created_game_time DESC').all(agentId) as unknown as RawRef[];
    return rows.map((r) => ({
      id: r.id, agentId: r.agent_id, parentId: r.parent_id, depth: r.depth,
      questions: JSON.parse(r.questions_json) as string[], insights: JSON.parse(r.insights_json) as string[],
      evidenceIds: JSON.parse(r.evidence_ids_json) as string[], triggerScore: r.trigger_score, createdGameTime: r.created_game_time,
    }));
  }

  recentInsights(agentId: string, n: number): string[] {
    const out: string[] = [];
    for (const r of this.reflectionsFor(agentId)) {
      out.push(...r.insights);
      if (out.length >= n) break;
    }
    return out.slice(0, n);
  }

  /** 同 agent+day upsert */
  savePlan(p: Omit<PlanRecord, 'id'> & { id?: string }): void {
    const existing = this.db.raw.prepare('SELECT id FROM plans WHERE agent_id = ? AND day = ?').get(p.agentId, p.day) as { id: string } | undefined;
    if (existing) {
      this.db.raw.prepare('UPDATE plans SET broad_plan = ?, hourly_json = ?, status = ?, created_game_time = ? WHERE id = ?').run(p.broadPlan, JSON.stringify(p.hourly), p.status, p.createdGameTime, existing.id);
    } else {
      this.db.raw.prepare('INSERT INTO plans(id, agent_id, day, broad_plan, hourly_json, status, created_game_time) VALUES (?, ?, ?, ?, ?, ?, ?)').run(p.id ?? randomUUID(), p.agentId, p.day, p.broadPlan, JSON.stringify(p.hourly), p.status, p.createdGameTime);
    }
  }

  planFor(agentId: string, day: number): PlanRecord | null {
    const r = this.db.raw.prepare('SELECT * FROM plans WHERE agent_id = ? AND day = ? ORDER BY created_game_time DESC LIMIT 1').get(agentId, day) as unknown as RawPlan | undefined;
    if (!r) return null;
    return { id: r.id, agentId: r.agent_id, day: r.day, broadPlan: r.broad_plan, hourly: JSON.parse(r.hourly_json) as AgendaItem[], status: r.status, createdGameTime: r.created_game_time };
  }

  addMessage(m: { id?: string; eventId?: string | null; fromAgent: string; toAgent: string; content: string; gameTime: number }): void {
    this.db.raw.prepare('INSERT INTO messages(id, event_id, from_agent, to_agent, content, game_time) VALUES (?, ?, ?, ?, ?, ?)').run(m.id ?? randomUUID(), m.eventId ?? null, m.fromAgent, m.toAgent, m.content, m.gameTime);
  }

  messagesFor(agentId: string, limit = 50): { fromAgent: string; toAgent: string; content: string; gameTime: number }[] {
    const rows = this.db.raw.prepare('SELECT * FROM messages WHERE from_agent = ? OR to_agent = ? ORDER BY game_time DESC LIMIT ?').all(agentId, agentId, limit) as unknown as RawMsg[];
    return rows.map((r) => ({ fromAgent: r.from_agent, toAgent: r.to_agent, content: r.content, gameTime: r.game_time }));
  }
}
