// 像素小镇 Web 版：世界循环 + 本地网页服务（浏览器可视化，mock 默认离线）

import { resolve } from 'node:path';
import { TimeEngine } from '../core/time';
import { buildTown } from '../engine/seed';
import { openDb } from '../store/db';
import { EventLog } from '../store/events';
import { LLMGateway } from '../llm/gateway';
import { AgentExecutor } from '../core/state-machine';
import { WorldLoop } from '../engine/loop';
import { SocialTicker } from '../engine/social';
import { MindEngine } from '../engine/mind';
import { createTownServer } from '../web/server';

export interface TownWebArgs {
  speed: number; // 游戏分钟/现实秒（默认 1 = 60x）
  port: number;
  dbPath: string;
}

export function parseArgs(argv: string[]): TownWebArgs {
  const args: TownWebArgs = { speed: 1, port: 8787, dbPath: resolve(process.cwd(), 'data/town.sqlite') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--speed') args.speed = Number(argv[++i]);
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--db') args.dbPath = argv[++i];
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = process.env.LLM_PROVIDER === 'deepseek' ? 'deepseek' : 'mock';
  const gateway = new LLMGateway({
    provider,
    deepseek: { apiKey: process.env.DEEPSEEK_API_KEY ?? '' },
    retries: 2,
  });
  const db = openDb(args.dbPath);
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(args.speed * 0.5);
  const mind = new MindEngine({ db, llm: gateway, log });
  const executor = new AgentExecutor(gateway, world, log, mind);
  const social = new SocialTicker(log, {}, mind.dialogue);
  const loop = new WorldLoop(time, world, executor, log, db, {}, social, mind);
  const server = await createTownServer({ world, time, loop, log, mind, port: args.port });
  console.log(`[multiagent-town 像素小镇] provider=${provider} speed=${args.speed}游戏分钟/现实秒 db=${args.dbPath}`);
  console.log(`浏览器打开：http://127.0.0.1:${server.port} （按 Ctrl+C 停止）`);
  loop.start();
  process.on('SIGINT', () => {
    loop.stop();
    void server.close().then(() => process.exit(0));
  });
}

void main();
