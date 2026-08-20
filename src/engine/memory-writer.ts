// 事件 → 观察记忆：订阅 EventLog，把有意义的事件转成叙述式记忆并打分入库

import type { EventLog } from '../store/events';
import type { MemoryStore } from '../store/memory';
import type { LLMGateway } from '../llm/gateway';
import { IMPORTANCE_TEMPLATE, importanceMessages } from '../llm/prompts';
import { TimeEngine, MINUTES_PER_DAY } from '../core/time';
import type { GameEvent } from '../core/types';

export class MemoryWriter {
  constructor(private store: MemoryStore, private llm: LLMGateway) {}

  attach(log: EventLog): void {
    log.subscribe((e) => void this.onEvent(e).catch((err) => console.error('[memory-writer]', err)));
  }

  async onEvent(e: GameEvent): Promise<void> {
    if (e.payload?.kind === 'day_start' || e.payload?.kind === 'thought') return;
    // 反思/对话摘要已由引擎直接写入（insight/dialogue_summary），事件不再重复入库
    if (e.payload?.kind === 'reflection' || e.payload?.kind === 'chat_summary') return;
    const day = Math.floor(e.gameTime / MINUTES_PER_DAY) + 1;
    const minute = e.gameTime % MINUTES_PER_DAY;
    const clock = { day, minutesOfDay: minute, totalMinutes: e.gameTime };
    const stamp = `${TimeEngine.format(clock).split(' ')[1]}，`;
    const ids = new Set<string>();
    if (e.actorId) ids.add(e.actorId);
    for (const t of e.targetIds) ids.add(t);
    const payload = e.payload as { fromId?: string; toId?: string } | null;
    if (payload?.fromId) ids.add(payload.fromId);
    if (payload?.toId) ids.add(payload.toId);
    const agentIds = [...ids].filter((id) => id.startsWith('agent:'));
    if (!agentIds.length) return; // 无 agent 参与的事件不打分不写库
    const content = `第${day}天 ${stamp}${e.description}`.slice(0, 200);
    const score = await this.score(content); // 同一事件同一内容只打一次分（chat 双方复用）
    for (const id of agentIds) {
      this.store.addMemory({ agentId: id, kind: 'observation', content, importance: score, createdGameTime: e.gameTime, sourceEventId: e.id });
    }
  }

  private async score(text: string): Promise<number> {
    const res = await this.llm.complete({ tier: 'small', template: IMPORTANCE_TEMPLATE, jsonMode: true, maxTokens: 64, messages: importanceMessages(text) });
    const n = (res.parsed as { importance?: number } | null)?.importance;
    return typeof n === 'number' && Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 5;
  }
}
