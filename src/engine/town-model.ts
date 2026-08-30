// 公开活动（Agentopia「公开/偶遇活动」机制）：目录轮换生成 → 性格报名 → 成行广播

import { randomUUID } from 'node:crypto';
import type { EventLog } from '../store/events';
import type { WorldState } from '../core/world';
import type { RelationshipStore } from '../store/relationships';
import type { Persona, Personality } from '../core/types';

export const PERSONALITY_DEFAULTS: Personality = { extraversion: 0.5, empathy: 0.5, honesty: 0.5, curiosity: 0.5, patience: 0.5 };

export function personalityOf(p: Persona): Personality {
  return { ...PERSONALITY_DEFAULTS, ...(p.personality ?? {}) };
}

interface CatalogEvent {
  name: string;
  text: string;
  trait: keyof Personality;
}

const CATALOG: CatalogEvent[] = [
  { name: '湖边派对', text: '今晚湖边派对，欢迎所有人！', trait: 'extraversion' },
  { name: '书店读书会', text: '今晚书店读书会，欢迎参加。', trait: 'curiosity' },
  { name: '广场集市', text: '今晚广场集市开张，欢迎来逛！', trait: 'extraversion' },
];

export class TownModel {
  private planned: { event: CatalogEvent; participants: string[] } | null = null;
  private lastDay = 0;
  private lastMinute = 0;

  constructor(private log: EventLog, private rels: RelationshipStore) {}

  tick(world: WorldState, dt: number, now: number): void {
    const day = Math.floor(now / 1440) + 1;
    const minute = now % 1440;
    if (day !== this.lastDay) {
      this.lastDay = day;
      this.planned = null;
    }
    if (this.lastMinute < 300 && minute >= 300) this.plan(world, day);
    if (this.lastMinute < 1170 && minute >= 1170) this.fire(now);
    this.lastMinute = minute;
  }

  private plan(world: WorldState, day: number): void {
    const event = CATALOG[(day - 1) % CATALOG.length];
    const participants = world.allAgents()
      .filter((a) => personalityOf(a.persona)[event.trait] >= 0.6)
      .map((a) => a.id);
    this.planned = { event, participants };
  }

  private fire(now: number): void {
    const p = this.planned;
    this.planned = null;
    if (!p) return;
    if (p.participants.length < 2) {
      this.log.addEvent({
        id: randomUUID(), type: 'system', actorId: null, targetIds: [],
        description: `「${p.event.name}」因报名人数不足而取消。`, location: null, gameTime: now,
        payload: { kind: 'town_event_cancelled', name: p.event.name },
      });
      return;
    }
    const eventId = randomUUID();
    this.log.addEvent({
      id: eventId, type: 'broadcast', actorId: null, targetIds: p.participants,
      description: `小镇广播：${p.event.name}——${p.event.text}`, location: null, gameTime: now,
      payload: { kind: 'town_event', name: p.event.name, text: p.event.text, participants: p.participants },
    });
    // 参与者之间关系升温（渐进）
    for (let i = 0; i < p.participants.length; i++) {
      for (let j = i + 1; j < p.participants.length; j++) {
        for (const [from, to] of [
          [p.participants[i], p.participants[j]],
          [p.participants[j], p.participants[i]],
        ] as const) {
          this.rels.update(from, to, {
            affectionDelta: 0.1,
            evidence: {
              kind: 'shared_activity', eventId,
              text: `共同参加${p.event.name}`,
              metadata: { activity: p.event.name },
            },
          }, now);
        }
      }
    }
  }
}
