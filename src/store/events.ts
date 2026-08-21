// 事件日志：写入 events 表 + 通知订阅者（CLI/测试观察）

import type { DbHandle } from './db';
import type { EventType, GameEvent } from '../core/types';

type Subscriber = (e: GameEvent) => void;

interface RawEventRow {
  id: string;
  type: EventType;
  actor_id: string | null;
  target_ids_json: string | null;
  description: string;
  location: string | null;
  game_time: number;
  payload_json: string | null;
}

export class EventLog {
  private subscribers = new Set<Subscriber>();

  constructor(private db: DbHandle) {}

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  addEvent(e: GameEvent): void {
    this.db.raw.prepare(
      `INSERT INTO events(id, type, actor_id, target_ids_json, description, location, game_time, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      e.id, e.type, e.actorId, JSON.stringify(e.targetIds), e.description,
      e.location, e.gameTime, e.payload ? JSON.stringify(e.payload) : null
    );
    for (const fn of this.subscribers) fn(e);
  }

  /** 某天（1 起）的全部事件，按时间升序 */
  eventsForDay(day: number): GameEvent[] {
    return this.eventsBetween((day - 1) * 1440, day * 1440);
  }

  eventsBetween(startGameTime: number, endGameTimeExclusive: number): GameEvent[] {
    const rows = this.db.raw.prepare(
      'SELECT * FROM events WHERE game_time >= ? AND game_time < ? ORDER BY game_time ASC'
    ).all(startGameTime, endGameTimeExclusive) as unknown as RawEventRow[];
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      actorId: r.actor_id,
      targetIds: JSON.parse(r.target_ids_json ?? '[]') as string[],
      description: r.description,
      location: r.location,
      gameTime: r.game_time,
      payload: r.payload_json ? (JSON.parse(r.payload_json) as Record<string, unknown>) : null,
    }));
  }

  count(): number {
    const row = this.db.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    return row.n;
  }
}
