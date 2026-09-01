import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { LLMGateway } from '../llm/gateway';
import type { BackendRuntimeLog } from '../runtime/backend-log';
import { runtimeLogPathForDatabase } from '../runtime/backend-log';
import { assertFreshSelectedWorldDbPaths, worldDbPath, type TownWorldId } from '../cli/town-web-config';
import { profileSetHash } from './agent-profile';
import {
  createManagedWorld,
  stopAllWorlds,
  type ManagedWorld,
  type WorldKind,
} from './world-factory';
import {
  readWorkspaceResumePlan,
  saveWorkspaceCheckpoint,
  workspaceManifestPath,
} from './workspace-persistence';

export { workspaceManifestPath } from './workspace-persistence';

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

export interface WorkspaceArchiveFile {
  originalPath: string;
  archivedPath: string;
}

export interface WorkspaceDeletionArchive {
  deletedWorkspaceId: string;
  deletedWorkspaceName: string;
  deletedAt: string;
  archiveDirectory: string;
  manifestPath: string;
  recoverable: boolean;
  archivedFiles: WorkspaceArchiveFile[];
  missingFiles: string[];
  failedFiles: Array<{ path: string; reason: string }>;
}

/** 当前进程只挂载一个实验工作空间；替换时旧数据库完整封存，新世界使用全新文件。 */
export class ExperimentWorkspaceRuntime {
  private currentValue: BuiltExperimentWorkspace;
  private checkpointWriteCount = 0;
  private lastAutomaticCheckpointMinutes: number | null = null;

  private constructor(
    initial: BuiltExperimentWorkspace,
    private readonly options: ExperimentWorkspaceRuntimeOptions,
  ) {
    this.currentValue = initial;
    this.attachCheckpointWriters(initial);
    this.lastAutomaticCheckpointMinutes = alignedClockMinutes(initial.worlds);
  }

  static async create(
    input: unknown,
    options: ExperimentWorkspaceRuntimeOptions,
    initialDatabasePath: string,
    checkBasePath = false,
  ): Promise<ExperimentWorkspaceRuntime> {
    const initial = await buildWorkspace(
      input,
      options,
      initialDatabasePath,
      checkBasePath,
      options.runtimeLog?.filePath,
    );
    const runtime = new ExperimentWorkspaceRuntime(initial, options);
    try {
      runtime.saveCheckpointNow();
    } catch (error) {
      await disposeManagedWorlds(initial.worlds);
      throw error;
    }
    options.runtimeLog?.info('workspace', workspaceSummary(initial.meta, 'created'));
    return runtime;
  }

  /** 只从显式 base path 的原子清单恢复；所有世界先通过只读预检，再创建任何运行对象。 */
  static async resume(
    databaseBasePath: string,
    options: ExperimentWorkspaceRuntimeOptions,
  ): Promise<ExperimentWorkspaceRuntime> {
    const profileOverrides = options.profileOverrides?.();
    const plan = readWorkspaceResumePlan(databaseBasePath, profileOverrides);
    const worlds: ManagedWorld[] = [];
    try {
      for (let index = 0; index < plan.meta.worldKinds.length; index++) {
        const kind = plan.meta.worldKinds[index];
        const id = plan.meta.worldIds[index];
        worlds.push(createManagedWorld(id, kind, {
          seed: plan.meta.seed,
          gameMinutesPerTick: plan.meta.worldSpeed * 0.5,
          gateway: options.gateway,
          dbPath: worldDbPath(plan.meta.databaseBasePath, id),
          profileOverrides: plan.profileOverrides,
          runtimeCheckpoint: plan.checkpoints.get(id),
        }));
      }
    } catch (error) {
      closeUnactivatedWorlds(worlds);
      throw error;
    }
    try {
      for (const world of worlds) {
        world.mind.store.interruptActiveConversations(world.time.state.totalMinutes, '进程恢复');
      }
    } catch (error) {
      closeUnactivatedWorlds(worlds);
      throw error;
    }
    const built = { meta: plan.meta, worlds };
    options.runtimeLog?.switchFile(plan.meta.runtimeLogPath, plan.meta.id);
    const runtime = new ExperimentWorkspaceRuntime(built, options);
    options.runtimeLog?.info('workspace', workspaceSummary(plan.meta, 'resumed'));
    return runtime;
  }

  get current(): BuiltExperimentWorkspace { return this.currentValue; }

