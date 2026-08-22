// 平行世界·多社会实验：每个世界一种实验形态（最小像素块示意，实验类型为主角）
// 形态：mem-on 关系记忆实验·记忆开｜mem-off 关系记忆实验·记忆关（对照）｜rumor 谣言传播观察

import { TimeEngine } from '../core/time';
import { WorldState } from '../core/world';
import { buildTown, DEFAULT_SEED } from './seed';
import { WorldLoop } from './loop';
import { AgentExecutor } from '../core/state-machine';
import { LLMGateway } from '../llm/gateway';
import { openDb, type DbHandle } from '../store/db';
import { EventLog } from '../store/events';
import { MindEngine } from './mind';
import { SocialTicker } from './social';
import { PlayerDirector } from './player';
import { ExperimentRunner } from './experiment-runner';

export type WorldKind = 'mem-on' | 'mem-off' | 'rumor';

export interface WorldMeta { id: string; kind: WorldKind; name: string; desc: string }

const KINDS: Record<WorldKind, Omit<WorldMeta, 'id'>> = {
  'mem-on': { kind: 'mem-on', name: '关系记忆 · 开', desc: '伙伴选择可访问互动历史 + 馈礼交换（实验组）' },
  'mem-off': { kind: 'mem-off', name: '关系记忆 · 关', desc: '伙伴选择无历史记忆（对照/零模型）' },
  rumor: { kind: 'rumor', name: '谣言传播', desc: '秘密注入后的传播链与选择性披露观察' },
};

export interface ManagedWorld {
  meta: WorldMeta;
  world: WorldState;
  time: TimeEngine;
  loop: WorldLoop;
  log: EventLog;
  db: DbHandle;
  mind: MindEngine;
  player: PlayerDirector;
  experiment: ExperimentRunner | null;
  seedRumor: (text: string) => void;
}

/** 创建平行世界：独立引擎/记忆/对话/日志（内存库，世界间互不影响） */
export function createManagedWorld(id: string, kind: WorldKind, seed = 1): ManagedWorld {
  const meta: WorldMeta = { id, ...KINDS[kind] };
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown(DEFAULT_SEED);
  const time = new TimeEngine(30);
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  const player = new PlayerDirector();
  const executor = new AgentExecutor(gateway, world, log, mind, player);
  const social = new SocialTicker(log, {}, mind.dialogue);

  let experiment: ExperimentRunner | null = null;
  let runnerHost: WorldLoop | null = null;
  if (kind === 'mem-on' || kind === 'mem-off') {
    experiment = new ExperimentRunner(log, world, mind, {
      historyAccess: kind === 'mem-on' ? 'on' : 'off',
      giftExchange: kind === 'mem-on' ? 'on' : 'off',
    });
    // 隔离相邻闲聊，让全部对话来自伙伴选择（洁净对照）
    const loop = new WorldLoop(time, world, executor, log, db, {}, undefined, mind, experiment);
    runnerHost = loop;
  } else {
    runnerHost = new WorldLoop(time, world, executor, log, db, {}, social, mind);
  }
  const loop = runnerHost;
  const seedRumor = (text: string) => {
    const lin = world.allAgents()[0];
    void mind.rumors.seed(lin.id, text, 0);
    mind.store.addMemory({ agentId: lin.id, kind: 'observation', content: `我知道了一个秘密：${text}`, importance: 9, createdGameTime: 0 });
  };
  return { meta, world, time, loop, log, db, mind, player, experiment, seedRumor };
}

/** 启动全部世界的时钟（每世界独立循环） */
export function startAllWorlds(worlds: ManagedWorld[]): void {
  for (const w of worlds) w.loop.start();
}

export function stopAllWorlds(worlds: ManagedWorld[]): void {
  for (const w of worlds) w.loop.stop();
}
