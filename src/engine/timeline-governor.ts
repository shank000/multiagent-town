import type { LLMGateway, SchedulerSnapshot, ThroughputSnapshot } from '../llm/gateway';
import { MAX_WORLD_SPEED, MIN_WORLD_SPEED, WORLD_SPEED_PRESETS } from './runtime-limits';

export type TimelineMode = 'manual' | 'adaptive';

export type TimelineAdjustmentReason =
  | 'manual_selection'
  | 'workspace_configuration'
  | 'measured_capacity'
  | 'warming_up'
  | 'queue_pressure'
  | 'recovery_hysteresis';

export interface GovernedTimelineWorld {
  id: string;
  time: { gameMinutesPerTick: number };
}

export interface TimelineAdjustment {
  mode: TimelineMode;
  fromSpeed: number;
  toSpeed: number;
  reason: TimelineAdjustmentReason;
  sampleCount: number;
  generationTokensPerSecond: number | null;
  p90LatencyMs: number | null;
}

export interface TimelineGovernorSnapshot {
  mode: TimelineMode;
  selectedSpeed: number;
  effectiveSpeed: number;
  recommendedSpeed: number | null;
  manualSpeedLimit: number;
  manualSpeedLimitReason: 'mock_capacity' | 'warming_up' | 'measured_capacity';
  adaptiveCeiling: number;
  synchronizing: boolean;
  paused: boolean;
  reason: 'paused' | 'cognitive_sync' | 'queue_pressure' | 'warming_up' | 'measured_capacity' | 'manual';
  stableEvaluations: number;
  lastChangedAt: string | null;
}

export interface TimelineGovernorOptions {
  stableEvaluationsBeforeUpshift?: number;
  adaptiveCeiling?: number;
  onAdjustment?: (adjustment: TimelineAdjustment) => void;
}

/**
 * 将模型的实测服务能力持续映射为虚拟时间速度。
 * 降速立即生效，升速必须连续稳定多个采样窗口且每次只提升一个档位，避免抖动。
 */
export class TimelineGovernor {
  private modeValue: TimelineMode = 'manual';
  private stableEvaluations = 0;
  private lastCandidate: number | null = null;
  private lastChangedAt: string | null = null;
  private readonly stableEvaluationsBeforeUpshift: number;
  private readonly adaptiveCeiling: number;
  private readonly onAdjustment?: (adjustment: TimelineAdjustment) => void;

  constructor(
    private readonly gateway: LLMGateway,
    options: TimelineGovernorOptions = {},
  ) {
    this.stableEvaluationsBeforeUpshift = Math.max(1, Math.floor(options.stableEvaluationsBeforeUpshift ?? 3));
    this.adaptiveCeiling = normalizeSpeed(options.adaptiveCeiling ?? MAX_WORLD_SPEED);
    this.onAdjustment = options.onAdjustment;
  }

  get mode(): TimelineMode { return this.modeValue; }

  /**
   * 手动档位也必须服从真实模型的可持续容量。Mock 仅用于工程回归，保留完整档位；
   * 真实 provider 在形成至少两个吞吐样本前采用保守冷启动上限。
   */
  manualSpeedLimit(): Pick<TimelineGovernorSnapshot, 'manualSpeedLimit' | 'manualSpeedLimitReason'> {
    if (this.gateway.runtimeSnapshot().mode === 'mock') {
      return { manualSpeedLimit: MAX_WORLD_SPEED, manualSpeedLimitReason: 'mock_capacity' };
    }
    const performance = this.gateway.throughputSnapshot();
    if (performance.sampleCount < 2 || performance.recommendedMaxWorldSpeed === null) {
      return { manualSpeedLimit: 0.2, manualSpeedLimitReason: 'warming_up' };
    }
    return {
      manualSpeedLimit: floorPreset(performance.recommendedMaxWorldSpeed),
      manualSpeedLimitReason: 'measured_capacity',
    };
  }

  setManual(
    speed: number,
    worlds: readonly GovernedTimelineWorld[],
    reason: Extract<TimelineAdjustmentReason, 'manual_selection' | 'workspace_configuration'> = 'manual_selection',
  ): TimelineGovernorSnapshot {
    this.modeValue = 'manual';
    this.stableEvaluations = 0;
    this.lastCandidate = null;
    this.applySpeed(normalizeSpeed(speed), worlds, reason);
    return this.snapshot(worlds, false);
  }

  enableAdaptive(worlds: readonly GovernedTimelineWorld[]): TimelineGovernorSnapshot {
    this.modeValue = 'adaptive';
    this.stableEvaluations = 0;
    this.lastCandidate = null;
    const scheduler = this.gateway.schedulerSnapshot();
    const target = this.adaptiveTarget(scheduler);
    this.applySpeed(target.speed, worlds, target.reason);
    return this.snapshot(worlds, false, scheduler);
  }

