// 实验运行时：把伙伴选择实验挂到实时主循环（19:30 每日轮次），跟踪运行状态与剩余天数
import type { WorldState } from '../core/world';
import type { EventLog } from '../store/events';
import type { MindEngine } from './mind';
import {
  PartnerChoiceExperiment,
  type PartnerChoiceExperimentCheckpoint,
  type PartnerChoiceExperimentOptions,
  type PartnerExperimentConfig,
} from './experiment';

export interface ExperimentState {
  running: boolean;
  remainingDays: number;
  mem: PartnerExperimentConfig['historyAccess'];
  gift: PartnerExperimentConfig['giftExchange'];
}

export interface ExperimentRunnerCheckpoint {
  schemaVersion: 1;
  remainingDays: number;
  config: PartnerExperimentConfig;
  partner: PartnerChoiceExperimentCheckpoint;
}

export class ExperimentRunner {
  private exp: PartnerChoiceExperiment;
  private cfg: PartnerExperimentConfig;
  private remaining = 0;

  constructor(
    private log: EventLog,
    private world: WorldState,
    private mind: MindEngine,
    cfg: PartnerExperimentConfig,
    options: PartnerChoiceExperimentOptions = {}
  ) {
    this.cfg = { ...cfg };
    this.exp = new PartnerChoiceExperiment(log, world, mind, this.cfg, options);
  }

  /** 主循环每 tick 调用：运行中时推进实验轮次并扣除剩余天数 */
  tick(now: number): void {
    if (this.remaining <= 0) return;
    const completedRounds = this.exp.tick(now, this.remaining);
    this.remaining = Math.max(0, this.remaining - completedRounds);
  }

  setConfig(cfg: PartnerExperimentConfig): void {
    this.cfg = { ...cfg };
    this.exp.cfg = this.cfg;
  }

  start(days: number, now: number): void {
    this.remaining = days;
    this.exp.resetClock(now);
  }

  stop(): void {
    this.remaining = 0;
  }

  checkpoint(): ExperimentRunnerCheckpoint {
    return {
      schemaVersion: 1,
      remainingDays: this.remaining,
      config: { ...this.cfg },
      partner: this.exp.checkpoint(),
    };
  }

  restore(input: unknown, now: number): void {
    const checkpoint = validateExperimentRunnerCheckpoint(input);
    this.setConfig(checkpoint.config);
    this.remaining = checkpoint.remainingDays;
    this.exp.restore(checkpoint.partner, now);
  }

  state(): ExperimentState {
    return { running: this.remaining > 0, remainingDays: this.remaining, mem: this.cfg.historyAccess, gift: this.cfg.giftExchange };
  }
}

export function validateExperimentRunnerCheckpoint(input: unknown): ExperimentRunnerCheckpoint {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('实验运行器检查点必须是对象');
  const value = input as Record<string, unknown>;
  const config = value.config as Record<string, unknown> | null;
  if (value.schemaVersion !== 1
      || !Number.isSafeInteger(value.remainingDays)
      || (value.remainingDays as number) < 0
      || (value.remainingDays as number) > 365
      || !config || typeof config !== 'object' || Array.isArray(config)
      || (config.historyAccess !== 'on' && config.historyAccess !== 'off')
      || (config.giftExchange !== 'on' && config.giftExchange !== 'off')) {
    throw new Error('实验运行器检查点版本、剩余天数或配置无效');
  }
  return {
    schemaVersion: 1,
    remainingDays: value.remainingDays as number,
    config: {
      historyAccess: config.historyAccess,
      giftExchange: config.giftExchange,
    },
    partner: value.partner as PartnerChoiceExperimentCheckpoint,
  };
}
