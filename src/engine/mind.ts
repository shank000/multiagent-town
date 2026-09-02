// MindEngine：M1 认知核心门面——记忆/规划/反思/对话，作为可选参数注入循环与执行器

import { MINUTES_PER_DAY } from '../core/time';
import type { WorldState } from '../core/world';
import type { Agent } from '../core/types';
import type { DbHandle } from '../store/db';
import type { EventLog } from '../store/events';
import type { LLMGateway } from '../llm/gateway';
import { MemoryStore } from '../store/memory';
import { RelationshipStore } from '../store/relationships';
import { Planner } from '../llm/planner';
import { MemoryWriter } from './memory-writer';
import { ReflectionEngine } from './reflection';
import { DialogueEngine } from './dialogue';
import { RumorTracker } from './rumors';
import { TownModel, validateTownModelCheckpoint, type TownModelCheckpoint } from './town-model';
import { TownLifeEngine, validateTownLifeCheckpoint, type TownLifeCheckpoint } from './town-life';

export interface MindEngineOptions {
  db: DbHandle;
  llm: LLMGateway;
  log: EventLog;
  scopeId?: string;
  townModelSeed?: number | string;
}

export interface MindDisposeOptions {
  gameTime?: number;
  reason?: string;
}

export interface MindRuntimeCheckpoint {
  schemaVersion: 1;
  lastGameTime: number;
  lastDailyPlanBoundary: number | null;
  lastHourPlanBoundary: number | null;
  lastDailyReflectionBoundary: number | null;
  townModel: TownModelCheckpoint;
  townLife: TownLifeCheckpoint;
}

export class MindEngine {
  readonly store: MemoryStore;
  readonly planner: Planner;
  readonly reflection: ReflectionEngine;
  readonly dialogue: DialogueEngine;
  readonly rels: RelationshipStore;
  readonly rumors: RumorTracker;
  readonly townModel: TownModel;
  readonly townLife: TownLifeEngine;
  private writer: MemoryWriter;
  private pendingDaily = new Set<Promise<void>>();
  private lastDailyPlanBoundary = Number.NEGATIVE_INFINITY;
  private lastHourPlanBoundary = Number.NEGATIVE_INFINITY;
  private lastDailyReflectionBoundary = Number.NEGATIVE_INFINITY;
  private lastGameTime = 0;
  private disposePromise: Promise<void> | null = null;

  constructor(opts: MindEngineOptions) {
    this.store = new MemoryStore(opts.db);
    const scopeId = opts.scopeId?.trim() || 'default';
    this.planner = new Planner(opts.llm, this.store, scopeId);
    this.reflection = new ReflectionEngine(opts.llm, this.store, opts.log, scopeId);
    this.writer = new MemoryWriter(this.store, opts.llm, scopeId);
    this.writer.attach(opts.log);
    this.rels = new RelationshipStore(opts.db);
    this.rumors = new RumorTracker(opts.db);
    this.dialogue = new DialogueEngine(opts.llm, this.store, opts.log, 6, this.rels, this.rumors, { scopeId });
    this.townModel = new TownModel(opts.log, this.rels, { seed: opts.townModelSeed ?? scopeId });
    this.townLife = new TownLifeEngine(opts.log);
  }

  tick(world: WorldState, dt: number, now: number, realtimeSampling = false): void {
    this.planner.bindWorld(world);
    this.lastGameTime = Math.max(this.lastGameTime, now);
    const day = Math.floor(now / MINUTES_PER_DAY) + 1;
    const minute = now % MINUTES_PER_DAY;
    const previousTotal = Math.max(0, now - dt);
    for (
      let boundary = (Math.floor(previousTotal / MINUTES_PER_DAY) + 1) * MINUTES_PER_DAY;
      boundary <= now;
      boundary += MINUTES_PER_DAY
    ) {
      if (boundary <= this.lastDailyReflectionBoundary) continue;
      this.lastDailyReflectionBoundary = boundary;
      const completedDay = boundary / MINUTES_PER_DAY;
      for (const agent of world.allAgents()) this.scheduleDailyReflection(agent, completedDay, boundary - 1);
    }
    const dailyPlanBoundaries: number[] = [];
    for (let boundary = nextDailyBoundary(previousTotal, 300); boundary <= now; boundary += MINUTES_PER_DAY) {
      dailyPlanBoundaries.push(boundary);
    }
    const latestDailyBoundary = dailyPlanBoundaries.at(-1);
    if (latestDailyBoundary !== undefined) {
      if (latestDailyBoundary > this.lastDailyPlanBoundary) {
        this.lastDailyPlanBoundary = latestDailyBoundary;
        this.lastHourPlanBoundary = Math.max(this.lastHourPlanBoundary, latestDailyBoundary);
        const planDay = Math.floor(latestDailyBoundary / MINUTES_PER_DAY) + 1;
        for (const agent of world.allAgents()) {
          void this.planner.scheduleDailyAndHour(agent, planDay, 5, now)
            .catch((error) => console.error('[planner] daily', error));
        }
      }
    } else {
      const previousHour = Math.floor(previousTotal / 60);
      const currentHour = Math.floor(now / 60);
      const hourOfDay = Math.floor(minute / 60);
      const stride = realtimeSampling ? (dt >= 30 ? 6 : dt >= 5 ? 3 : 1) : 1;
      const hourBoundary = currentHour * 60;
      if (
        currentHour !== previousHour
        && hourOfDay % stride === 0
        && hourBoundary > this.lastHourPlanBoundary
      ) {
        this.lastHourPlanBoundary = hourBoundary;
        for (const agent of world.allAgents()) {
          void this.planner.scheduleHour(agent, day, hourOfDay, now)
            .catch((error) => console.error('[planner] hour', error));
        }
      }
    }
    for (const a of world.allAgents()) this.reflection?.tick(a, day, now);
    this.dialogue?.tick(world, dt, now);
    this.townLife.tick(world, dt, now);
    this.townModel.tick(world, dt, now);
  }