  /** 每个控制窗口调用一次；手动模式保持用户档位，仅保留网关的认知同步屏障。 */
  reconcile(worlds: readonly GovernedTimelineWorld[]): TimelineGovernorSnapshot {
    const scheduler = this.gateway.schedulerSnapshot();
    if (this.modeValue !== 'adaptive' || !worlds.length) return this.snapshot(worlds, false, scheduler);
    const current = speedOf(worlds);
    const target = this.adaptiveTarget(scheduler);
    if (target.speed < current) {
      this.stableEvaluations = 0;
      this.lastCandidate = target.speed;
      this.applySpeed(target.speed, worlds, target.reason);
    } else if (target.speed > current) {
      if (this.lastCandidate === target.speed) this.stableEvaluations += 1;
      else {
        this.lastCandidate = target.speed;
        this.stableEvaluations = 1;
      }
      if (this.stableEvaluations >= this.stableEvaluationsBeforeUpshift) {
        this.applySpeed(nextPreset(current, target.speed), worlds, 'recovery_hysteresis');
        this.stableEvaluations = 0;
      }
    } else {
      this.stableEvaluations = 0;
      this.lastCandidate = target.speed;
    }
    return this.snapshot(worlds, false, scheduler);
  }

  snapshot(
    worlds: readonly GovernedTimelineWorld[],
    paused: boolean,
    scheduler = this.gateway.schedulerSnapshot(),
  ): TimelineGovernorSnapshot {
    const performance = scheduler.performance;
    const manualLimit = this.manualSpeedLimit();
    const selectedSpeed = speedOf(worlds);
    const synchronizing = scheduler.pressureReason === 'cognitive_sync';
    const queuePressure = scheduler.pressureReason === 'queue_capacity' || scheduler.pressureReason === 'queue_wait';
    const reason = paused
      ? 'paused'
      : synchronizing
        ? 'cognitive_sync'
        : queuePressure
          ? 'queue_pressure'
          : this.modeValue === 'manual'
            ? 'manual'
            : performance.sampleCount < 2
              ? 'warming_up'
              : 'measured_capacity';
    return {
      mode: this.modeValue,
      selectedSpeed,
      effectiveSpeed: paused || scheduler.backpressured ? 0 : selectedSpeed,
      recommendedSpeed: performance.recommendedMaxWorldSpeed,
      ...manualLimit,
      adaptiveCeiling: this.adaptiveCeiling,
      synchronizing,
      paused,
      reason,
      stableEvaluations: this.stableEvaluations,
      lastChangedAt: this.lastChangedAt,
    };
  }

  private adaptiveTarget(scheduler: SchedulerSnapshot): { speed: number; reason: TimelineAdjustmentReason } {
    const performance = scheduler.performance;
    let speed = performance.recommendedMaxWorldSpeed
      ?? (this.gateway.runtimeSnapshot().mode === 'mock' ? 1 : 0.2);
    let reason: TimelineAdjustmentReason = performance.sampleCount >= 2 ? 'measured_capacity' : 'warming_up';
    speed = Math.min(speed, this.adaptiveCeiling);

    if (scheduler.pressureReason === 'queue_capacity' || scheduler.pressureReason === 'queue_wait') {
      speed = MIN_WORLD_SPEED;
      reason = 'queue_pressure';
    } else if (scheduler.queued > scheduler.maxConcurrent * 2 || scheduler.oldestWaitMs >= 5_000) {
      speed = Math.min(speed, 0.1);
      reason = 'queue_pressure';
    } else if (scheduler.queued > 0 || (performance.p90QueueWaitMs ?? 0) >= 2_000) {
      speed = Math.min(speed, 0.3);
      reason = 'queue_pressure';
    }

    return { speed: floorPreset(speed), reason };
  }

  private applySpeed(
    speed: number,
    worlds: readonly GovernedTimelineWorld[],
    reason: TimelineAdjustmentReason,
  ): void {
    if (!worlds.length) return;
    const normalized = normalizeSpeed(speed);
    const fromSpeed = speedOf(worlds);
    for (const world of worlds) world.time.gameMinutesPerTick = normalized * 0.5;
    if (Math.abs(fromSpeed - normalized) < 1e-9) return;
    this.lastChangedAt = new Date().toISOString();
    const performance = this.gateway.throughputSnapshot();
    this.onAdjustment?.({
      mode: this.modeValue,
      fromSpeed,
      toSpeed: normalized,
      reason,
      sampleCount: performance.sampleCount,
      generationTokensPerSecond: performance.generationTokensPerSecond,
      p90LatencyMs: performance.p90LatencyMs,
    });
  }
}

function speedOf(worlds: readonly GovernedTimelineWorld[]): number {
  return worlds.length ? roundSpeed(worlds[0].time.gameMinutesPerTick * 2) : 0;
}

function floorPreset(value: number): number {
  const bounded = Math.max(MIN_WORLD_SPEED, Math.min(MAX_WORLD_SPEED, value));
  return [...WORLD_SPEED_PRESETS].reverse().find((speed) => speed <= bounded + 1e-9) ?? MIN_WORLD_SPEED;
}

function nextPreset(current: number, target: number): number {
  return WORLD_SPEED_PRESETS.find((speed) => speed > current + 1e-9 && speed <= target + 1e-9) ?? target;
}

function normalizeSpeed(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_WORLD_SPEED) {
    throw new Error(`世界速度必须在 (0, ${MAX_WORLD_SPEED}]`);
  }
  return roundSpeed(value);
}

function roundSpeed(value: number): number {
  return Math.round(value * 100) / 100;
}

export function timelinePerformanceSummary(performance: ThroughputSnapshot): string {
  const rate = performance.generationTokensPerSecond === null ? '待测' : `${performance.generationTokensPerSecond}tok/s`;
  const latency = performance.p90LatencyMs === null ? '待测' : `${performance.p90LatencyMs}ms`;
  return `rate=${rate} p90=${latency} samples=${performance.sampleCount}`;
}
