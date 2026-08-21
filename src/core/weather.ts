// 天气：逐日确定性（每 3 天 1 雨），纯视觉不影响行为
export type Weather = 'clear' | 'rain';

export function weatherForDay(day: number): Weather {
  return day % 3 === 2 ? 'rain' : 'clear';
}
