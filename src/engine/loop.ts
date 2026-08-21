// 世界主循环：时间 tick → agent 推进 → 事件落库（design §5.1）

import { randomUUID } from 'node:crypto';
import { TimeEngine, type ClockState } from '../core/time';
import { WorldState } from '../core/world';
import { AgentExecutor } from '../core/state-machine';
import { EventLog } from '../store/events';
import type { DbHandle } from '../store/db';
import type { GameEvent } from '../core/types';
import type { SocialTicker } from './social';
import type { MindEngine } from './mind';

export interface LoopHooks {
  onTick?: (clock: ClockState) => void;
  onEvent?: (e: GameEvent) => void;
}

export class WorldLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastDay = 1;

  constructor(
    public time: TimeEngine,
    public world: WorldState,
    private executor: AgentExecutor,
    private log: EventLog,
    private db: DbHandle,
    private hooks: LoopHooks = {},
    private social?: SocialTicker,
    private mind?: MindEngine
  ) {
    this.log.subscribe((e) => this.hooks.onEvent?.(e));
    this.log.addEvent(systemEvent(0, '第1天开始，小镇从晨光中醒来。'));
  }

  /** 推进一步（虚拟时钟下可连续调用）；默认 flush 一个宏任务让进行中的决策落定 */
  async step(options: { awaitDecisions?: boolean } = {}): Promise<void> {
    const dt = this.time.tick();
    const clock = this.time.state;
    for (const agent of this.world.allAgents()) {
      this.executor.progress(agent, dt, clock.totalMinutes);
    }
    this.social?.tick(this.world.allAgents(), dt, clock.totalMinutes);
    this.mind?.tick(this.world, dt, clock.totalMinutes);
    if (clock.day !== this.lastDay) {
      this.lastDay = clock.day;
      this.log.addEvent(systemEvent(clock.totalMinutes, `第${clock.day}天开始。`));
    }
    if (options.awaitDecisions !== false) {
      await new Promise((r) => setTimeout(r, 0));
    }
    this.db.setMeta('game_time', String(clock.totalMinutes));
    this.hooks.onTick?.(clock);
  }

  /** 虚拟时钟推进到指定总分钟数（验收/测试用） */
  async runUntil(totalMinutes: number): Promise<void> {
    while (this.time.state.totalMinutes < totalMinutes) {
      await this.step();
    }
    // 收尾：结算最后一步仍在进行中的决策，避免 agent 停在 thinking
    await this.settleDecisions();
  }

  /** 结算已落定的决策（不推进时钟），供 runUntil 收尾用 */
  private async settleDecisions(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    const now = this.time.state.totalMinutes;
    for (const agent of this.world.allAgents()) {
      if (agent.state === 'thinking') this.executor.progress(agent, 0, now);
    }
  }

  /** 实时模式：每 0.5s 一个 tick */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.step(); }, 500);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function systemEvent(gameTime: number, description: string): GameEvent {
  return {
    id: randomUUID(),
    type: 'system',
    actorId: null,
    targetIds: [],
    description,
    location: null,
    gameTime,
    payload: { kind: 'day_start' },
  };
}
