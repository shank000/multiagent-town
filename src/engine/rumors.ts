// 谣言追踪：传播链（hops/prev）可查；选择性披露在对话引擎侧把关

import { randomUUID } from 'node:crypto';
import type { DbHandle } from '../store/db';

export interface RumorRow {
  id: string;
  originAgent: string;
  carrierAgent: string;
  content: string;
  hops: number;
  createdGameTime: number;
  prevRumorId: string | null;
}

interface RawRumor {
  id: string; origin_agent: string; carrier_agent: string; content: string;
  hops: number; created_game_time: number; prev_rumor_id: string | null;
}

const toRow = (r: RawRumor): RumorRow => ({
  id: r.id, originAgent: r.origin_agent, carrierAgent: r.carrier_agent,
  content: r.content, hops: r.hops, createdGameTime: r.created_game_time, prevRumorId: r.prev_rumor_id,
});

export class RumorTracker {
  constructor(private db: DbHandle) {}

  seed(originAgent: string, content: string, now: number): string {
    const id = randomUUID();
    this.db.raw.prepare('INSERT INTO rumors(id, origin_agent, carrier_agent, content, hops, created_game_time, prev_rumor_id) VALUES (?, ?, ?, ?, 0, ?, NULL)').run(id, originAgent, originAgent, content, now);
    return id;
  }

  spread(from: string, to: string, rumorId: string, distorted: string, now: number): void {
    const prev = this.db.raw.prepare('SELECT * FROM rumors WHERE id = ?').get(rumorId) as unknown as RawRumor;
    this.db.raw.prepare('INSERT INTO rumors(id, origin_agent, carrier_agent, content, hops, created_game_time, prev_rumor_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), prev.origin_agent, to, distorted, prev.hops + 1, now, rumorId);
  }

  rows(): RumorRow[] {
    return (this.db.raw.prepare('SELECT * FROM rumors ORDER BY created_game_time ASC').all() as unknown as RawRumor[]).map(toRow);
  }

  carriersOf(rumorId: string): string[] {
    // 回溯 prev 链找到 seed，再收集整条传播链（seed + 所有子孙）的 carrier，按时间排序
    const byId = new Map<string, RawRumor>();
    for (const r of this.db.raw.prepare('SELECT * FROM rumors').all() as unknown as RawRumor[]) byId.set(r.id, r);
    let root = byId.get(rumorId);
    while (root && root.prev_rumor_id && byId.has(root.prev_rumor_id)) root = byId.get(root.prev_rumor_id)!;
    if (!root) return [];
    return [...byId.values()]
      .filter((r) => {
        let cur: RawRumor | undefined = r;
        while (cur) {
          if (cur.id === root!.id) return true;
          cur = cur.prev_rumor_id ? byId.get(cur.prev_rumor_id) : undefined;
        }
        return false;
      })
      .sort((a, b) => a.created_game_time - b.created_game_time)
      .map((r) => r.carrier_agent);
  }

  carriedBy(agentId: string): RumorRow[] {
    const rows = this.db.raw.prepare('SELECT * FROM rumors WHERE carrier_agent = ? AND hops = (SELECT MAX(hops) FROM rumors r2 WHERE r2.origin_agent = rumors.origin_agent AND r2.carrier_agent = ?)').all(agentId, agentId) as unknown as RawRumor[];
    return rows.map(toRow);
  }
}