  async replace(input: unknown): Promise<BuiltExperimentWorkspace> {
    const config = normalizeWorkspaceConfig(input);
    const next = await buildWorkspace(config, this.options, this.options.nextDatabasePath(), false);
    const previous = this.currentValue;
    try {
      saveWorkspaceCheckpoint(next.meta, next.worlds);
      await disposeManagedWorlds(previous.worlds, () => saveWorkspaceCheckpoint(previous.meta, previous.worlds));
    } catch (error) {
      await disposeManagedWorlds(next.worlds);
      throw error;
    }
    this.detachCheckpointWriters(previous);
    this.options.runtimeLog?.switchFile(next.meta.runtimeLogPath, next.meta.id);
    this.currentValue = next;
    this.lastAutomaticCheckpointMinutes = alignedClockMinutes(next.worlds);
    this.attachCheckpointWriters(next);
    this.options.runtimeLog?.info('workspace', workspaceSummary(next.meta, 'activated'));
    return next;
  }

  /** 将当前实验迁入本地回收区，并打开一个暂停的替代工作空间以保持服务可用。 */
  async replaceAndArchive(input: unknown): Promise<{
    built: BuiltExperimentWorkspace;
    archive: WorkspaceDeletionArchive;
  }> {
    const config = normalizeWorkspaceConfig(input);
    const next = await buildWorkspace(config, this.options, this.options.nextDatabasePath(), false);
    const previous = this.currentValue;
    let archiveDirectory: string;
    try {
      archiveDirectory = prepareWorkspaceArchiveDirectory(previous.meta);
    } catch (error) {
      await disposeManagedWorlds(next.worlds);
      throw error;
    }
    try {
      saveWorkspaceCheckpoint(next.meta, next.worlds);
      await disposeManagedWorlds(previous.worlds, () => saveWorkspaceCheckpoint(previous.meta, previous.worlds));
    } catch (error) {
      await disposeManagedWorlds(next.worlds);
      throw error;
    }
    this.detachCheckpointWriters(previous);
    this.options.runtimeLog?.switchFile(next.meta.runtimeLogPath, next.meta.id);
    this.currentValue = next;
    this.lastAutomaticCheckpointMinutes = alignedClockMinutes(next.worlds);
    this.attachCheckpointWriters(next);
    const archive = archiveWorkspaceArtifacts(previous.meta, archiveDirectory, next.meta.runtimeLogPath);
    this.options.runtimeLog?.info(
      'workspace',
      `workspace=${previous.meta.id} deleted=true recoverable=${archive.recoverable} archive=${JSON.stringify(archive.archiveDirectory)} failed=${archive.failedFiles.length}`,
    );
    return { built: next, archive };
  }

  async dispose(): Promise<void> {
    const current = this.currentValue;
    await disposeManagedWorlds(current.worlds, () => saveWorkspaceCheckpoint(current.meta, current.worlds));
    this.detachCheckpointWriters(current);
  }

  async saveCheckpoint(): Promise<void> {
    this.saveCheckpointNow();
  }

  checkpointStats(): { writes: number; lastAutomaticGameMinutes: number | null } {
    return { writes: this.checkpointWriteCount, lastAutomaticGameMinutes: this.lastAutomaticCheckpointMinutes };
  }

  private saveCheckpointNow(): void {
    saveWorkspaceCheckpoint(this.currentValue.meta, this.currentValue.worlds);
    this.checkpointWriteCount += 1;
    this.lastAutomaticCheckpointMinutes = alignedClockMinutes(this.currentValue.worlds);
  }

  private saveCheckpointIfDue(): void {
    const now = alignedClockMinutes(this.currentValue.worlds);
    if (now === null) return;
    if (this.lastAutomaticCheckpointMinutes !== null && now - this.lastAutomaticCheckpointMinutes < 5) return;
    this.saveCheckpointNow();
  }

  private attachCheckpointWriters(built: BuiltExperimentWorkspace): void {
    for (const world of built.worlds) {
      world.loop.setCheckpointWriter(() => {
        if (this.currentValue === built) this.saveCheckpointIfDue();
      });
    }
  }

  private detachCheckpointWriters(built: BuiltExperimentWorkspace): void {
    for (const world of built.worlds) world.loop.setCheckpointWriter(null);
  }
}

