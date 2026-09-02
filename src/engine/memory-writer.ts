// 事件 → 观察记忆：订阅 EventLog，把有意义的事件转成叙述式记忆并打分入库

import type { EventLog } from '../store/events';
import type { MemoryStore } from '../store/memory';
import type { LLMGateway } from '../llm/gateway';
import { TimeEngine, MINUTES_PER_DAY } from '../core/time';
import type { GameEvent } from '../core/types';

export class MemoryWriter {
  private pending = new Set<Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private scoredEvents = 0;

  constructor(private store: MemoryStore, _llm: LLMGateway, _scopeId = 'default') {}

  budgetSnapshot(): { deterministicImportanceScores: number; modelImportanceRequests: 0 } {
    return { deterministicImportanceScores: this.scoredEvents, modelImportanceRequests: 0 };
  }

  attach(log: EventLog): void {
    this.detach();
    this.unsubscribe = log.subscribe((e) => {
      const task = this.onEvent(e).catch((err) => console.error('[memory-writer]', err));
      this.pending.add(task);
      void task.then(() => this.pending.delete(task));
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** 等待当前已接收事件全部写入，供测试与受控关闭安全落盘。 */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }

  async onEvent(e: GameEvent): Promise<void> {
    if (
      e.payload?.kind === 'day_start'
      || e.payload?.kind === 'thought'
      || e.payload?.kind === 'action_decision_quality'
      || e.payload?.kind === 'dialogue_lifecycle'
    ) return;
    // 反思/对话摘要已由引擎直接写入（insight/dialogue_summary），事件不再重复入库
    if (e.payload?.kind === 'reflection' || e.payload?.kind === 'chat_summary') return;
    const day = Math.floor(e.gameTime / MINUTES_PER_DAY) + 1;
    const minute = e.gameTime % MINUTES_PER_DAY;
    const clock = { day, minutesOfDay: minute, totalMinutes: e.gameTime };
    const stamp = `${TimeEngine.format(clock).split(' ')[1]}，`;
    const payload = e.payload as { fromId?: string; toId?: string; memoryAgentIds?: unknown } | null;
    const explicitMemoryIds = Array.isArray(payload?.memoryAgentIds)
      ? payload.memoryAgentIds.filter((id): id is string => typeof id === 'string')
      : null;
    const ids = new Set<string>();
    if (explicitMemoryIds) {
      for (const id of explicitMemoryIds) ids.add(id);
    } else {
      if (e.actorId) ids.add(e.actorId);
      for (const t of e.targetIds) ids.add(t);
      if (payload?.fromId) ids.add(payload.fromId);
      if (payload?.toId) ids.add(payload.toId);
    }
    const agentIds = [...ids].filter((id) => id.startsWith('agent:'));
    if (!agentIds.length) return; // 无 agent 参与的事件不打分不写库
    const content = `第${day}天 ${stamp}${e.description}`.slice(0, 200);
    const score = scoreGameEventImportance(e); // 同一事件只做一次确定性评分（chat 双方复用）
    this.scoredEvents += 1;
    for (const id of agentIds) {
      this.store.addMemory({ agentId: id, kind: 'observation', content, importance: score, createdGameTime: e.gameTime, sourceEventId: e.id });
    }
  }

}

/**
 * Stable 1..10 event importance. Only typed event fields, bounded payload labels and a bounded
 * description slice participate, so repeated scoring never depends on provider availability.
 */
export function scoreGameEventImportance(event: GameEvent): number {
  const payload = event.payload ?? {};
  const kind = boundedCue(payload.kind);
  const source = boundedCue(payload.source);
  const outcome = boundedCue(payload.outcome);
  const cue = `${kind} ${source} ${outcome} ${event.description.slice(0, 180)}`;

  if (
    /partner_choice|伙伴选择|馈礼|gift|冲突|conflict|拒绝|refusal|背叛|失去|秘密泄露/u.test(cue)
  ) return 9;
  if (
    /verified_shared_activity|活动现场|已核验|共同完成|履约|约定达成|关系转折/u.test(cue)
  ) return 8;
  if (event.type === 'player' || /玩家指令|紧急|事故|重要决定/u.test(cue)) return 8;
  if (event.type === 'chat' || /chat|对话|邀请|帮助|拜访|共同活动/u.test(cue)) return 6;
  if (event.type === 'broadcast' || /公告|预告|关系|约定|选择/u.test(cue)) return 6;
  if (event.type === 'move' || /到达|前往|散步|回家/u.test(cue)) return 3;
  if (/work|工作|营业|值班|煮咖啡|送信/u.test(cue)) return 4;
  if (/rest|idle|休息|观察周围|吃饭|睡觉/u.test(cue)) return 2;
  if (event.type === 'interact') return 5;
  return 4;
}

function boundedCue(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 80) : '';
}
