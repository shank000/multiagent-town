import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { Agent, AgentState, Decision, Tile, WorldObjectState } from '../core/types';
import { GRID_H, GRID_W, type WorldState } from '../core/world';
import { TimeEngine, type TimeCheckpoint } from '../core/time';
import { worldDbPath, type TownWorldId } from '../cli/town-web-config';
import { runtimeLogPathForDatabase } from '../runtime/backend-log';
import {
  applyAgentProfile,
  normalizeAgentProfile,
  profileDefinitionOf,
  profileSetHash,
  type AgentProfileDefinition,
} from './agent-profile';
import { validatePartnerChoiceCheckpoint } from './experiment';
import {
  validateExperimentRunnerCheckpoint,
  type ExperimentRunnerCheckpoint,
} from './experiment-runner';
import { validateMindRuntimeCheckpoint, type MindRuntimeCheckpoint } from './mind';
import { validateSocialTickerCheckpoint, type SocialTickerCheckpoint } from './social';
import { buildTown, DEFAULT_SEED } from './seed';
import type { ExperimentWorkspaceMeta } from './workspace';
import type { ManagedWorld, WorldKind } from './world-factory';

export const WORKSPACE_MANIFEST_SCHEMA_VERSION = 1;
export const WORLD_CHECKPOINT_SCHEMA_VERSION = 1;

interface AgentRuntimeCheckpoint {
  id: string;
  state: AgentState;
  locationId: string;
  x: number;
  y: number;
  path: Tile[];
  pathProgress: number;
  action: Decision | null;
  actionEndsAt: number;
  lastDecisionAt: number;
  thought: string | null;
}

interface ObjectRuntimeCheckpoint {
  id: string;
  state: WorldObjectState | null;
}

export interface WorldRuntimeCheckpoint {
  schemaVersion: 1;
  checkpointSetId: string;
  configurationHash: string;
  savedAt: string;
  workspaceId: string;
  worldId: TownWorldId;
  kind: WorldKind;
  seed: number;
  worldSpeed: number;
  profileSetHash: string;
  clock: TimeCheckpoint;
  agents: AgentRuntimeCheckpoint[];
  objects: ObjectRuntimeCheckpoint[];
  experiment: ExperimentRunnerCheckpoint | null;
  mind: MindRuntimeCheckpoint;
  social: SocialTickerCheckpoint;
}

export interface WorkspaceManifest {
  schemaVersion: 1;
  checkpointSchemaVersion: 1;
  checkpointSetId: string;
  configurationHash: string;
  savedAt: string;
  workspace: ExperimentWorkspaceMeta;
  profiles: Record<string, AgentProfileDefinition>;
  databases: Array<{ worldId: TownWorldId; kind: WorldKind; path: string }>;
}

export interface WorkspaceResumePlan {
  meta: ExperimentWorkspaceMeta;
  checkpoints: ReadonlyMap<TownWorldId, WorldRuntimeCheckpoint>;
  profileOverrides?: Readonly<Record<string, unknown>>;
}

export function workspaceManifestPath(databaseBasePath: string): string {
  if (databaseBasePath === ':memory:') throw new Error('内存工作空间没有持久化清单');
  return `${resolve(databaseBasePath)}.workspace.json`;
}

export function workspaceConfigurationHash(meta: ExperimentWorkspaceMeta): string {
  return createHash('sha256').update(JSON.stringify({
    name: meta.name,
    seed: meta.seed,
    worldSpeed: meta.worldSpeed,
    defaultExperimentDays: meta.defaultExperimentDays,
    worldKinds: meta.worldKinds,
    startPaused: meta.startPaused,
    worldIds: meta.worldIds,
    profileSetHash: meta.profileSetHash,
  })).digest('hex');
}

