// 社交闲聊：相邻 NPC 累计一定游戏分钟后触发一句打招呼（M2-lite；真对话引擎在 M1）
// 事件走既有 EventLog（type=chat），供浏览器气泡与回放展示

import { randomUUID } from 'node:crypto';
import type { Agent, GameEvent } from '../core/types';
import type { EventLog } from '../store/events';

export interface SocialConfig {
  minProximityMinutes?: number; // 相邻累计多少游戏分钟触发（默认 3）
  cooldownMinutes?: number;     // 同一对触发后冷却（默认 90）
}

const GENERIC_GREETINGS = ['你好呀！', '今天天气真不错。', '最近忙什么呢？', '有阵子没见啦。'];

export class SocialTicker {
  private proximity = new Map<string, number>();
  private nextAt = new Map<string, number>();
  private triggerCount = new Map<string, number>();

  constructor(private log: EventLog, private cfg: SocialConfig = {}) {}

  /** 每 tick 调用一次；dt = 本次推进的游戏分钟数 */
  tick(agents: Agent[], dt: number, now: number): void {
    const min = this.cfg.minProximityMinutes ?? 3;
    const cooldown = this.cfg.cooldownMinutes ?? 90;
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i];
        const b = agents[j];
        const key = pairKey(a.id, b.id);
        if (chebyshev(a, b) <= 1) {
          this.proximity.set(key, (this.proximity.get(key) ?? 0) + dt);
        } else {
          this.proximity.set(key, 0);
          continue;
        }
        if (this.proximity.get(key)! >= min && now >= (this.nextAt.get(key) ?? 0)) {
          const count = this.triggerCount.get(key) ?? 0;
          const line = pickLine(a, count);
          this.log.addEvent(makeChatEvent(a, b, line, now));
          this.proximity.set(key, 0);
          this.nextAt.set(key, now + cooldown);
          this.triggerCount.set(key, count + 1);
        }
      }
    }
  }
}

function pairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

function chebyshev(a: Agent, b: Agent): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function pickLine(a: Agent, count: number): string {
  const pool = a.persona.greetingPool?.length ? a.persona.greetingPool : GENERIC_GREETINGS;
  return pool[count % pool.length];
}

function makeChatEvent(a: Agent, b: Agent, line: string, now: number): GameEvent {
  return {
    id: randomUUID(),
    type: 'chat',
    actorId: a.id,
    targetIds: [b.id],
    description: `「${a.name}」对「${b.name}」说：「${line}」`,
    location: a.locationId,
    gameTime: now,
    payload: { kind: 'chat', line, fromId: a.id, toId: b.id },
  };
}