  checkpoint(): MindRuntimeCheckpoint {
    return {
      schemaVersion: 1,
      lastGameTime: this.lastGameTime,
      lastDailyPlanBoundary: finiteBoundaryOrNull(this.lastDailyPlanBoundary),
      lastHourPlanBoundary: finiteBoundaryOrNull(this.lastHourPlanBoundary),
      lastDailyReflectionBoundary: finiteBoundaryOrNull(this.lastDailyReflectionBoundary),
      townModel: this.townModel.checkpoint(),
      townLife: this.townLife.checkpoint(),
    };
  }

  restore(input: unknown, world: WorldState, now: number): void {
    const checkpoint = validateMindRuntimeCheckpoint(input, now, world);
    this.lastGameTime = now;
    this.lastDailyPlanBoundary = checkpoint.lastDailyPlanBoundary ?? Number.NEGATIVE_INFINITY;
    this.lastHourPlanBoundary = checkpoint.lastHourPlanBoundary ?? Number.NEGATIVE_INFINITY;
    this.lastDailyReflectionBoundary = checkpoint.lastDailyReflectionBoundary ?? Number.NEGATIVE_INFINITY;
    this.townModel.restore(checkpoint.townModel, world, now);
    this.townLife.restore(checkpoint.townLife, world, now);
  }

  private scheduleDailyReflection(agent: Agent, day: number, now: number): void {
    let task: Promise<void>;
    task = this.writer.flush()
      .then(() => this.reflection.summarizeDay(agent, day, now))
      .catch((error) => console.error('[reflection] daily', error))
      .finally(() => this.pendingDaily.delete(task));
    this.pendingDaily.add(task);
  }

  /** 等待已接收事件、日记与反思全部形成，供确定性测试和安全关闭使用。 */
  async drain(): Promise<void> {
    await this.dialogue.drain();
    await this.writer.flush();
    await this.planner.drain();
    while (this.pendingDaily.size > 0) await Promise.allSettled([...this.pendingDaily]);
    await this.reflection.drain();
    await this.dialogue.drain();
    await this.writer.flush();
  }

  /** 跨日反思仍在形成时暂缓高速虚拟时钟，保证每日研究记录完整。 */
  isBackpressured(): boolean {
    return this.pendingDaily.size > 6;
  }

  /** 停止接收新事件，终结会话并等待全部认知记录写入完成。 */
  dispose(options: MindDisposeOptions = {}): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.writer.detach();
    const gameTime = options.gameTime ?? this.lastGameTime;
    const reason = options.reason?.trim() || '世界运行结束';
    this.disposePromise = (async () => {
      await this.dialogue.terminate(gameTime, reason);
      await this.drain();
    })();
    return this.disposePromise;
  }
}

export function validateMindRuntimeCheckpoint(input: unknown, now: number, world?: WorldState): MindRuntimeCheckpoint {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('认知运行态恢复时刻无效');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('认知运行态检查点必须是对象');
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.lastGameTime)
      || (value.lastGameTime as number) < 0 || (value.lastGameTime as number) > now) {
    throw new Error('认知运行态检查点版本或 lastGameTime 无效');
  }
  const lastDailyPlanBoundary = validateBoundary(value.lastDailyPlanBoundary, now, (boundary) => boundary % MINUTES_PER_DAY === 300, '每日规划');
  const lastHourPlanBoundary = validateBoundary(value.lastHourPlanBoundary, now, (boundary) => boundary % 60 === 0, '整点规划');
  const lastDailyReflectionBoundary = validateBoundary(
    value.lastDailyReflectionBoundary, now, (boundary) => boundary > 0 && boundary % MINUTES_PER_DAY === 0, '日反思',
  );
  const townModel = world
    ? validateTownModelCheckpoint(value.townModel, world, now)
    : value.townModel as TownModelCheckpoint;
  const townLife = world
    ? validateTownLifeCheckpoint(value.townLife, world, now)
    : value.townLife as TownLifeCheckpoint;
  return {
    schemaVersion: 1,
    lastGameTime: value.lastGameTime as number,
    lastDailyPlanBoundary,
    lastHourPlanBoundary,
    lastDailyReflectionBoundary,
    townModel,
    townLife,
  };
}

function validateBoundary(
  input: unknown,
  now: number,
  predicate: (boundary: number) => boolean,
  label: string,
): number | null {
  if (input === null) return null;
  if (!Number.isSafeInteger(input) || (input as number) < 0 || (input as number) > now || !predicate(input as number)) {
    throw new Error(`认知运行态${label}水位线无效`);
  }
  return input as number;
}

function finiteBoundaryOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function nextDailyBoundary(previousTotal: number, minuteOfDay: number): number {
  const dayStart = Math.floor(previousTotal / MINUTES_PER_DAY) * MINUTES_PER_DAY;
  const today = dayStart + minuteOfDay;
  return today > previousTotal ? today : today + MINUTES_PER_DAY;
}
