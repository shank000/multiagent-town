// 记忆层：记忆流 + 三因子检索（recency/importance/关键词）+ 反思树 + 计划 + 对话消息
// M1-lite 检索：relevance 用中文双字 shingle 的 Jaccard 相似度（用户批准，不引向量）

import { randomUUID } from 'node:crypto';
import type { DbHandle } from './db';

export interface Memory {
  id: string; agentId: string; kind: string; content: string;
  importance: number; createdGameTime: number; lastAccessGameTime: number;
  sourceEventId: string | null;
}

export type ReflectionKind = 'triggered' | 'daily';

export interface ReflectionMindState {
  valence: number;
  energy: number;
  stress: number;
  socialNeed: number;
  occupationalFocus: number;
  summary: string;
}

export interface BeliefUpdate {
  statement: string;
  confidence: number;
  evidenceIds: string[];
  status: 'new' | 'reinforced' | 'revised';
  supersedes: string | null;
}

export interface InsightRevision {
  previous: string;
  revised: string;
  reason: string;
  evidenceIds: string[];
}

export interface ReflectionRecord {
  id: string; agentId: string; parentId: string | null; depth: number;
  questions: string[]; insights: string[]; evidenceIds: string[]; triggerScore: number; createdGameTime: number;
  kind: ReflectionKind; day: number; diary: string; mindState: ReflectionMindState;
  beliefs: BeliefUpdate[]; revisions: InsightRevision[]; guidance: string[]; version: number;
}
export interface AgendaItem { time: string; action: string; location: string }
export interface PlanRecord {
  id: string; agentId: string; day: number; broadPlan: string;
  hourly: AgendaItem[]; status: string; createdGameTime: number;
}

export type ConversationStatus = 'active' | 'completed' | 'error';

export interface ConversationMessage {
  id: string;
  eventId: string | null;
  conversationId: string | null;
  turnIndex: number | null;
  fromAgent: string;
  toAgent: string;
  content: string;
  gameTime: number;
}

export interface ConversationRecord {
  id: string;
  agentA: string;
  agentB: string;
  participants: [string, string];
  status: ConversationStatus;
  startedGameTime: number;
  endedGameTime: number | null;
  turnCount: number;
  summary: string;
  errorText: string;
  updatedGameTime: number;
  messages: ConversationMessage[];
}

export const RECENCY_ALPHA = 0.25;
export const IMPORTANCE_ALPHA = 0.35;
export const RELEVANCE_ALPHA = 0.40;
export const RECENCY_DECAY_PER_MINUTE = 0.995;

export interface MemoryRetrievalScore {
  recency: number;
  importance: number;
  relevance: number;
  total: number;
}

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

/**
 * 可解释的三因子得分。近因只表示证据自创建以来的年龄；lastAccessGameTime
 * 保留为访问审计字段，不参与排序，避免检索行为反过来给旧证据续期。
 */
export function memoryRetrievalScore(
  memory: Pick<Memory, 'content' | 'importance' | 'createdGameTime'>,
  query: string,
  now: number,
): MemoryRetrievalScore {
  const age = Math.max(0, now - memory.createdGameTime);
  const recency = RECENCY_DECAY_PER_MINUTE ** age;
  const importance = memory.importance / 10;
  const relevance = keywordSimilarity(query, memory.content);
  return {
    recency,
    importance,
    relevance,
    total: RECENCY_ALPHA * recency + IMPORTANCE_ALPHA * importance + RELEVANCE_ALPHA * relevance,
  };
}

interface RawMem { id: string; agent_id: string; kind: string; content: string; importance: number; created_game_time: number; last_access_game_time: number; source_event_id: string | null }
interface RawRef {
  id: string; agent_id: string; parent_id: string | null; depth: number;
  reflection_kind: string; day: number; questions_json: string; insights_json: string;
  evidence_ids_json: string; diary_text: string; mind_state_json: string; beliefs_json: string;
  revisions_json: string; guidance_json: string; version: number; trigger_score: number;
  created_game_time: number;
}
interface RawPlan { id: string; agent_id: string; day: number; broad_plan: string; hourly_json: string; status: string; created_game_time: number }
interface RawMsg {
  id: string; event_id: string | null; conversation_id: string | null; turn_index: number | null;
  from_agent: string; to_agent: string; content: string; game_time: number;
}
interface RawConversation {
  id: string; agent_a: string; agent_b: string; status: ConversationStatus;
  started_game_time: number; ended_game_time: number | null; turn_count: number;
  summary: string; error_text: string; updated_game_time: number;
}

function toMessage(row: RawMsg): ConversationMessage {
  return {
    id: row.id,
    eventId: row.event_id,
    conversationId: row.conversation_id,
    turnIndex: row.turn_index,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    content: row.content,
    gameTime: row.game_time,
  };
}

function toMem(r: RawMem): Memory {
  return {
    id: r.id, agentId: r.agent_id, kind: r.kind, content: r.content,
    importance: r.importance, createdGameTime: r.created_game_time,
    lastAccessGameTime: r.last_access_game_time, sourceEventId: r.source_event_id,
  };
}

