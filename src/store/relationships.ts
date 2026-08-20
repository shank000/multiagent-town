// 关系存储：有向双维关系（affection/respect，Agentopia 机制）+ knowledge 叙事层

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

export interface RelationshipPatch {
  affectionDelta?: number;
  respectDelta?: number;
  knowledge?: string[];
}

const MAX_KNOWLEDGE = 20;
const MAX_DELTA = 0.2; // 渐进原则：单次变动上限（Agentopia 16 原则之「自然关系推进」）

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface RawRel {
  agent_a: string; agent_b: string; knowledge_json: string;
  affection: number; respect: number; updated_game_time: number;
}

export class RelationshipStore {
  constructor(private db: DbHandle) {}

  getOrCreate(a: string, b: string): Relationship {
    let r = this.db.raw.prepare('SELECT * FROM relationships WHERE agent_a = ? AND agent_b = ?').get(a, b) as unknown as RawRel | undefined;
    if (!r) {
      this.db.raw.prepare('INSERT INTO relationships(id, agent_a, agent_b, knowledge_json, affection, respect, updated_game_time) VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), a, b, '[]', 0, 0, 0);
      r = this.db.raw.prepare('SELECT * FROM relationships WHERE agent_a = ? AND agent_b = ?').get(a, b) as unknown as RawRel;
    }
    return {
      agentA: r.agent_a, agentB: r.agent_b,
      knowledge: JSON.parse(r.knowledge_json) as string[],
      affection: r.affection, respect: r.respect, updatedGameTime: r.updated_game_time,
    };
  }

  update(a: string, b: string, patch: RelationshipPatch, now = 0): void {
    const cur = this.getOrCreate(a, b);
    const affection = clamp(cur.affection + clamp(patch.affectionDelta ?? 0, -MAX_DELTA, MAX_DELTA), -1, 1);
    const respect = clamp(cur.respect + clamp(patch.respectDelta ?? 0, -MAX_DELTA, MAX_DELTA), -1, 1);
    const knowledge = [...cur.knowledge, ...(patch.knowledge ?? [])].slice(-MAX_KNOWLEDGE);
    this.db.raw.prepare('UPDATE relationships SET knowledge_json = ?, affection = ?, respect = ?, updated_game_time = ? WHERE agent_a = ? AND agent_b = ?').run(JSON.stringify(knowledge), affection, respect, now, a, b);
  }

  allFor(agentId: string): Relationship[] {
    const rows = this.db.raw.prepare('SELECT * FROM relationships WHERE agent_a = ?').all(agentId) as unknown as RawRel[];
    return rows.map((r) => ({
      agentA: r.agent_a, agentB: r.agent_b,
      knowledge: JSON.parse(r.knowledge_json) as string[],
      affection: r.affection, respect: r.respect, updatedGameTime: r.updated_game_time,
    }));
  }

  allPairs(): Relationship[] {
    const rows = this.db.raw.prepare('SELECT * FROM relationships').all() as unknown as RawRel[];
    return rows.map((r) => ({
      agentA: r.agent_a, agentB: r.agent_b,
      knowledge: JSON.parse(r.knowledge_json) as string[],
      affection: r.affection, respect: r.respect, updatedGameTime: r.updated_game_time,
    }));
  }
}
