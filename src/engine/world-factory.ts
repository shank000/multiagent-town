// 平行世界·多社会实验：每个世界一种实验形态（最小像素块示意，实验类型为主角）
// 形态：mem-on 关系记忆实验·记忆开｜mem-off 关系记忆实验·记忆关（对照）｜rumor 谣言传播观察

import { TimeEngine } from '../core/time';
import { WorldState } from '../core/world';
import { buildTown, DEFAULT_SEED } from './seed';
import { startLoopGroup, stopLoopGroup, WorldLoop } from './loop';
import { AgentExecutor } from '../core/state-machine';
import { LLMGateway } from '../llm/gateway';
import { openDb, type DbHandle } from '../store/db';
import { EventLog } from '../store/events';
import { MindEngine } from './mind';
import { SocialTicker } from './social';
import { PlayerDirector } from './player';
import { ExperimentRunner } from './experiment-runner';
import { applyAgentProfile, normalizeAgentProfile } from './agent-profile';
import {
  restoreManagedWorldCheckpoint,
  type WorldRuntimeCheckpoint,
} from './workspace-persistence';

export type WorldKind = 'mem-on' | 'mem-off' | 'rumor';

export interface WorldBadge {
  label: string;
  value: string;
  tone: 'on' | 'off' | 'neutral';
}

export interface WorldMeta {
  id: string;
  kind: WorldKind;
  name: string;
  desc: string;
  badges: WorldBadge[];
}

const KINDS: Record<WorldKind, Omit<WorldMeta, 'id'>> = {
  'mem-on': {
    kind: 'mem-on',
    name: '关系记忆 · 开',
    desc: '关系记忆与馈礼同时开启的本地联合处理展示；正式主实验按 2×2 条件分别估计效应。',
    badges: [
      { label: '历史', value: '可见', tone: 'on' },
      { label: '馈礼', value: '开启', tone: 'on' },
      { label: '用途', value: '联合处理展示', tone: 'neutral' },
    ],
  },
  'mem-off': {
    kind: 'mem-off',
    name: '关系记忆 · 关',
    desc: '关系记忆与馈礼均关闭的本地零处理参考；正式实验仍使用相同 LLM 决策流程。',
    badges: [
      { label: '历史', value: '隐藏', tone: 'off' },
      { label: '馈礼', value: '关闭', tone: 'off' },
      { label: '用途', value: '零处理参考', tone: 'neutral' },
    ],
  },
  rumor: {
    kind: 'rumor',
    name: '谣言传播',
    desc: '秘密注入后的传播链与选择性披露观察。',
    badges: [
      { label: '处理', value: '秘密注入', tone: 'on' },
      { label: '观测', value: '传播链', tone: 'neutral' },
      { label: '伙伴实验', value: '不适用', tone: 'off' },
    ],
  },
};

export interface ManagedWorld {
  meta: WorldMeta;
  world: WorldState;
  time: TimeEngine;
  loop: WorldLoop;
  log: EventLog;
  db: DbHandle;
  dbPath: string;
  mind: MindEngine;
  social: SocialTicker;
  player: PlayerDirector;
  experiment: ExperimentRunner | null;
  seedRumor: (text: string) => void;
}

export interface ManagedWorldOptions {
  /** Paired experimental worlds share this seed so reference-policy draws are comparable. */
  seed?: number;
  gameMinutesPerTick?: number;
  gateway?: LLMGateway;
  dbPath?: string;
  /** Stable resident-id keyed definitions, shared across paired worlds before the run begins. */
  profileOverrides?: Readonly<Record<string, unknown>>;
  /** 仅由工作空间整体预检通过后的显式恢复入口提供。 */
  runtimeCheckpoint?: WorldRuntimeCheckpoint;
}

/** 创建平行世界：每个世界拥有独立状态、记忆、对话与事件库。 */
export function createManagedWorld(id: string, kind: WorldKind, options: ManagedWorldOptions = {}): ManagedWorld {
  const seed = options.seed ?? 1;
  const meta: WorldMeta = { id, ...KINDS[kind] };
  const dbPath = options.dbPath ?? ':memory:';
  const db = openDb(dbPath);
  const log = new EventLog(db);
  const world = buildTown(DEFAULT_SEED);
  const agentIndex = new Map(world.allAgents().map((agent, index) => [agent.id, index]));
  for (const [agentId, rawProfile] of Object.entries(options.profileOverrides ?? {})) {
    if (!world.hasAgent(agentId)) throw new Error(`居民档案配置包含未知 ID：${agentId}`);
    const agent = world.getAgent(agentId);
    const profile = normalizeAgentProfile(rawProfile, agent, world, agentIndex.get(agentId) ?? 0);
    applyAgentProfile(world, agentId, profile, { resetRuntime: true });
  }
  const time = new TimeEngine(options.gameMinutesPerTick ?? 30);
  const gateway = options.gateway ?? new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log, scopeId: id, townModelSeed: seed });
  const player = new PlayerDirector();
  const executor = new AgentExecutor(gateway, world, log, mind, player, id);
  let experiment: ExperimentRunner | null = null;
  let runnerHost: WorldLoop | null = null;
  if (kind === 'mem-on' || kind === 'mem-off') {
    experiment = new ExperimentRunner(log, world, mind, {
      historyAccess: kind === 'mem-on' ? 'on' : 'off',
      giftExchange: kind === 'mem-on' ? 'on' : 'off',
    }, { seed });
  }
  if (options.runtimeCheckpoint) {
    try {
      restoreManagedWorldCheckpoint({ world, time, experiment }, options.runtimeCheckpoint);
    } catch (error) {
      socialSafeCloseDb(db);
      throw error;
    }
  }
  // 浏览与自然主义观察阶段允许居民自发交谈；正式伙伴选择实验运行时暂停环境闲聊，保持处理边界洁净。
  const social = new SocialTicker(log, {
    enabled: () => !(experiment?.state().running ?? false),
  }, mind.dialogue, mind.rels);
  if (experiment) {
    const loop = new WorldLoop(
      time, world, executor, log, db, {}, social, mind, experiment, gateway,
      { initializeFresh: !options.runtimeCheckpoint },
    );
    runnerHost = loop;
  } else {
    runnerHost = new WorldLoop(
      time, world, executor, log, db, {}, social, mind, undefined, gateway,
      { initializeFresh: !options.runtimeCheckpoint },
    );
  }
  const loop = runnerHost;
  const seedRumor = (text: string) => {
    const lin = world.allAgents()[0];
    void mind.rumors.seed(lin.id, text, 0);
    mind.store.addMemory({ agentId: lin.id, kind: 'observation', content: `我知道了一个秘密：${text}`, importance: 9, createdGameTime: 0 });
  };
  return { meta, world, time, loop, log, db, dbPath, mind, social, player, experiment, seedRumor };
}

function socialSafeCloseDb(db: DbHandle): void {
  try { db.raw.close(); } catch { /* 恢复构造失败时保留原始校验错误 */ }
}

/** 启动全部世界的时钟（每世界独立循环） */
export function startAllWorlds(worlds: ManagedWorld[]): void {
  startLoopGroup(worlds.map((world) => world.loop));
}

export function stopAllWorlds(worlds: ManagedWorld[]): void {
  stopLoopGroup(worlds.map((world) => world.loop));
}