const DEFAULT_MIND_STATE: ReflectionMindState = {
  valence: 0,
  energy: 0.5,
  stress: 0.3,
  socialNeed: 0.5,
  occupationalFocus: 0.5,
  summary: '心态平稳，继续观察。',
};

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export class MemoryStore {
  private accumulators = new Map<string, number>();

  constructor(private db: DbHandle) {}

  addMemory(m: Omit<Memory, 'id' | 'lastAccessGameTime' | 'sourceEventId'> & {
    id?: string; sourceEventId?: string; countTowardsReflection?: boolean;
  }): void {
    this.db.raw.prepare(
      `INSERT INTO memories(id, agent_id, kind, content, importance, created_game_time, last_access_game_time, source_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(m.id ?? randomUUID(), m.agentId, m.kind, m.content.slice(0, 200), m.importance, m.createdGameTime, m.createdGameTime, m.sourceEventId ?? null);
    if (m.countTowardsReflection !== false) {
      this.accumulators.set(m.agentId, (this.accumulators.get(m.agentId) ?? 0) + m.importance);
    }
  }

  /** 三因子检索：recency 按创建时间衰减；last_access 仅在选中后更新，供审计使用。 */
  retrieve(agentId: string, query: string, now: number, k = 20): Memory[] {
    const rows = this.db.raw.prepare('SELECT * FROM memories WHERE agent_id = ?').all(agentId) as unknown as RawMem[];
    const scored = rows
      .map((r) => {
        const mem = toMem(r);
        return { mem, score: memoryRetrievalScore(mem, query, now).total };
      })
      .sort((x, y) => (
        y.score - x.score
        || y.mem.createdGameTime - x.mem.createdGameTime
        || (x.mem.id < y.mem.id ? -1 : x.mem.id > y.mem.id ? 1 : 0)
      ));
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

  memoriesForDay(agentId: string, day: number, limit = 200): Memory[] {
    const start = (day - 1) * 1440;
    const end = day * 1440;
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const rows = this.db.raw.prepare(
      `SELECT * FROM memories
       WHERE agent_id = ? AND created_game_time >= ? AND created_game_time < ?
       ORDER BY created_game_time ASC, rowid ASC LIMIT ?`
    ).all(agentId, start, end, safeLimit) as unknown as RawMem[];
    return rows.map(toMem);
  }

  countFor(agentId: string): number {
    const row = this.db.raw.prepare('SELECT COUNT(*) AS n FROM memories WHERE agent_id = ?').get(agentId) as { n: number };
    return row.n;
  }

  /** importance 累计（自上次反思起，内存态） */
  accumulator(agentId: string): number { return this.accumulators.get(agentId) ?? 0; }
  resetAccumulator(agentId: string): void { this.accumulators.set(agentId, 0); }

  addReflection(r: Omit<ReflectionRecord,
    'id' | 'kind' | 'day' | 'diary' | 'mindState' | 'beliefs' | 'revisions' | 'guidance' | 'version'
  > & {
    id?: string; kind?: ReflectionKind; day?: number; diary?: string;
    mindState?: ReflectionMindState; beliefs?: BeliefUpdate[]; revisions?: InsightRevision[];
    guidance?: string[]; version?: number;
  }): void {
    this.db.raw.prepare(
      `INSERT INTO reflections(
         id, agent_id, parent_id, depth, reflection_kind, day,
         questions_json, insights_json, evidence_ids_json, diary_text, mind_state_json,
         beliefs_json, revisions_json, guidance_json, version, trigger_score, created_game_time
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      r.id ?? randomUUID(), r.agentId, r.parentId, r.depth, r.kind ?? 'triggered',
      r.day ?? Math.floor(r.createdGameTime / 1440) + 1,
      JSON.stringify(r.questions), JSON.stringify(r.insights), JSON.stringify(r.evidenceIds),
      (r.diary ?? '').slice(0, 1200), JSON.stringify(r.mindState ?? DEFAULT_MIND_STATE),
      JSON.stringify(r.beliefs ?? []), JSON.stringify(r.revisions ?? []), JSON.stringify(r.guidance ?? []),
      r.version ?? 1, r.triggerScore, r.createdGameTime,
    );
  }

  reflectionsFor(agentId: string): ReflectionRecord[] {
    const rows = this.db.raw.prepare('SELECT * FROM reflections WHERE agent_id = ? ORDER BY created_game_time DESC').all(agentId) as unknown as RawRef[];
    return rows.map((r) => ({
      id: r.id, agentId: r.agent_id, parentId: r.parent_id, depth: r.depth,
      kind: r.reflection_kind === 'daily' ? 'daily' : 'triggered',
      day: r.day,
      questions: parseJson(r.questions_json, [] as string[]),
      insights: parseJson(r.insights_json, [] as string[]),
      evidenceIds: parseJson(r.evidence_ids_json, [] as string[]),
      diary: r.diary_text ?? '',
      mindState: parseJson(r.mind_state_json, DEFAULT_MIND_STATE),
      beliefs: parseJson(r.beliefs_json, [] as BeliefUpdate[]),
      revisions: parseJson(r.revisions_json, [] as InsightRevision[]),
      guidance: parseJson(r.guidance_json, [] as string[]),
      version: r.version ?? 1,
      triggerScore: r.trigger_score, createdGameTime: r.created_game_time,
    }));
  }

  dailyReflectionFor(agentId: string, day: number): ReflectionRecord | null {
    return this.reflectionsFor(agentId).find((record) => record.kind === 'daily' && record.day === day) ?? null;
  }

  recentInsights(agentId: string, n: number): string[] {
    const out: string[] = [];
    const superseded = new Set<string>();
    for (const r of this.reflectionsFor(agentId)) {
      for (const revision of r.revisions) superseded.add(revision.previous);
      out.push(...r.insights.filter((insight) => !superseded.has(insight)));
      if (out.length >= n) break;
    }
    return out.slice(0, n);
  }

  recentGuidance(agentId: string, n: number): string[] {
    const out: string[] = [];
    for (const record of this.reflectionsFor(agentId)) {
      for (const item of record.guidance) {
        if (!out.includes(item)) out.push(item);
        if (out.length >= n) return out;
      }
    }
    return out;
  }

  latestMindState(agentId: string): ReflectionMindState | null {
    return this.reflectionsFor(agentId)[0]?.mindState ?? null;
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

  startConversation(c: { id: string; agentA: string; agentB: string; startedGameTime: number }): void {
    this.db.raw.prepare(
      `INSERT INTO conversations(
         id, agent_a, agent_b, status, started_game_time, ended_game_time,
         turn_count, summary, error_text, updated_game_time
       ) VALUES (?, ?, ?, 'active', ?, NULL, 0, '', '', ?)
       ON CONFLICT(id) DO NOTHING`
    ).run(c.id, c.agentA, c.agentB, c.startedGameTime, c.startedGameTime);
  }

  finishConversation(
    id: string,
    status: Exclude<ConversationStatus, 'active'>,
    endedGameTime: number,
    details: { summary?: string; errorText?: string } = {}
  ): void {
    this.db.raw.prepare(
      `UPDATE conversations SET status = ?, ended_game_time = ?, summary = ?, error_text = ?, updated_game_time = ?
       WHERE id = ?`
    ).run(status, endedGameTime, details.summary ?? '', details.errorText ?? '', endedGameTime, id);
  }

  addMessage(m: {
    id?: string; eventId?: string | null; conversationId?: string | null; turnIndex?: number | null;
    fromAgent: string; toAgent: string; content: string; gameTime: number;
  }): void {
    const id = m.id ?? randomUUID();
    this.db.raw.exec('BEGIN IMMEDIATE');
    try {
      this.db.raw.prepare(
        `INSERT INTO messages(id, event_id, from_agent, to_agent, content, game_time, conversation_id, turn_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, m.eventId ?? null, m.fromAgent, m.toAgent, m.content, m.gameTime,
        m.conversationId ?? null, m.turnIndex ?? null
      );
      if (m.conversationId) {
        const turnCount = (m.turnIndex ?? -1) + 1;
        this.db.raw.prepare(
          `UPDATE conversations SET turn_count = MAX(turn_count, ?), updated_game_time = ? WHERE id = ?`
        ).run(turnCount, m.gameTime, m.conversationId);
      }
      this.db.raw.exec('COMMIT');
    } catch (error) {
      this.db.raw.exec('ROLLBACK');
      throw error;
    }
  }

  messagesFor(agentId: string, limit = 50): ConversationMessage[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db.raw.prepare(
      `SELECT id, event_id, conversation_id, turn_index, from_agent, to_agent, content, game_time
       FROM messages WHERE from_agent = ? OR to_agent = ? ORDER BY game_time DESC, rowid DESC LIMIT ?`
    ).all(agentId, agentId, safeLimit) as unknown as RawMsg[];
    return rows.map(toMessage);
  }

  conversationsFor(agentId: string, limit = 20): ConversationRecord[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const conversations = this.db.raw.prepare(
      `SELECT id, agent_a, agent_b, status, started_game_time, ended_game_time,
        turn_count, summary, error_text, updated_game_time
       FROM conversations WHERE agent_a = ? OR agent_b = ?
       ORDER BY updated_game_time DESC, rowid DESC LIMIT ?`
    ).all(agentId, agentId, safeLimit) as unknown as RawConversation[];
    const messages = this.db.raw.prepare(
      `SELECT id, event_id, conversation_id, turn_index, from_agent, to_agent, content, game_time
       FROM messages WHERE conversation_id = ? ORDER BY turn_index ASC, game_time ASC, rowid ASC`
    );
    return conversations.map((conversation) => ({
      id: conversation.id,
      agentA: conversation.agent_a,
      agentB: conversation.agent_b,
      participants: [conversation.agent_a, conversation.agent_b],
      status: conversation.status,
      startedGameTime: conversation.started_game_time,
      endedGameTime: conversation.ended_game_time,
      turnCount: conversation.turn_count,
      summary: conversation.summary,
      errorText: conversation.error_text,
      updatedGameTime: conversation.updated_game_time,
      messages: (messages.all(conversation.id) as unknown as RawMsg[]).map(toMessage),
    }));
  }
}
