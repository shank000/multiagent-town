// 有向关系存储：affection/respect 保持实验兼容；每次变化同时写入不可变证据账本。

import { randomUUID } from 'node:crypto';
import type { DbHandle } from './db';

export interface Relationship {
  agentA: string; // 有向：A 对 B 的看法
  agentB: string;
  knowledge: string[];
  affection: number; // -1..1
  respect: number;   // -1..1
  updatedGameTime: number;
}

export type RelationshipSourceKind =
  | 'dialogue'
  | 'gift_sent'
  | 'gift_received'
  | 'shared_activity'
  | 'observation'
  | 'assistance'
  | 'information_share'
  | 'invitation'
  | 'collaboration'
  | 'manual'
  | 'other';

export interface RelationshipEvidenceSource {
  kind: RelationshipSourceKind;
  /** 与 events.id 对齐；生产事件应提供，手工/测试更新可为空。 */
  eventId?: string | null;
  text: string;
  /** 下列值是显式的社会学代理增量，不改变 affection/respect。 */
  trustDelta?: number;
  supportDelta?: number;
  tensionDelta?: number;
  metadata?: Record<string, unknown>;
}

export interface RelationshipPatch {
  affectionDelta?: number;
  respectDelta?: number;
  knowledge?: string[];
  evidence?: RelationshipEvidenceSource;
}

export interface RelationshipEvidence {
  id: string;
  agentA: string;
  agentB: string;
  sourceKind: RelationshipSourceKind;
  sourceEventId: string | null;
  sourceText: string;
  gameTime: number;
  affectionBefore: number;
  affectionDelta: number;
  affectionAfter: number;
  respectBefore: number;
  respectDelta: number;
  respectAfter: number;
  trustDelta: number;
  supportDelta: number;
  tensionDelta: number;
  metadata: Record<string, unknown>;
}

const MAX_KNOWLEDGE = 20;
const MAX_DELTA = 0.2; // 渐进原则：单次旧维度变动上限
const MAX_PROXY_DELTA = 0.25;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finiteDelta = (value: number | undefined, limit: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, -limit, limit) : 0
);

interface RawRel {
  agent_a: string; agent_b: string; knowledge_json: string;
  affection: number; respect: number; updated_game_time: number;
}

interface RawEvidence {
  id: string; agent_a: string; agent_b: string; source_kind: RelationshipSourceKind;
  source_event_id: string | null; source_text: string; game_time: number;
  affection_before: number; affection_delta: number; affection_after: number;
  respect_before: number; respect_delta: number; respect_after: number;
  trust_delta: number; support_delta: number; tension_delta: number; metadata_json: string;
}

const REL_COLUMNS = 'agent_a, agent_b, knowledge_json, affection, respect, updated_game_time';
const EVIDENCE_COLUMNS = `id, agent_a, agent_b, source_kind, source_event_id, source_text, game_time,
  affection_before, affection_delta, affection_after, respect_before, respect_delta, respect_after,
  trust_delta, support_delta, tension_delta, metadata_json`;

function toRelationship(row: RawRel): Relationship {
  return {
    agentA: row.agent_a,
    agentB: row.agent_b,
    knowledge: JSON.parse(row.knowledge_json) as string[],
    affection: row.affection,
    respect: row.respect,
    updatedGameTime: row.updated_game_time,
  };
}

