// 日志回放：按天输出事件时间线（验收：日志可回放）

import { resolve } from 'node:path';
import { TimeEngine, MINUTES_PER_DAY } from '../core/time';
import { openDb } from '../store/db';
import { EventLog } from '../store/events';

export interface ReplayArgs {
  dbPath: string;
  day: number;
}

export function parseArgs(argv: string[]): ReplayArgs {
  const args: ReplayArgs = { dbPath: resolve(process.cwd(), 'data/town.sqlite'), day: 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') args.dbPath = argv[++i];
    else if (argv[i] === '--day') args.day = Number(argv[++i]);
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const log = new EventLog(openDb(args.dbPath));
  const events = log.eventsForDay(args.day);
  console.log(`=== 第${args.day}天 事件回放（${events.length} 条）===`);
  for (const e of events) {
    const clock = { day: args.day, minutesOfDay: e.gameTime % MINUTES_PER_DAY, totalMinutes: e.gameTime };
    console.log(`[${TimeEngine.format(clock)}] ${e.description}`);
  }
}

main();
