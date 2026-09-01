// 时间引擎：游戏内时钟。现实 0.5s/tick × 0.5 游戏分钟/tick = 60x（可配）

export interface ClockState {
  day: number;          // 第几天（1 起）
  minutesOfDay: number; // 当日 0~1439 分钟（整数）
  totalMinutes: number; // 自纪元起分钟数（整数，用于事件时间戳）
}

export interface TimeCheckpoint {
  schemaVersion: 1;
  elapsedMinutes: number;
}

export const MINUTES_PER_DAY = 1440;

export class TimeEngine {
  private minutes = 0; // 内部浮点累计

  constructor(public gameMinutesPerTick = 0.5) {
    if (!(gameMinutesPerTick > 0)) throw new Error('gameMinutesPerTick 必须大于 0');
  }

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

  /** 保留内部小数分钟，避免重启后把亚分钟进度截断。 */
  checkpoint(): TimeCheckpoint {
    return { schemaVersion: 1, elapsedMinutes: this.minutes };
  }

  /** 只恢复受版本与数值边界约束的精确时钟。 */
  restore(input: unknown): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('时钟检查点必须是对象');
    }
    const value = input as Record<string, unknown>;
    if (value.schemaVersion !== 1
      || typeof value.elapsedMinutes !== 'number'
      || !Number.isFinite(value.elapsedMinutes)
      || value.elapsedMinutes < 0
      || value.elapsedMinutes > Number.MAX_SAFE_INTEGER) {
      throw new Error('时钟检查点版本或 elapsedMinutes 无效');
    }
    this.minutes = value.elapsedMinutes;
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