function alignedClockMinutes(worlds: readonly ManagedWorld[]): number | null {
  const values = worlds.map((world) => world.time.checkpoint().elapsedMinutes);
  if (!values.length || values.some((value) => value !== values[0])) return null;
  return values[0];
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
  currentRuntimeLogPath?: string,
): Promise<BuiltExperimentWorkspace> {
  const config = normalizeWorkspaceConfig(input);
  databaseBasePath = databaseBasePath === ':memory:' ? databaseBasePath : resolve(databaseBasePath);
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
    runtimeLogPath: currentRuntimeLogPath ?? runtimeLogPathForDatabase(databaseBasePath),
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

function prepareWorkspaceArchiveDirectory(meta: ExperimentWorkspaceMeta): string {
  const basis = meta.databaseBasePath === ':memory:' ? meta.runtimeLogPath : meta.databaseBasePath;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeId = meta.id.replace(/[^A-Za-z0-9_.-]/g, '_');
  const directory = join(dirname(basis), '.multiagent-town-trash', `${stamp}-${safeId}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function archiveWorkspaceArtifacts(
  meta: ExperimentWorkspaceMeta,
  archiveDirectory: string,
  protectedRuntimeLogPath: string,
): WorkspaceDeletionArchive {
  const deletedAt = new Date().toISOString();
  const requiredDatabaseFiles = meta.databaseBasePath === ':memory:'
    ? []
    : meta.worldIds.map((worldId) => worldDbPath(meta.databaseBasePath, worldId));
  const databaseFiles = meta.databaseBasePath === ':memory:'
    ? []
    : [
        meta.databaseBasePath,
        workspaceManifestPath(meta.databaseBasePath),
        ...requiredDatabaseFiles.flatMap((path) => [path, `${path}-wal`, `${path}-shm`]),
      ];
  const candidates = [...new Set([
    ...databaseFiles,
    ...(meta.runtimeLogPath === protectedRuntimeLogPath ? [] : [meta.runtimeLogPath]),
  ])];
  const archivedFiles: WorkspaceArchiveFile[] = [];
  const missingFiles: string[] = [];
  const failedFiles: Array<{ path: string; reason: string }> = [];
  for (const originalPath of candidates) {
    if (!existsSync(originalPath)) {
      missingFiles.push(originalPath);
      continue;
    }
    const archivedPath = join(archiveDirectory, basename(originalPath));
    try {
      renameSync(originalPath, archivedPath);
      archivedFiles.push({ originalPath, archivedPath });
    } catch (error) {
      failedFiles.push({
        path: originalPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const manifestPath = join(archiveDirectory, 'workspace-deletion.json');
  const archivedOriginalPaths = new Set(archivedFiles.map((file) => file.originalPath));
  const archive: WorkspaceDeletionArchive = {
    deletedWorkspaceId: meta.id,
    deletedWorkspaceName: meta.name,
    deletedAt,
    archiveDirectory,
    manifestPath,
    recoverable: meta.databaseBasePath !== ':memory:'
      && requiredDatabaseFiles.every((path) => archivedOriginalPaths.has(path))
      && failedFiles.length === 0,
    archivedFiles,
    missingFiles,
    failedFiles,
  };
  try {
    writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, workspace: meta, archive }, null, 2)}\n`, 'utf8');
  } catch (error) {
    archive.recoverable = false;
    archive.failedFiles.push({
      path: manifestPath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return archive;
}

export async function disposeManagedWorlds(
  worlds: readonly ManagedWorld[],
  beforeClose?: () => void,
): Promise<void> {
  if (!worlds.length) return;
  stopAllWorlds([...worlds]);
  for (const world of worlds) world.social.dispose(!!beforeClose);
  await Promise.all(worlds.map((world) => world.loop.drain()));
  await Promise.all(worlds.map((world) => world.mind.dispose({
    gameTime: world.time.state.totalMinutes,
    reason: '实验工作空间关闭',
  })));
  let checkpointError: unknown = null;
  try {
    beforeClose?.();
  } catch (error) {
    checkpointError = error;
  }
  for (const world of worlds) {
    try { world.db.raw.close(); } catch { /* 已关闭的工作空间保持幂等 */ }
  }
  if (checkpointError) throw checkpointError;
}

function closeUnactivatedWorlds(worlds: readonly ManagedWorld[]): void {
  for (const world of worlds) {
    world.loop.stop();
    world.social.dispose();
    try { world.db.raw.close(); } catch { /* 未激活恢复保持清理幂等 */ }
  }
}

function workspaceSummary(meta: ExperimentWorkspaceMeta, state: 'created' | 'activated' | 'resumed'): string {
  return `workspace=${meta.id} state=${state} name=${JSON.stringify(meta.name)} worlds=${meta.worldIds.join(',')} seed=${meta.seed} speed=${meta.worldSpeed} days=${meta.defaultExperimentDays}`;
}

export function nextWorkspaceDatabasePath(initialPath: string): string {
  if (initialPath === ':memory:') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return join(process.cwd(), 'data', 'runs', `town-workspace-${stamp}-${randomUUID().slice(0, 8)}.sqlite`);
  }
  const extension = extname(initialPath) || '.sqlite';
  const stem = basename(initialPath, extname(initialPath));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(dirname(initialPath), `${stem}-workspace-${stamp}-${randomUUID().slice(0, 8)}${extension}`);
}
