// MindEngine：M1 认知核心门面——记忆/规划/反思/对话，作为可选参数注入循环与执行器

import { MINUTES_PER_DAY } from '../core/time';
import type { WorldState } from '../core/world';
import type { Agent } from '../core/types';
import type { DbHandle } from '../store/db';
import type { EventLog } from '../store/events';
import type { LLMGateway } from '../llm/gateway';
import { MemoryStore } from '../store/memory';
import { Planner } from '../llm/planner';
import { MemoryWriter } from './memory-writer';
import { ReflectionEngine } from './reflection';

export interface MindEngineOptions {
  db: DbHandle;
  llm: LLMGateway;
  log: EventLog;
}

/** 对话先以结构化接口占位（Task 7 装配为具体实现，避免跨任务 import） */
interface DialogueLike { tick(world: WorldState, dt: number, now: number): void }

export class MindEngine {
  readonly store: MemoryStore;
  readonly planner: Planner;
  readonly reflection: ReflectionEngine;
  dialogue?: DialogueLike;
  private writer: MemoryWriter;
  private lastMinute = 0;

  constructor(opts: MindEngineOptions) {
    this.store = new MemoryStore(opts.db);
    this.planner = new Planner(opts.llm, this.store);
    this.reflection = new ReflectionEngine(opts.llm, this.store, opts.log);
    this.dialogue = undefined;   // Task 7 装配
    this.writer = new MemoryWriter(this.store, opts.llm);
    this.writer.attach(opts.log);
  }

  tick(world: WorldState, dt: number, now: number): void {
    const day = Math.floor(now / MINUTES_PER_DAY) + 1;
    const minute = now % MINUTES_PER_DAY;
    const hour = Math.floor(minute / 60);
    if (this.lastMinute < 300 && minute >= 300) {
      // 跨 5:00：先日计划、完成后再小时分解（避免同 tick 竞争覆盖 plans 行）
      for (const a of world.allAgents()) {
        void this.planner.dailyPlan(a, day, now)
          .catch((err) => console.error('[planner] dailyPlan', err))
          .then(() => this.planner.decomposeHour(a, day, hour, now))
          .catch((err) => console.error('[planner] decomposeHour', err));
      }
    } else if (hour !== Math.floor(this.lastMinute / 60)) {
      for (const a of world.allAgents()) {
        void this.planner.decomposeHour(a, day, hour, now).catch((err) => console.error('[planner] decomposeHour', err));
      }
    }
    this.lastMinute = minute;
    for (const a of world.allAgents()) this.reflection?.tick(a, day, now);
    this.dialogue?.tick(world, dt, now);
  }
}
