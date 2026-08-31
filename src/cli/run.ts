// M0 命令行观察台：4 个 agent 实时状态 + 事件流 + 成本计量

import { resolve } from 'node:path';
import { TimeEngine, type ClockState } from '../core/time';
import { buildTown } from '../engine/seed';
import { openDb } from '../store/db';
import { EventLog } from '../store/events';
import { LLMGateway } from '../llm/gateway';
import { providerNameFromEnv, gatewayConfigFromEnv } from '../llm/provider-config';
import { AgentExecutor } from '../core/state-machine';
import { WorldLoop } from '../engine/loop';
import { SocialTicker } from '../engine/social';
import { MindEngine } from '../engine/mind';
import { PlayerDirector } from '../engine/player';
import type { WorldState } from '../core/world';

export interface RunArgs {
  speed: number;              // 游戏分钟 / 现实秒（默认 1 = 60x）
  dbPath: string;
  untilMinutes: number | null; // null = 实时模式，Ctrl+C 停止
}

export function parseArgs(argv: string[]): RunArgs {
  const args: RunArgs = {
    speed: 1,
    dbPath: resolve(process.cwd(), 'data/town.sqlite'),
    untilMinutes: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--speed') args.speed = Number(argv[++i]);
    else if (argv[i] === '--db') args.dbPath = argv[++i];
    else if (argv[i] === '--until-minutes') args.untilMinutes = Number(argv[++i]);
  }
  return args;
}

const STATE_ICON: Record<string, string> = { idle: '·', thinking: '…', moving: '→', acting: '◆' };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = providerNameFromEnv();
  const gateway = new LLMGateway(gatewayConfigFromEnv());
  const db = openDb(args.dbPath);
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(args.speed * 0.5); // tick 0.5 现实秒
  const mind = new MindEngine({ db, llm: gateway, log });
  const player = new PlayerDirector();
  const executor = new AgentExecutor(gateway, world, log, mind, player);
  const social = new SocialTicker(log, {}, mind.dialogue);
  const loop = new WorldLoop(time, world, executor, log, db, {
    onTick: (clock) => printBoard(clock, world, log, gateway),
  }, social, mind);
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (reason: string, showSummary: boolean): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      try {
        loop.stop();
        await loop.drain();
        await mind.dispose({ gameTime: time.state.totalMinutes, reason });
        await gateway.drain();
        if (showSummary) printSummary(time.state, gateway, log, args.dbPath);
      } finally {
        db.raw.close();
      }
    })();
    return shutdownPromise;
  };

  console.log(`[multiagent-town M0] provider=${provider} speed=${args.speed}游戏分钟/现实秒 db=${args.dbPath}`);
  if (args.untilMinutes !== null) {
    try {
      await loop.runUntil(args.untilMinutes);
      await shutdown('有限运行达到设定终点', true);
    } catch (error) {
      await shutdown('有限运行异常终止', false).catch(() => { /* 保留原始运行错误 */ });
      throw error;
    }
    return;
  }
  console.log('按 Ctrl+C 停止。');
  loop.start();
  const handleSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    void shutdown(`收到 ${signal}，世界运行结束`, true).catch((error) => {
      console.error('[town shutdown]', error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
}

function printBoard(clock: ClockState, world: WorldState, log: EventLog, gateway: LLMGateway): void {
  const cost = gateway.metricSummary().reduce((s, m) => s + m.costYuan, 0);
  const lines: string[] = [`\x1Bc=== ${TimeEngine.format(clock)} | 事件 ${log.count()} | 累计成本 ¥${cost.toFixed(4)} ===`];
  for (const a of world.allAgents()) {
    const loc = world.getObject(a.locationId)?.name ?? a.locationId;
    let verb = '';
    if (a.state === 'acting' && a.action) verb = a.action.action.verb;
    else if (a.state === 'moving' && a.action) verb = `去${world.getObject(a.action.action.target)?.name ?? ''}`;
    const thought = a.state === 'thinking' ? '（思考中）' : a.thought && a.state !== 'idle' ? `💭${a.thought.slice(0, 24)}` : '';
    lines.push(`${STATE_ICON[a.state]} ${a.name} @ ${loc} ${verb} ${thought}`.trim());
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function printSummary(clock: ClockState, gateway: LLMGateway, log: EventLog, dbPath: string): void {
  console.log('=== 运行结束 ===');
  console.log(`停止于 ${TimeEngine.format(clock)}，共 ${log.count()} 条事件`);
  for (const m of gateway.metricSummary()) {
    console.log(`  [${m.template}] 调用 ${m.calls} 次，入 ${m.inputTokens} / 出 ${m.outputTokens} token，¥${m.costYuan.toFixed(4)}`);
  }
  console.log(`日志已保存至 ${dbPath}，可用 pnpm replay --day 1 回放。`);
}

void main().catch((error: unknown) => {
  console.error('[town]', error);
  process.exitCode = 1;
});
