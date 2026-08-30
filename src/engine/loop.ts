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
import { hydrateWorld } from './seed';

export interface LoopHooks {
  onTick?: (clock: ClockState) => void;
  onEvent?: (e: GameEvent) => void;
}

export interface CognitiveBackpressure {
  isBackpressured(): boolean;
}

export class WorldLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeRealtimeStep: Promise<void> | null = null;
  private lastDay = 1;

  constructor(
    public time: TimeEngine,
    public world: WorldState,
    private executor: AgentExecutor,
    private log: EventLog,
    private db: DbHandle,
    private hooks: LoopHooks = {},
    private social?: SocialTicker,
    private mind?: MindEngine,
    private experiment?: { tick(now: number): void },
    private backpressure?: CognitiveBackpressure,
  ) {
    this.log.subscribe((e) => this.hooks.onEvent?.(e));
    this.log.addEvent(systemEvent(0, '第1天开始，小镇从晨光中醒来。'));
    // 世界名册落库：agents/objects 表与内存世界保持一致（统计/回放数据源）
    hydrateWorld(this.db, this.world);
  }

  /** 推进一步（虚拟时钟下可连续调用）；默认 flush 一个宏任务让进行中的决策落定 */
  async step(options: { awaitDecisions?: boolean; realtimeSampling?: boolean } = {}): Promise<void> {
    const dt = this.time.tick();
    const clock = this.time.state;
    for (const agent of this.world.allAgents()) {
      this.executor.progress(agent, dt, clock.totalMinutes, options.realtimeSampling === true);
    }
    this.social?.tick(this.world.allAgents(), dt, clock.totalMinutes, this.world);
    this.mind?.tick(this.world, dt, clock.totalMinutes, options.realtimeSampling === true);
    this.experiment?.tick(clock.totalMinutes);
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
    await this.mind?.drain();
  }

  /** 实时模式：每 0.5s 一个 tick */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.realtimeCycle(!this.isCognitivelyBackpressured());
    }, 500);
  }

  /** 平行世界协调器调用；同一批次明确选择全部推进或全部只结算认知。 */
  realtimeCycle(advanceTime: boolean): Promise<void> {
    if (this.activeRealtimeStep) return this.activeRealtimeStep;
    const task = advanceTime ? this.step({ realtimeSampling: true }) : this.settleCurrent();
    this.activeRealtimeStep = task;
    void task.catch((error) => console.error('[world-loop]', error)).finally(() => {
      if (this.activeRealtimeStep === task) this.activeRealtimeStep = null;
    });
    return task;
  }

  isCognitivelyBackpressured(): boolean {
    return !!(this.backpressure?.isBackpressured() || this.mind?.isBackpressured());
  }

  /** 认知队列拥塞时不推进游戏时间，只结算已完成的动作决策与对话。 */
  private async settleCurrent(): Promise<void> {
    const now = this.time.state.totalMinutes;
    for (const agent of this.world.allAgents()) this.executor.progress(agent, 0, now, true);
    this.mind?.tick(this.world, 0, now, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.hooks.onTick?.(this.time.state);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 停止定时触发后，等待当前 tick 与全部智能体决策完成。 */
  async drain(): Promise<void> {
    if (this.activeRealtimeStep) await Promise.allSettled([this.activeRealtimeStep]);
    await this.executor.drain();
  }
}

interface LoopGroupState {
  loops: WorldLoop[];
  timer: ReturnType<typeof setInterval>;
  activeBatch: Promise<void> | null;
}

const LOOP_GROUPS = new WeakMap<WorldLoop, LoopGroupState>();

/** 三个平行世界共用一次 500ms 批次判定，保证虚拟时钟严格同步。 */
export function startLoopGroup(loops: readonly WorldLoop[]): void {
  const unique = [...new Set(loops)];
  if (!unique.length) return;
  const existing = LOOP_GROUPS.get(unique[0]);
  if (existing) return;
  for (const loop of unique) loop.stop();
  const state: LoopGroupState = {
    loops: unique,
    activeBatch: null,
    timer: setInterval(() => {
      if (state.activeBatch) return;
      const advance = !state.loops.some((loop) => loop.isCognitivelyBackpressured());
      const task = Promise.allSettled(state.loops.map((loop) => loop.realtimeCycle(advance))).then(() => undefined);
      state.activeBatch = task;
      void task.finally(() => {
        if (state.activeBatch === task) state.activeBatch = null;
      });
    }, 500),
  };
  for (const loop of unique) LOOP_GROUPS.set(loop, state);
}

export function stopLoopGroup(loops: readonly WorldLoop[]): void {
  const unique = [...new Set(loops)];
  const state = unique.map((loop) => LOOP_GROUPS.get(loop)).find((value): value is LoopGroupState => !!value);
  if (!state) {
    for (const loop of unique) loop.stop();
    return;
  }
  clearInterval(state.timer);
  for (const loop of state.loops) LOOP_GROUPS.delete(loop);
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
