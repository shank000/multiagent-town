// 实验运行时：把伙伴选择实验挂到实时主循环（19:30 每日轮次），跟踪运行状态与剩余天数
import type { WorldState } from '../core/world';
import { MINUTES_PER_DAY } from '../core/time';
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
  private accountedDay = 0;

  constructor(private log: EventLog, private world: WorldState, private mind: MindEngine, cfg: PartnerExperimentConfig) {
    this.cfg = { ...cfg };
    this.exp = new PartnerChoiceExperiment(log, world, mind, this.cfg);
  }

  /** 主循环每 tick 调用：运行中时推进实验轮次并扣除剩余天数 */
  tick(now: number): void {
    if (this.remaining <= 0) return;
    const currentDay = Math.floor(now / MINUTES_PER_DAY);
    if (currentDay > this.accountedDay) {
      this.remaining = Math.max(0, this.remaining - (currentDay - this.accountedDay));
      this.accountedDay = currentDay;
    }
    this.exp.tick(now);
  }

  setConfig(cfg: PartnerExperimentConfig): void {
    this.cfg = { ...cfg };
    this.exp.cfg = this.cfg;
  }

  start(days: number, now: number): void {
    this.remaining = days;
    this.accountedDay = Math.floor(now / MINUTES_PER_DAY);
  }

  stop(): void {
    this.remaining = 0;
  }

  state(): ExperimentState {
    return { running: this.remaining > 0, remainingDays: this.remaining, mem: this.cfg.historyAccess, gift: this.cfg.giftExchange };
  }
}
