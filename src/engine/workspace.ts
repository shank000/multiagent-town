import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import type { LLMGateway } from '../llm/gateway';
import type { BackendRuntimeLog } from '../runtime/backend-log';
import { runtimeLogPathForDatabase } from '../runtime/backend-log';
import { assertFreshSelectedWorldDbPaths, type TownWorldId } from '../cli/town-web-config';
import { profileSetHash } from './agent-profile';
import {
  createManagedWorld,
  stopAllWorlds,
  type ManagedWorld,
  type WorldKind,
} from './world-factory';

export const WORLD_ID_BY_KIND: Readonly<Record<WorldKind, TownWorldId>> = {
  'mem-on': 'w1',
  'mem-off': 'w2',
  rumor: 'w3',
};

export const WORLD_TEMPLATE_CATALOG = [
  { kind: 'mem-on', id: 'w1', name: '关系记忆 · 开', description: '关系历史可见、馈礼开启的联合处理展示。' },
  { kind: 'mem-off', id: 'w2', name: '关系记忆 · 关', description: '相同决策流程下隐藏关系历史并关闭馈礼。' },
  { kind: 'rumor', id: 'w3', name: '谣言传播', description: '观察秘密注入、选择性披露与传播链。' },
] as const;

export interface ExperimentWorkspaceConfig {
  name: string;
  seed: number;
  worldSpeed: number;
  defaultExperimentDays: number;
  worldKinds: WorldKind[];
  startPaused: boolean;
}

export interface ExperimentWorkspaceMeta extends ExperimentWorkspaceConfig {
  id: string;
  createdAt: string;
  worldIds: TownWorldId[];
  worldCount: number;
  databaseBasePath: string;
  runtimeLogPath: string;
  profileSetHash: string;
}

export interface BuiltExperimentWorkspace {
  meta: ExperimentWorkspaceMeta;
  worlds: ManagedWorld[];
}

export interface ExperimentWorkspaceRuntimeOptions {
  gateway: LLMGateway;
  profileOverrides?: () => Readonly<Record<string, unknown>>;
  runtimeLog?: BackendRuntimeLog;
  nextDatabasePath: () => string;
}

/** 当前进程只挂载一个实验工作空间；替换时旧数据库完整封存，新世界使用全新文件。 */
export class ExperimentWorkspaceRuntime {
  private currentValue: BuiltExperimentWorkspace;

  private constructor(
    initial: BuiltExperimentWorkspace,
    private readonly options: ExperimentWorkspaceRuntimeOptions,
  ) {
    this.currentValue = initial;
  }

  static async create(
    input: unknown,
    options: ExperimentWorkspaceRuntimeOptions,
    initialDatabasePath: string,
    checkBasePath = false,
  ): Promise<ExperimentWorkspaceRuntime> {
    const initial = await buildWorkspace(input, options, initialDatabasePath, checkBasePath);
    options.runtimeLog?.info('workspace', workspaceSummary(initial.meta, 'created'));
    return new ExperimentWorkspaceRuntime(initial, options);
  }

  get current(): BuiltExperimentWorkspace { return this.currentValue; }

  async replace(input: unknown): Promise<BuiltExperimentWorkspace> {
    const next = await buildWorkspace(input, this.options, this.options.nextDatabasePath(), false);
    const previous = this.currentValue;
    try {
      await disposeManagedWorlds(previous.worlds);
    } catch (error) {
      await disposeManagedWorlds(next.worlds);
      throw error;
    }
    this.options.runtimeLog?.switchFile(next.meta.runtimeLogPath, next.meta.id);
    this.currentValue = next;
    this.options.runtimeLog?.info('workspace', workspaceSummary(next.meta, 'activated'));
    return next;
  }

  async dispose(): Promise<void> {
    await disposeManagedWorlds(this.currentValue.worlds);
  }
}

