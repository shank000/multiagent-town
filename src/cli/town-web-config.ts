import { lstatSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { MAX_WORLD_SPEED } from '../engine/runtime-limits';

export interface TownWebArgs {
  speed: number;
  port: number;
  dbPath: string;
  dbPathExplicit: boolean;
  worldKinds: Array<'mem-on' | 'mem-off' | 'rumor'>;
  workspaceName: string;
  seed: number;
}

export const TOWN_WORLD_IDS = ['w1', 'w2', 'w3'] as const;
export type TownWorldId = (typeof TOWN_WORLD_IDS)[number];
export type TownWorldDbPaths = Record<TownWorldId, string>;

export function parseArgs(argv: string[]): TownWebArgs {
  const args: TownWebArgs = {
    speed: 1,
    port: 8787,
    dbPath: resolve(
      process.cwd(),
      `data/runs/town-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.sqlite`
    ),
    dbPathExplicit: false,
    worldKinds: ['mem-on'],
    workspaceName: 'AI 小镇实验',
    seed: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--speed') args.speed = Number(argv[++i]);
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--db') {
      args.dbPath = argv[++i];
      args.dbPathExplicit = true;
    }
    else if (argv[i] === '--worlds') {
      args.worldKinds = String(argv[++i] ?? '').split(',').map((value) => value.trim())
        .filter((value): value is 'mem-on' | 'mem-off' | 'rumor' => Boolean(value)) as TownWebArgs['worldKinds'];
    }
    else if (argv[i] === '--workspace-name') args.workspaceName = String(argv[++i] ?? '').trim();
    else if (argv[i] === '--seed') args.seed = Number(argv[++i]);
  }
  if (!Number.isFinite(args.speed) || args.speed <= 0 || args.speed > MAX_WORLD_SPEED) {
    throw new Error(`--speed must be a finite number in (0, ${MAX_WORLD_SPEED}]`);
  }
  if (!Number.isSafeInteger(args.port) || args.port < 1 || args.port > 65_535) {
    throw new Error('--port must be an integer between 1 and 65535');
  }
  if (!args.dbPath) throw new Error('--db must be a non-empty path');
  const allowedKinds = new Set(['mem-on', 'mem-off', 'rumor']);
  if (args.worldKinds.length < 1 || args.worldKinds.length > 3 || new Set(args.worldKinds).size !== args.worldKinds.length
      || args.worldKinds.some((kind) => !allowedKinds.has(kind))) {
    throw new Error('--worlds must contain 1..3 unique values from mem-on,mem-off,rumor');
  }
  if (!args.workspaceName || args.workspaceName.length > 60) throw new Error('--workspace-name must contain 1..60 characters');
  if (!Number.isSafeInteger(args.seed) || args.seed < 1 || args.seed > 2_147_483_647) {
    throw new Error('--seed must be an integer between 1 and 2147483647');
  }
  return args;
}

export function worldDbPath(basePath: string, worldId: string): string {
  if (basePath === ':memory:') return basePath;
  const extension = extname(basePath);
  const stem = basename(basePath, extension);
  return join(dirname(basePath), `${stem}-${worldId}${extension}`);
}

/** 新实验只使用全新数据库；任何已有目标都会在构造世界前阻止启动。 */
export function assertFreshWorldDbPaths(args: TownWebArgs): TownWorldDbPaths {
  const paths = Object.fromEntries(
    TOWN_WORLD_IDS.map((worldId) => [worldId, worldDbPath(args.dbPath, worldId)])
  ) as TownWorldDbPaths;
  if (args.dbPath === ':memory:') return paths;

  const candidates = [
    ...(args.dbPathExplicit ? [args.dbPath] : []),
    ...TOWN_WORLD_IDS.map((worldId) => paths[worldId]),
  ];
  const occupied = [...new Set(candidates)].filter(pathEntryExists);
  if (occupied.length > 0) {
    throw new Error(
      `新实验要求全新数据库路径，以下路径已存在：${occupied.join('；')}。请指定新的 --db 路径或使用 :memory:。`
    );
  }
  return paths;
}

export function assertFreshSelectedWorldDbPaths(
  basePath: string,
  worldIds: readonly TownWorldId[],
  checkBasePath = false,
): Partial<TownWorldDbPaths> {
  const paths = Object.fromEntries(worldIds.map((worldId) => [worldId, worldDbPath(basePath, worldId)])) as Partial<TownWorldDbPaths>;
  if (basePath === ':memory:') return paths;
  const candidates = [...(checkBasePath ? [basePath] : []), ...Object.values(paths)] as string[];
  const occupied = [...new Set(candidates)].filter(pathEntryExists);
  if (occupied.length > 0) {
    throw new Error(`新工作空间要求全新数据库路径，以下路径已存在：${occupied.join('；')}`);
  }
  return paths;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法验证数据库路径 ${path} 是否可用：${message}`, { cause: error });
  }
}
