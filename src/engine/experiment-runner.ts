// 实验运行时：把伙伴选择实验挂到实时主循环（19:30 每日轮次），跟踪运行状态与剩余天数
import type { WorldState } from '../core/world';
import type { EventLog } from '../store/events';
import type { MindEngine } from './mind';
import { PartnerChoiceExperiment, type PartnerExperimentConfig } from './experiment';

export interface ExperimentState {
  running: boolean;
  remainingDays: number;
  mem: PartnerExperimentConfig['historyAccess'];
  gift: PartnerExperimentConfig['giftExchange'];
}

export class ExperimentRunner {
  private exp: PartnerChoiceExperiment;
  private cfg: PartnerExperimentConfig;
  private remaining = 0;

  constructor(private log: EventLog, private world: WorldState, private mind: MindEngine, cfg: PartnerExperimentConfig) {
    this.cfg = { ...cfg };
    this.exp = new PartnerChoiceExperiment(log, world, mind, this.cfg);
  }

  /** 主循环每 tick 调用：运行中时推进实验轮次并扣除剩余天数 */
  tick(now: number): void {
    if (this.remaining <= 0) return;
    const minute = now % 1440;
    if (this.remaining > 0 && minute === 1171 && this.lastFiredDay !== Math.floor(now / 1440)) {
      this.lastFiredDay = Math.floor(now / 1440);
      this.remaining -= 1;
    }
    this.exp.tick(now);
  }
  private lastFiredDay = -1;

  setConfig(cfg: PartnerExperimentConfig): void {
    this.cfg = { ...cfg };
    this.exp.cfg = this.cfg;
  }

  start(days: number): void {
    this.remaining = days;
    this.lastFiredDay = -1;
  }

  stop(): void {
    this.remaining = 0;
  }

  state(): ExperimentState {
    return { running: this.remaining > 0, remainingDays: this.remaining, mem: this.cfg.historyAccess, gift: this.cfg.giftExchange };
  }
}
