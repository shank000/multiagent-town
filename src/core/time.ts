// 时间引擎：游戏内时钟。现实 0.5s/tick × 0.5 游戏分钟/tick = 60x（可配）

export interface ClockState {
  day: number;          // 第几天（1 起）
  minutesOfDay: number; // 当日 0~1439 分钟（整数）
  totalMinutes: number; // 自纪元起分钟数（整数，用于事件时间戳）
}

export const MINUTES_PER_DAY = 1440;

export class TimeEngine {
  private minutes = 0; // 内部浮点累计

  constructor(public gameMinutesPerTick = 0.5) {}

  /** 推进一个 tick，返回本次推进的分钟数 */
  tick(): number {
    this.minutes += this.gameMinutesPerTick;
    return this.gameMinutesPerTick;
  }

  get state(): ClockState {
    const total = Math.floor(this.minutes);
    return {
      day: Math.floor(total / MINUTES_PER_DAY) + 1,
      minutesOfDay: total % MINUTES_PER_DAY,
      totalMinutes: total,
    };
  }

  static format(clock: ClockState): string {
    const hh = String(Math.floor(clock.minutesOfDay / 60)).padStart(2, '0');
    const mm = String(clock.minutesOfDay % 60).padStart(2, '0');
    return `第${clock.day}天 ${hh}:${mm}`;
  }

  static minuteOfDay(totalMinutes: number): number {
    return totalMinutes % MINUTES_PER_DAY;
  }
}