function toEvidence(row: RawEvidence): RelationshipEvidence {
  return {
    id: row.id,
    agentA: row.agent_a,
    agentB: row.agent_b,
    sourceKind: row.source_kind,
    sourceEventId: row.source_event_id,
    sourceText: row.source_text,
    gameTime: row.game_time,
    affectionBefore: row.affection_before,
    affectionDelta: row.affection_delta,
    affectionAfter: row.affection_after,
    respectBefore: row.respect_before,
    respectDelta: row.respect_delta,
    respectAfter: row.respect_after,
    trustDelta: row.trust_delta,
    supportDelta: row.support_delta,
    tensionDelta: row.tension_delta,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
}

function normalizeEvidenceRange(
  startGameTimeInclusive: number,
  endGameTimeInclusive: number,
): readonly [number, number] | null {
  if (!Number.isFinite(startGameTimeInclusive) || !Number.isFinite(endGameTimeInclusive)) return null;
  const start = Math.max(0, Math.floor(startGameTimeInclusive));
  const end = Math.max(0, Math.floor(endGameTimeInclusive));
  return start <= end ? [start, end] : null;
}

export class RelationshipStore {
  constructor(private db: DbHandle) {}

  getOrCreate(a: string, b: string): Relationship {
    let row = this.db.raw.prepare(`SELECT ${REL_COLUMNS} FROM relationships WHERE agent_a = ? AND agent_b = ?`)
      .get(a, b) as unknown as RawRel | undefined;
    if (!row) {
      this.db.raw.prepare(
        'INSERT INTO relationships(id, agent_a, agent_b, knowledge_json, affection, respect, updated_game_time) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(randomUUID(), a, b, '[]', 0, 0, 0);
      row = this.db.raw.prepare(`SELECT ${REL_COLUMNS} FROM relationships WHERE agent_a = ? AND agent_b = ?`)
        .get(a, b) as unknown as RawRel;
    }
    return toRelationship(row);
  }

  /** 原子更新旧维度并写一条证据；返回的 applied delta 已包含夹紧结果。 */
  update(a: string, b: string, patch: RelationshipPatch, now = 0): RelationshipEvidence {
    const current = this.getOrCreate(a, b);
    const requestedAffection = finiteDelta(patch.affectionDelta, MAX_DELTA);
    const requestedRespect = finiteDelta(patch.respectDelta, MAX_DELTA);
    const affection = clamp(current.affection + requestedAffection, -1, 1);
    const respect = clamp(current.respect + requestedRespect, -1, 1);
    const affectionDelta = affection - current.affection;
    const respectDelta = respect - current.respect;
    const knowledge = [...current.knowledge, ...(patch.knowledge ?? [])].slice(-MAX_KNOWLEDGE);
    const gameTime = Number.isFinite(now) ? Math.max(0, Math.floor(now)) : 0;
    const source = patch.evidence;
    const evidenceId = randomUUID();
    const sourceKind = source?.kind ?? 'manual';
    const sourceText = (source?.text || patch.knowledge?.at(-1) || '关系状态更新').slice(0, 240);
    const trustDelta = finiteDelta(source?.trustDelta, MAX_PROXY_DELTA);
    const supportDelta = finiteDelta(source?.supportDelta, MAX_PROXY_DELTA);
    const inferredTension = Math.max(0, -affectionDelta) + Math.max(0, -respectDelta);
    const tensionDelta = source?.tensionDelta === undefined
      ? clamp(inferredTension, 0, MAX_PROXY_DELTA)
      : clamp(finiteDelta(source.tensionDelta, MAX_PROXY_DELTA), 0, MAX_PROXY_DELTA);
    const metadata = source?.metadata ?? {};

    this.db.raw.exec('BEGIN IMMEDIATE');
    try {
      this.db.raw.prepare(
        `UPDATE relationships SET knowledge_json = ?, affection = ?, respect = ?, updated_game_time = ?
         WHERE agent_a = ? AND agent_b = ?`
      ).run(JSON.stringify(knowledge), affection, respect, gameTime, a, b);
      this.db.raw.prepare(
        `INSERT INTO relationship_evidence(
           id, agent_a, agent_b, source_kind, source_event_id, source_text, game_time,
           affection_before, affection_delta, affection_after, respect_before, respect_delta, respect_after,
           trust_delta, support_delta, tension_delta, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        evidenceId, a, b, sourceKind, source?.eventId ?? null, sourceText, gameTime,
        current.affection, affectionDelta, affection, current.respect, respectDelta, respect,
        trustDelta, supportDelta, tensionDelta, JSON.stringify(metadata)
      );
      this.db.raw.exec('COMMIT');
    } catch (error) {
      this.db.raw.exec('ROLLBACK');
      throw error;
    }

    return {
      id: evidenceId,
      agentA: a,
      agentB: b,
      sourceKind,
      sourceEventId: source?.eventId ?? null,
      sourceText,
      gameTime,
      affectionBefore: current.affection,
      affectionDelta,
      affectionAfter: affection,
      respectBefore: current.respect,
      respectDelta,
      respectAfter: respect,
      trustDelta,
      supportDelta,
      tensionDelta,
      metadata,
    };
  }

  allFor(agentId: string): Relationship[] {
    const rows = this.db.raw.prepare(`SELECT ${REL_COLUMNS} FROM relationships WHERE agent_a = ?`)
      .all(agentId) as unknown as RawRel[];
    return rows.map(toRelationship);
  }

  allPairs(): Relationship[] {
    const rows = this.db.raw.prepare(`SELECT ${REL_COLUMNS} FROM relationships`).all() as unknown as RawRel[];
    return rows.map(toRelationship);
  }

  evidenceFor(agentId: string, otherId?: string, limit = 50): RelationshipEvidence[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = otherId
      ? this.db.raw.prepare(
        `SELECT ${EVIDENCE_COLUMNS} FROM relationship_evidence
         WHERE agent_a = ? AND agent_b = ? ORDER BY game_time DESC, rowid DESC LIMIT ?`
      ).all(agentId, otherId, safeLimit)
      : this.db.raw.prepare(
        `SELECT ${EVIDENCE_COLUMNS} FROM relationship_evidence
         WHERE agent_a = ? ORDER BY game_time DESC, rowid DESC LIMIT ?`
      ).all(agentId, safeLimit);
    return (rows as unknown as RawEvidence[]).map(toEvidence);
  }

  /** 精确读取闭区间 [start, end] 内的全网证据；正式测量输入不设条数上限。 */
  evidenceInGameTimeRange(
    startGameTimeInclusive: number,
    endGameTimeInclusive: number,
  ): RelationshipEvidence[] {
    const range = normalizeEvidenceRange(startGameTimeInclusive, endGameTimeInclusive);
    if (!range) return [];
    const rows = this.db.raw.prepare(
      `SELECT ${EVIDENCE_COLUMNS} FROM relationship_evidence
       WHERE game_time >= ? AND game_time <= ?
       ORDER BY game_time DESC, rowid DESC`
    ).all(...range) as unknown as RawEvidence[];
    return rows.map(toEvidence);
  }

  /** 精确 SQL COUNT；计数口径与 evidenceInGameTimeRange 的闭区间一致。 */
  countEvidenceInGameTimeRange(
    startGameTimeInclusive: number,
    endGameTimeInclusive: number,
  ): number {
    const range = normalizeEvidenceRange(startGameTimeInclusive, endGameTimeInclusive);
    if (!range) return 0;
    const row = this.db.raw.prepare(
      `SELECT COUNT(*) AS count FROM relationship_evidence
       WHERE game_time >= ? AND game_time <= ?`
    ).get(...range) as { count: number };
    return row.count;
  }

  /** 精确读取无向 dyad 两个方向在闭区间内的全部证据。 */
  evidenceForDyadInGameTimeRange(
    agentA: string,
    agentB: string,
    startGameTimeInclusive: number,
    endGameTimeInclusive: number,
  ): RelationshipEvidence[] {
    const range = normalizeEvidenceRange(startGameTimeInclusive, endGameTimeInclusive);
    if (!range || !agentA || !agentB || agentA === agentB) return [];
    const rows = this.db.raw.prepare(
      `SELECT ${EVIDENCE_COLUMNS} FROM relationship_evidence
       WHERE game_time >= ? AND game_time <= ?
         AND ((agent_a = ? AND agent_b = ?) OR (agent_a = ? AND agent_b = ?))
       ORDER BY game_time DESC, rowid DESC`
    ).all(range[0], range[1], agentA, agentB, agentB, agentA) as unknown as RawEvidence[];
    return rows.map(toEvidence);
  }

  /** 精确 SQL COUNT；统计无向 dyad 两个方向在闭区间内的证据行。 */
  countEvidenceForDyadInGameTimeRange(
    agentA: string,
    agentB: string,
    startGameTimeInclusive: number,
    endGameTimeInclusive: number,
  ): number {
    const range = normalizeEvidenceRange(startGameTimeInclusive, endGameTimeInclusive);
    if (!range || !agentA || !agentB || agentA === agentB) return 0;
    const row = this.db.raw.prepare(
      `SELECT COUNT(*) AS count FROM relationship_evidence
       WHERE game_time >= ? AND game_time <= ?
         AND ((agent_a = ? AND agent_b = ?) OR (agent_a = ? AND agent_b = ?))`
    ).get(range[0], range[1], agentA, agentB, agentB, agentA) as { count: number };
    return row.count;
  }

  /** 有界预览读取；正式全量投影使用 evidenceInGameTimeRange。 */
  allEvidence(limit = 20_000): RelationshipEvidence[] {
    const safeLimit = Math.max(1, Math.min(50_000, Math.floor(limit)));
    const rows = this.db.raw.prepare(
      `SELECT ${EVIDENCE_COLUMNS} FROM relationship_evidence
       ORDER BY game_time DESC, rowid DESC LIMIT ?`
    ).all(safeLimit) as unknown as RawEvidence[];
    return rows.map(toEvidence);
  }
}