/** 同一 set id 先事务写入全部世界，再原子替换清单；中途崩溃会在恢复预检中整体拒绝。 */
export function saveWorkspaceCheckpoint(meta: ExperimentWorkspaceMeta, worlds: readonly ManagedWorld[]): void {
  if (meta.databaseBasePath === ':memory:') return;
  const clockValues = worlds.map((managed) => managed.time.checkpoint().elapsedMinutes);
  if (!clockValues.length || clockValues.some((value) => value !== clockValues[0])) {
    throw new Error('平行世界精确时钟不一致，拒绝保存检查点');
  }
  const currentProfileHashes = new Set(worlds.map((managed) => profileSetHash(managed.world)));
  if (currentProfileHashes.size !== 1) throw new Error('平行世界档案指纹不一致，拒绝保存检查点');
  meta.profileSetHash = [...currentProfileHashes][0];
  assertWorldRegistry(meta, worlds);
  const checkpointSetId = randomUUID();
  const savedAt = new Date().toISOString();
  const configurationHash = workspaceConfigurationHash(meta);
  for (const managed of worlds) {
    const captured = captureWorldCheckpoint(managed, meta, checkpointSetId, configurationHash, savedAt);
    const checkpoint = validateWorldCheckpoint(captured, {
      template: managed.world,
      workspaceId: meta.id,
      worldId: managed.meta.id as TownWorldId,
      kind: managed.meta.kind,
      seed: meta.seed,
      worldSpeed: meta.worldSpeed,
      profileSetHash: meta.profileSetHash,
      checkpointSetId,
      configurationHash,
    });
    writeWorldCheckpoint(managed.db.raw, checkpoint);
  }
  const manifest: WorkspaceManifest = {
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    checkpointSchemaVersion: WORLD_CHECKPOINT_SCHEMA_VERSION,
    checkpointSetId,
    configurationHash,
    savedAt,
    workspace: { ...meta, databaseBasePath: resolve(meta.databaseBasePath) },
    profiles: profileDefinitionsForWorld(worlds[0].world),
    databases: worlds.map((managed) => ({
      worldId: managed.meta.id as TownWorldId,
      kind: managed.meta.kind,
      path: resolve(managed.dbPath),
    })),
  };
  writeManifestAtomically(workspaceManifestPath(meta.databaseBasePath), manifest);
}

