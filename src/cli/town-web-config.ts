import { lstatSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

export interface TownWebArgs {
  speed: number;
  port: number;
  dbPath: string;
  dbPathExplicit: boolean;
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
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--speed') args.speed = Number(argv[++i]);
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--db') {
      args.dbPath = argv[++i];
      args.dbPathExplicit = true;
    }
  }
  if (!Number.isFinite(args.speed) || args.speed <= 0 || args.speed > 360) {
    throw new Error('--speed must be a finite number in (0, 360]');
  }
  if (!Number.isSafeInteger(args.port) || args.port < 1 || args.port > 65_535) {
    throw new Error('--port must be an integer between 1 and 65535');
  }
  if (!args.dbPath) throw new Error('--db must be a non-empty path');
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