export function normalizeWorkspaceConfig(input: unknown): ExperimentWorkspaceConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('工作空间配置必须是对象');
  const value = input as Record<string, unknown>;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 60) throw new Error('工作空间名称必须包含 1..60 个字符');
  const seed = Number(value.seed ?? 1);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 2_147_483_647) throw new Error('随机种子必须是 1..2147483647 的整数');
  const worldSpeed = Number(value.worldSpeed ?? 1);
  if (!Number.isFinite(worldSpeed) || worldSpeed <= 0 || worldSpeed > 60) throw new Error('世界速度必须在 (0, 60]');
  const defaultExperimentDays = Number(value.defaultExperimentDays ?? 30);
  if (!Number.isSafeInteger(defaultExperimentDays) || defaultExperimentDays < 1 || defaultExperimentDays > 365) {
    throw new Error('实验天数必须是 1..365 的整数');
  }
  if (!Array.isArray(value.worldKinds)) throw new Error('必须选择要加载的世界');
  const allowed = new Set<WorldKind>(['mem-on', 'mem-off', 'rumor']);
  const worldKinds = value.worldKinds.map((kind) => String(kind)) as WorldKind[];
  if (worldKinds.length < 1 || worldKinds.length > 3 || new Set(worldKinds).size !== worldKinds.length
      || worldKinds.some((kind) => !allowed.has(kind))) {
    throw new Error('请选择 1..3 个不重复的世界模板');
  }
  return {
    name,
    seed,
    worldSpeed,
    defaultExperimentDays,
    worldKinds,
    startPaused: value.startPaused !== false,
  };
}

async function buildWorkspace(
  input: unknown,
  options: ExperimentWorkspaceRuntimeOptions,
  databaseBasePath: string,
  checkBasePath: boolean,
): Promise<BuiltExperimentWorkspace> {
  const config = normalizeWorkspaceConfig(input);
  const worldIds = config.worldKinds.map((kind) => WORLD_ID_BY_KIND[kind]);
  const paths = assertFreshSelectedWorldDbPaths(databaseBasePath, worldIds, checkBasePath);
  const profileOverrides = options.profileOverrides?.();
  const worlds: ManagedWorld[] = [];
  try {
    for (const kind of config.worldKinds) {
      const id = WORLD_ID_BY_KIND[kind];
      worlds.push(createManagedWorld(id, kind, {
        seed: config.seed,
        gameMinutesPerTick: config.worldSpeed * 0.5,
        gateway: options.gateway,
        dbPath: paths[id] ?? ':memory:',
        profileOverrides,
      }));
    }
  } catch (error) {
    await disposeManagedWorlds(worlds);
    throw error;
  }
  const createdAt = new Date().toISOString();
  const meta: ExperimentWorkspaceMeta = {
    ...config,
    id: `ws-${createdAt.replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    createdAt,
    worldIds,
    worldCount: worlds.length,
    databaseBasePath,
    runtimeLogPath: runtimeLogPathForDatabase(databaseBasePath),
    profileSetHash: profileSetHash(worlds[0].world),
  };
  for (const managed of worlds) {
    managed.log.addEvent({
      id: randomUUID(), type: 'system', actorId: null, targetIds: [],
      description: `实验工作空间“${meta.name}”已创建，当前加载 ${meta.worldCount} 个世界。`,
      location: null, gameTime: managed.time.state.totalMinutes,
      payload: {
        kind: 'experiment_workspace_created', workspaceId: meta.id, workspaceName: meta.name,
        seed: meta.seed, worldSpeed: meta.worldSpeed, defaultExperimentDays: meta.defaultExperimentDays,
        loadedWorldKinds: meta.worldKinds, loadedWorldIds: meta.worldIds, profileSetHash: meta.profileSetHash,
      },
    });
  }
  return { meta, worlds };
}

export async function disposeManagedWorlds(worlds: readonly ManagedWorld[]): Promise<void> {
  if (!worlds.length) return;
  stopAllWorlds([...worlds]);
  await Promise.all(worlds.map((world) => world.loop.drain()));
  await Promise.all(worlds.map((world) => world.mind.dispose()));
  for (const world of worlds) {
    try { world.db.raw.close(); } catch { /* 已关闭的工作空间保持幂等 */ }
  }
}

function workspaceSummary(meta: ExperimentWorkspaceMeta, state: 'created' | 'activated'): string {
  return `workspace=${meta.id} state=${state} name=${JSON.stringify(meta.name)} worlds=${meta.worldIds.join(',')} seed=${meta.seed} speed=${meta.worldSpeed} days=${meta.defaultExperimentDays}`;
}

export function nextWorkspaceDatabasePath(initialPath: string): string {
  if (initialPath === ':memory:') return initialPath;
  const extension = extname(initialPath) || '.sqlite';
  const stem = basename(initialPath, extname(initialPath));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(dirname(initialPath), `${stem}-workspace-${stamp}-${randomUUID().slice(0, 8)}${extension}`);
}