export function readWorkspaceResumePlan(
  databaseBasePath: string,
  profileOverrides?: Readonly<Record<string, unknown>>,
): WorkspaceResumePlan {
  const basePath = normalizePersistentBasePath(databaseBasePath);
  const manifestPath = workspaceManifestPath(basePath);
  assertSafeRegularFile(manifestPath, '工作空间清单');
  if (statSync(manifestPath).size > 1_048_576) throw new Error('工作空间清单过大，拒绝恢复');
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`工作空间清单损坏：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const manifest = validateManifest(input, basePath);
  const manifestProfileHash = profileHashForOverrides(manifest.profiles);
  if (manifest.workspace.profileSetHash !== manifestProfileHash) {
    throw new Error('工作空间档案指纹错配，拒绝恢复');
  }
  if (profileOverrides && Object.keys(profileOverrides).length > 0
      && profileHashForOverrides(profileOverrides) !== manifestProfileHash) {
    throw new Error('当前所选居民档案与工作空间档案指纹错配，拒绝恢复');
  }
  if (manifest.configurationHash !== workspaceConfigurationHash(manifest.workspace)) {
    throw new Error('工作空间配置指纹错配，拒绝恢复');
  }

  const checkpoints = new Map<TownWorldId, WorldRuntimeCheckpoint>();
  let commonElapsedMinutes: number | null = null;
  for (const database of manifest.databases) {
    assertSafeRegularFile(database.path, `世界 ${database.worldId} 数据库`);
    const raw = readCheckpointJson(database.path);
    const template = profiledTown(manifest.profiles);
    const checkpoint = validateWorldCheckpoint(raw, {
      template,
      workspaceId: manifest.workspace.id,
      worldId: database.worldId,
      kind: database.kind,
      seed: manifest.workspace.seed,
      worldSpeed: manifest.workspace.worldSpeed,
      profileSetHash: manifestProfileHash,
      checkpointSetId: manifest.checkpointSetId,
      configurationHash: manifest.configurationHash,
    });
    if (commonElapsedMinutes === null) commonElapsedMinutes = checkpoint.clock.elapsedMinutes;
    else if (checkpoint.clock.elapsedMinutes !== commonElapsedMinutes) {
      throw new Error('平行世界时钟检查点不一致，拒绝部分恢复');
    }
    checkpoints.set(database.worldId, checkpoint);
  }
  return { meta: manifest.workspace, checkpoints, profileOverrides: manifest.profiles };
}

export function restoreManagedWorldCheckpoint(
  managed: Pick<ManagedWorld, 'world' | 'time' | 'experiment' | 'mind' | 'social'>,
  input: unknown,
): void {
  const checkpoint = input as WorldRuntimeCheckpoint;
  managed.time.restore(checkpoint.clock);
  const agents = new Map(checkpoint.agents.map((agent) => [agent.id, agent]));
  for (const target of managed.world.allAgents()) {
    const source = agents.get(target.id)!;
    target.state = source.state;
    target.locationId = source.locationId;
    target.x = source.x;
    target.y = source.y;
    target.path = source.path.map((tile) => ({ ...tile }));
    target.pathProgress = source.pathProgress;
    target.action = source.action ? cloneDecision(source.action) : null;
    target.actionEndsAt = source.actionEndsAt;
    target.lastDecisionAt = source.lastDecisionAt;
    target.thought = source.thought;
  }
  const objects = new Map(checkpoint.objects.map((object) => [object.id, object]));
  for (const target of managed.world.allObjects()) {
    const state = objects.get(target.id)!.state;
    if (state) target.state = { ...state };
    else delete target.state;
  }
  if (managed.experiment && checkpoint.experiment) {
    managed.experiment.restore(checkpoint.experiment, managed.time.state.totalMinutes);
  }
  managed.mind.restore(checkpoint.mind, managed.world, managed.time.state.totalMinutes);
  managed.social.restore(
    checkpoint.social,
    new Set(managed.world.allAgents().map((agent) => agent.id)),
    managed.time.state.totalMinutes,
  );
}

function captureWorldCheckpoint(
  managed: ManagedWorld,
  meta: ExperimentWorkspaceMeta,
  checkpointSetId: string,
  configurationHash: string,
  savedAt: string,
): WorldRuntimeCheckpoint {
  return {
    schemaVersion: WORLD_CHECKPOINT_SCHEMA_VERSION,
    checkpointSetId,
    configurationHash,
    savedAt,
    workspaceId: meta.id,
    worldId: managed.meta.id as TownWorldId,
    kind: managed.meta.kind,
    seed: meta.seed,
    worldSpeed: meta.worldSpeed,
    profileSetHash: meta.profileSetHash,
    clock: managed.time.checkpoint(),
    agents: managed.world.allAgents().map(captureAgent),
    objects: managed.world.allObjects().map((object) => ({
      id: object.id,
      state: object.state ? { ...object.state } : null,
    })),
    experiment: managed.experiment?.checkpoint() ?? null,
    mind: managed.mind.checkpoint(),
    social: managed.social.checkpoint(),
  };
}

function captureAgent(agent: Agent): AgentRuntimeCheckpoint {
  const pending = agent.state === 'thinking';
  return {
    id: agent.id,
    state: pending ? 'idle' : agent.state,
    locationId: agent.locationId,
    x: agent.x,
    y: agent.y,
    path: pending ? [] : agent.path.map((tile) => ({ ...tile })),
    pathProgress: pending ? 0 : agent.pathProgress,
    action: pending || !agent.action ? null : cloneDecision(agent.action),
    actionEndsAt: pending ? 0 : agent.actionEndsAt,
    lastDecisionAt: agent.lastDecisionAt,
    thought: pending ? null : agent.thought,
  };
}

function cloneDecision(value: Decision): Decision {
  return {
    thought: value.thought,
    action: { ...value.action },
    durationMinutes: value.durationMinutes,
  };
}

function writeWorldCheckpoint(db: DatabaseSync, checkpoint: WorldRuntimeCheckpoint): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO runtime_checkpoint(slot, schema_version, checkpoint_json, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(slot) DO UPDATE SET schema_version = excluded.schema_version,
        checkpoint_json = excluded.checkpoint_json, updated_at = excluded.updated_at`)
      .run(WORLD_CHECKPOINT_SCHEMA_VERSION, JSON.stringify(checkpoint), checkpoint.savedAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 原始写入错误优先 */ }
    throw error;
  }
}

