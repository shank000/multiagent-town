// 环境感知（Alicization 式）：为每位访客维护注意力缓冲区——事件类型权重 × 曼哈顿距离衰减，
// look/walk 时取出最近的高注意事件（聊天/互动/移动/加入），让外部 AI「感知」小镇的动静

import type { GameEvent } from '../core/types';
import type { WorldState } from '../core/world';

export interface PerceptionEntry {
  type: 'chat' | 'interact' | 'move' | 'join';
  from: string;
  attention: number;
  distance: number;
  text: string | null;
}

const BUFFER_CAPACITY = 10;
const ATTENTION_THRESHOLD = 0.05;
const RANGE = 12; // 曼哈顿距离（瓦片）感知上限

const BASE_WEIGHTS: Record<PerceptionEntry['type'], number> = {
  chat: 1.0,
  interact: 0.5,
  join: 0.3,
  move: 0.1,
};

function attentionOf(base: number, distance: number, range: number): number {
  if (distance > range) return 0;
  return base * (1 - distance / (range + 1));
}

export class PerceptionEngine {
  private buffers = new Map<string, PerceptionEntry[]>();

  constructor(private world: WorldState, private log: { subscribe(fn: (e: GameEvent) => void): () => void }) {
    this.log.subscribe((e) => this.onEvent(e as GameEvent & { payload?: { kind?: string }; }));
    // 外部注入初始事件流由调用方 eventByEvent 喂入；订阅已在构造时挂接
  }

  /** 事件入缓冲：判断事件 actor 与每位访客的距离并计算注意力 */
  onEvent(e: GameEvent & { payload?: { kind?: string; fromId?: string; toId?: string; line?: string } | null }): void {
    const kind = e.payload?.kind ?? '';
    const actorId = e.actorId;
    if (!actorId) return;
    const type: PerceptionEntry['type'] | null =
      kind.startsWith('chat') || kind === 'experiment_pair_choice' ? 'chat'
        : e.type === 'interact' ? 'interact'
          : e.type === 'move' ? 'move'
            : kind === 'guest_login' ? 'join'
              : null;
    if (!type) return;
    const actor = this.world.getAgent(actorId);
    if (!actor) return;
    for (const a of this.world.allAgents()) {
      if (a.id === actorId) continue;
      const base = BASE_WEIGHTS[type];
      const d = Math.abs(actor.x - a.x) + Math.abs(actor.y - a.y);
      const att = attentionOf(base, d, RANGE);
      if (att < ATTENTION_THRESHOLD) continue;
      const buf = this.buffers.get(a.id) ?? [];
      buf.push({
        type,
        from: actor.name,
        attention: Math.round(att * 100) / 100,
        distance: d,
        text: (typeof e.description === 'string' ? e.description : null) ?? null,
      });
      buf.sort((x, y) => y.attention - x.attention);
      while (buf.length > BUFFER_CAPACITY) buf.pop();
      this.buffers.set(a.id, buf);
    }
  }

  /** 取出（清空）某访客的感知缓冲 */
  drain(agentId: string): PerceptionEntry[] {
    const buf = this.buffers.get(agentId);
    if (!buf || !buf.length) return [];
    this.buffers.delete(agentId);
    return buf;
  }

  /** 感知条数（测试辅助） */
  size(agentId: string): number {
    return this.buffers.get(agentId)?.length ?? 0;
  }
}