function writeManifestAtomically(path: string, manifest: WorkspaceManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = resolve(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  let descriptor: number | null = null;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    descriptor = openSync(temporaryPath, 'r+');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function validateManifest(input: unknown, basePath: string): WorkspaceManifest {
  const value = record(input, '工作空间清单');
  if (value.schemaVersion !== WORKSPACE_MANIFEST_SCHEMA_VERSION
      || value.checkpointSchemaVersion !== WORLD_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error('工作空间清单版本不受支持');
  }
  const checkpointSetId = boundedString(value.checkpointSetId, '清单 checkpointSetId', 8, 100);
  const configurationHash = hashString(value.configurationHash, '清单配置指纹');
  const savedAt = isoTimestamp(value.savedAt, '清单保存时间');
  const workspace = validateWorkspaceMeta(value.workspace, basePath);
  const profiles = validateManifestProfiles(value.profiles);
  if (!Array.isArray(value.databases) || value.databases.length !== workspace.worldIds.length) {
    throw new Error('工作空间清单数据库列表与世界列表不一致');
  }
  const databases = value.databases.map((item, index) => {
    const row = record(item, '工作空间数据库条目');
    const worldId = workspace.worldIds[index];
    const kind = workspace.worldKinds[index];
    const expectedPath = resolve(worldDbPath(basePath, worldId));
    if (row.worldId !== worldId || row.kind !== kind || typeof row.path !== 'string' || resolve(row.path) !== expectedPath) {
      throw new Error(`世界 ${worldId} 数据库路径或种类与清单错配`);
    }
    return { worldId, kind, path: expectedPath };
  });
  return {
    schemaVersion: 1,
    checkpointSchemaVersion: 1,
    checkpointSetId,
    configurationHash,
    savedAt,
    workspace,
    profiles,
    databases,
  };
}

function validateWorkspaceMeta(input: unknown, basePath: string): ExperimentWorkspaceMeta {
  const value = record(input, '工作空间元数据');
  const worldKinds = validateWorldKinds(value.worldKinds);
  const expectedIds = worldKinds.map(worldIdForKind);
  if (!Array.isArray(value.worldIds) || value.worldIds.length !== expectedIds.length
      || value.worldIds.some((item, index) => item !== expectedIds[index])) {
    throw new Error('工作空间世界 ID 与种类错配');
  }
  if (value.worldCount !== expectedIds.length) throw new Error('工作空间世界数量错配');
  if (typeof value.databaseBasePath !== 'string' || resolve(value.databaseBasePath) !== basePath) {
    throw new Error('工作空间数据库 base path 与显式恢复路径错配');
  }
  const name = boundedString(value.name, '工作空间名称', 1, 60);
  const id = boundedString(value.id, '工作空间 ID', 1, 100);
  const createdAt = isoTimestamp(value.createdAt, '工作空间创建时间');
  const seed = safeInteger(value.seed, '工作空间种子', 1, 2_147_483_647);
  const worldSpeed = finiteNumber(value.worldSpeed, '工作空间速度', Number.MIN_VALUE, 60);
  const defaultExperimentDays = safeInteger(value.defaultExperimentDays, '默认实验天数', 1, 365);
  if (typeof value.startPaused !== 'boolean') throw new Error('工作空间暂停配置无效');
  const runtimeLogPath = boundedString(value.runtimeLogPath, '运行日志路径', 1, 32_768);
  if (resolve(runtimeLogPath) !== resolve(runtimeLogPathForDatabase(basePath))) {
    throw new Error('运行日志路径超出工作空间路径隔离范围');
  }
  const hash = hashString(value.profileSetHash, '档案指纹');
  return {
    name,
    id,
    createdAt,
    seed,
    worldSpeed,
    defaultExperimentDays,
    worldKinds,
    startPaused: value.startPaused,
    worldIds: expectedIds,
    worldCount: expectedIds.length,
    databaseBasePath: basePath,
    runtimeLogPath,
    profileSetHash: hash,
  };
}

function validateWorldCheckpoint(
  input: unknown,
  expected: {
    template: WorldState;
    workspaceId: string;
    worldId: TownWorldId;
    kind: WorldKind;
    seed: number;
    worldSpeed: number;
    profileSetHash: string;
    checkpointSetId: string;
    configurationHash: string;
  },
): WorldRuntimeCheckpoint {
  const value = record(input, `世界 ${expected.worldId} 检查点`);
  if (value.schemaVersion !== WORLD_CHECKPOINT_SCHEMA_VERSION
      || value.workspaceId !== expected.workspaceId
      || value.worldId !== expected.worldId
      || value.kind !== expected.kind
      || value.seed !== expected.seed
      || value.worldSpeed !== expected.worldSpeed
      || value.profileSetHash !== expected.profileSetHash
      || value.checkpointSetId !== expected.checkpointSetId
      || value.configurationHash !== expected.configurationHash) {
    throw new Error(`世界 ${expected.worldId} 检查点身份、seed、种类或配置指纹错配`);
  }
  const savedAt = isoTimestamp(value.savedAt, `世界 ${expected.worldId} 保存时间`);
  const clockEngine = new TimeEngine(expected.worldSpeed * 0.5);
  clockEngine.restore(value.clock);
  const clock = clockEngine.checkpoint();
  const now = Math.floor(clock.elapsedMinutes);
  const agents = validateAgents(value.agents, expected.template, now);
  const objects = validateObjects(value.objects, expected.template, now);
  let experiment: ExperimentRunnerCheckpoint | null = null;
  if (expected.kind === 'rumor') {
    if (value.experiment !== null) throw new Error('谣言世界不应包含伙伴实验检查点');
  } else {
    experiment = validateExperimentRunnerCheckpoint(value.experiment);
    validatePartnerChoiceCheckpoint(experiment.partner, expected.template, now);
  }
  const mind = validateMindRuntimeCheckpoint(value.mind, now, expected.template);
  const social = validateSocialTickerCheckpoint(
    value.social,
    new Set(expected.template.allAgents().map((agent) => agent.id)),
    now,
  );
  return {
    schemaVersion: 1,
    checkpointSetId: expected.checkpointSetId,
    configurationHash: expected.configurationHash,
    savedAt,
    workspaceId: expected.workspaceId,
    worldId: expected.worldId,
    kind: expected.kind,
    seed: expected.seed,
    worldSpeed: expected.worldSpeed,
    profileSetHash: expected.profileSetHash,
    clock,
    agents,
    objects,
    experiment,
    mind,
    social,
  };
}

function validateAgents(input: unknown, world: WorldState, now: number): AgentRuntimeCheckpoint[] {
  const expectedIds = world.allAgents().map((agent) => agent.id).sort();
  if (!Array.isArray(input) || input.length !== 6 || input.length !== expectedIds.length) {
    throw new Error('运行检查点必须包含完整的 6 位居民');
  }
  const seen = new Set<string>();
  const agents = input.map((item) => validateAgent(item, world, seen, now));
  if (agents.map((agent) => agent.id).sort().some((id, index) => id !== expectedIds[index])) {
    throw new Error('运行检查点居民 ID 集合错配');
  }
  return agents;
}

function validateAgent(input: unknown, world: WorldState, seen: Set<string>, now: number): AgentRuntimeCheckpoint {
  const value = record(input, '居民运行检查点');
  const id = boundedString(value.id, '居民 ID', 1, 200);
  if (!world.hasAgent(id) || seen.has(id)) throw new Error(`居民检查点包含未知或重复 ID：${id}`);
  seen.add(id);
  if (value.state !== 'idle' && value.state !== 'moving' && value.state !== 'acting') {
    throw new Error(`居民 ${id} 状态不可跨进程恢复`);
  }
  const state = value.state;
  const locationId = boundedString(value.locationId, `居民 ${id} 位置`, 1, 200);
  if (!world.hasObject(locationId)) throw new Error(`居民 ${id} 引用了未知位置对象`);
  const x = safeInteger(value.x, `居民 ${id} x`, 0, GRID_W - 1);
  const y = safeInteger(value.y, `居民 ${id} y`, 0, GRID_H - 1);
  const path = validatePath(value.path, world, id);
  const pathProgress = finiteNumber(value.pathProgress, `居民 ${id} 路径进度`, 0, GRID_W * GRID_H * 100);
  const action = validateDecision(value.action, world, id);
  if ((state === 'moving' || state === 'acting') && action === null) throw new Error(`居民 ${id} 活动态缺少动作`);
  if (state === 'idle' && action !== null) throw new Error(`居民 ${id} idle 状态不能保留动作`);
  if (state === 'moving' && path.length === 0) throw new Error(`居民 ${id} 移动态缺少路径`);
  if (state === 'moving') {
    if (pathProgress >= path.length - 1) throw new Error(`居民 ${id} 移动态路径进度超出未完成路径`);
    const currentTile = path[Math.floor(pathProgress)];
    if (!currentTile || currentTile.x !== x || currentTile.y !== y) throw new Error(`居民 ${id} 移动态坐标与路径进度错配`);
  }
  const actionEndsAt = finiteNumber(value.actionEndsAt, `居民 ${id} 动作结束时间`, 0, Number.MAX_SAFE_INTEGER);
  const lastDecisionAt = finiteNumber(value.lastDecisionAt, `居民 ${id} 决策时间`, 0, now);
  const thought = nullableBoundedString(value.thought, `居民 ${id} 思考`, 20_000);
  return {
    id, state, locationId, x, y, path, pathProgress, action, actionEndsAt, lastDecisionAt, thought,
  };
}

function validatePath(input: unknown, world: WorldState, agentId: string): Tile[] {
  if (!Array.isArray(input) || input.length > GRID_W * GRID_H) throw new Error(`居民 ${agentId} 路径长度无效`);
  const path = input.map((item) => {
    const value = record(item, `居民 ${agentId} 路径坐标`);
    const x = safeInteger(value.x, `居民 ${agentId} 路径 x`, 0, GRID_W - 1);
    const y = safeInteger(value.y, `居民 ${agentId} 路径 y`, 0, GRID_H - 1);
    if (!world.walkable(x, y)) throw new Error(`居民 ${agentId} 路径越过不可通行边界`);
    return { x, y };
  });
  for (let index = 1; index < path.length; index++) {
    if (Math.abs(path[index].x - path[index - 1].x) + Math.abs(path[index].y - path[index - 1].y) !== 1) {
      throw new Error(`居民 ${agentId} 路径包含非相邻坐标`);
    }
  }
  return path;
}

function validateDecision(input: unknown, world: WorldState, agentId: string): Decision | null {
  if (input === null) return null;
  const value = record(input, `居民 ${agentId} 动作`);
  const action = record(value.action, `居民 ${agentId} 动作内容`);
  if (action.type !== 'move_to' && action.type !== 'interact' && action.type !== 'idle') {
    throw new Error(`居民 ${agentId} 动作类型无效`);
  }
  let target: string | null = null;
  if (action.type === 'idle') {
    if (action.target !== null) throw new Error(`居民 ${agentId} idle 动作目标无效`);
  } else {
    target = boundedString(action.target, `居民 ${agentId} 动作目标`, 1, 200);
    if (!world.hasObject(target)) throw new Error(`居民 ${agentId} 动作引用未知对象`);
  }
  return {
    thought: boundedString(value.thought, `居民 ${agentId} 动作思考`, 0, 20_000),
    action: {
      type: action.type,
      target,
      verb: boundedString(action.verb, `居民 ${agentId} 动作描述`, 1, 500),
    },
    durationMinutes: finiteNumber(value.durationMinutes, `居民 ${agentId} 动作时长`, 1, 1440),
  };
}

function validateObjects(input: unknown, world: WorldState, now: number): ObjectRuntimeCheckpoint[] {
  const expectedIds = world.allObjects().map((object) => object.id).sort();
  if (!Array.isArray(input) || input.length !== expectedIds.length) throw new Error('动态物件检查点数量错配');
  const seen = new Set<string>();
  const objects = input.map((item) => {
    const value = record(item, '动态物件检查点');
    const id = boundedString(value.id, '物件 ID', 1, 200);
    if (!world.hasObject(id) || seen.has(id)) throw new Error(`物件检查点包含未知或重复 ID：${id}`);
    seen.add(id);
    if (value.state === null) return { id, state: null };
    const state = record(value.state, `物件 ${id} 状态`);
    const updatedGameTime = finiteNumber(state.updatedGameTime, `物件 ${id} 更新时间`, 0, now);
    const expiresGameTime = finiteNumber(state.expiresGameTime, `物件 ${id} 过期时间`, updatedGameTime, Number.MAX_SAFE_INTEGER);
    return {
      id,
      state: {
        label: boundedString(state.label, `物件 ${id} 状态标签`, 0, 2_000),
        detail: boundedString(state.detail, `物件 ${id} 状态详情`, 0, 20_000),
        updatedGameTime,
        expiresGameTime,
      },
    };
  });
  if (objects.map((object) => object.id).sort().some((id, index) => id !== expectedIds[index])) {
    throw new Error('动态物件 ID 集合错配');
  }
  return objects;
}

function readCheckpointJson(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const table = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'runtime_checkpoint'").get();
    if (!table) throw new Error('缺少 runtime_checkpoint 表');
    const row = db.prepare('SELECT schema_version, checkpoint_json FROM runtime_checkpoint WHERE slot = 1').get() as
      { schema_version: number; checkpoint_json: string } | undefined;
    if (!row || row.schema_version !== WORLD_CHECKPOINT_SCHEMA_VERSION) throw new Error('缺少受支持的运行检查点');
    if (Buffer.byteLength(row.checkpoint_json, 'utf8') > 4_194_304) throw new Error('运行检查点过大');
    return JSON.parse(row.checkpoint_json);
  } catch (error) {
    throw new Error(`数据库 ${path} 的运行检查点损坏：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    db.close();
  }
}

function assertWorldRegistry(meta: ExperimentWorkspaceMeta, worlds: readonly ManagedWorld[]): void {
  if (worlds.length !== meta.worldIds.length) throw new Error('活动世界数量与工作空间元数据不一致');
  for (let index = 0; index < worlds.length; index++) {
    const managed = worlds[index];
    const expectedPath = resolve(worldDbPath(meta.databaseBasePath, meta.worldIds[index]));
    if (managed.meta.id !== meta.worldIds[index] || managed.meta.kind !== meta.worldKinds[index]
        || resolve(managed.dbPath) !== expectedPath || profileSetHash(managed.world) !== meta.profileSetHash) {
      throw new Error('活动世界注册表、路径或档案指纹错配');
    }
  }
}

function normalizePersistentBasePath(input: string): string {
  if (!input || input === ':memory:') throw new Error('显式恢复必须指定持久化数据库 base path');
  const path = resolve(input);
  if (dirname(path) === path) throw new Error('数据库 base path 不能是文件系统根目录');
  return path;
}

function assertSafeRegularFile(path: string, label: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label}不存在或不可访问：${path}`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label}必须是非符号链接的普通文件：${path}`);
}

function profiledTown(profileOverrides?: Readonly<Record<string, unknown>>): WorldState {
  const world = buildTown(DEFAULT_SEED);
  const agentIndex = new Map(world.allAgents().map((agent, index) => [agent.id, index]));
  for (const [agentId, rawProfile] of Object.entries(profileOverrides ?? {})) {
    if (!world.hasAgent(agentId)) throw new Error(`居民档案配置包含未知 ID：${agentId}`);
    const agent = world.getAgent(agentId);
    const profile = normalizeAgentProfile(rawProfile, agent, world, agentIndex.get(agentId) ?? 0);
    applyAgentProfile(world, agentId, profile, { resetRuntime: true });
  }
  return world;
}

function profileHashForOverrides(profileOverrides?: Readonly<Record<string, unknown>>): string {
  return profileSetHash(profiledTown(profileOverrides));
}

function profileDefinitionsForWorld(world: WorldState): Record<string, AgentProfileDefinition> {
  return Object.fromEntries(world.allAgents()
    .map((agent, index) => [agent.id, profileDefinitionOf(agent, index)] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
}

function validateManifestProfiles(input: unknown): Record<string, AgentProfileDefinition> {
  const value = record(input, '工作空间居民档案配置');
  const expectedIds = buildTown(DEFAULT_SEED).allAgents().map((agent) => agent.id).sort();
  const actualIds = Object.keys(value).sort();
  if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
    throw new Error('工作空间居民档案 ID 集合错配');
  }
  const world = profiledTown(value);
  return profileDefinitionsForWorld(world);
}

function validateWorldKinds(input: unknown): WorldKind[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 3) throw new Error('工作空间世界种类列表无效');
  const result: WorldKind[] = [];
  for (const item of input) {
    if (item !== 'mem-on' && item !== 'mem-off' && item !== 'rumor') throw new Error('工作空间包含未知世界种类');
    if (result.includes(item)) throw new Error('工作空间包含重复世界种类');
    result.push(item);
  }
  return result;
}

function worldIdForKind(kind: WorldKind): TownWorldId {
  return kind === 'mem-on' ? 'w1' : kind === 'mem-off' ? 'w2' : 'w3';
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label}必须是对象`);
  return input as Record<string, unknown>;
}

function boundedString(input: unknown, label: string, min: number, max: number): string {
  if (typeof input !== 'string' || input.length < min || input.length > max) throw new Error(`${label}无效`);
  return input;
}

function nullableBoundedString(input: unknown, label: string, max: number): string | null {
  if (input === null) return null;
  return boundedString(input, label, 0, max);
}

function safeInteger(input: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(input) || (input as number) < min || (input as number) > max) throw new Error(`${label}无效`);
  return input as number;
}

function finiteNumber(input: unknown, label: string, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) throw new Error(`${label}无效`);
  return input;
}

function hashString(input: unknown, label: string): string {
  const value = boundedString(input, label, 64, 64);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label}无效`);
  return value;
}

function isoTimestamp(input: unknown, label: string): string {
  const value = boundedString(input, label, 20, 40);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label}无效`);
  return value;
}
