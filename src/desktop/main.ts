import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isSea, getAsset } from 'node:sea';
import { createServer as createNetServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { LLMGateway } from '../llm/gateway';
import { gatewayConfigFromEnv } from '../llm/provider-config';
import { resolveOllamaProfile } from '../llm/model-profiles';
import { createManagedWorld, startAllWorlds, stopAllWorlds } from '../engine/world-factory';
import { createTownServer, type TownWebServer } from '../web/server';
import { assertFreshWorldDbPaths, type TownWebArgs } from '../cli/town-web-config';

const APP_NAME = 'MultiagentTown';
const DEFAULT_PORT = 8898;
const DEFAULT_SPEED = 1;
const OLLAMA_URL = 'http://127.0.0.1:11434';

interface DesktopArgs {
  noBrowser: boolean;
  port: number;
  smoke: boolean;
  speed: number;
}

interface EmbeddedManifest {
  files: string[];
  version: string;
}

interface OllamaTag {
  model?: string;
  name?: string;
}

interface OllamaTagsResponse {
  models?: OllamaTag[];
}

function parseDesktopArgs(argv: string[]): DesktopArgs {
  const args: DesktopArgs = {
    noBrowser: false,
    port: DEFAULT_PORT,
    smoke: false,
    speed: DEFAULT_SPEED,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--no-browser') args.noBrowser = true;
    else if (argument === '--smoke') args.smoke = true;
    else if (argument === '--port') args.port = Number(argv[++index]);
    else if (argument === '--speed') args.speed = Number(argv[++index]);
    else throw new Error(`未知启动参数：${argument}`);
  }
  if (!Number.isSafeInteger(args.port) || args.port < 1 || args.port > 65_535) {
    throw new Error('--port 必须是 1..65535 的整数');
  }
  if (!Number.isFinite(args.speed) || args.speed <= 0 || args.speed > 360) {
    throw new Error('--speed 必须是 (0, 360] 的有限数字');
  }
  return args;
}

function localDataRoot(): string {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  return join(localAppData || join(homedir(), 'AppData', 'Local'), APP_NAME);
}

function runtimePublicDir(appRoot: string): string {
  if (!isSea()) return resolve(process.cwd(), 'public');
  const manifest = JSON.parse(getAsset('public-manifest.json', 'utf8')) as EmbeddedManifest;
  if (!manifest.version || !Array.isArray(manifest.files)) {
    throw new Error('可执行文件中的界面资源清单无效');
  }
  const publicDir = join(appRoot, 'runtime', manifest.version, 'public');
  for (const relativePath of manifest.files) {
    if (!relativePath || relativePath.includes('..') || relativePath.startsWith('/') || relativePath.startsWith('\\')) {
      throw new Error(`界面资源路径无效：${relativePath}`);
    }
    const outputPath = join(publicDir, ...relativePath.split('/'));
    if (existsSync(outputPath)) continue;
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, Buffer.from(getAsset(`public/${relativePath}`)));
  }
  return publicDir;
}

function uniqueDatabasePath(appRoot: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = createHash('sha256')
    .update(`${process.pid}:${process.hrtime.bigint().toString()}`)
    .digest('hex')
    .slice(0, 8);
  const runsDir = join(appRoot, 'runs');
  mkdirSync(runsDir, { recursive: true });
  return join(runsDir, `town-${stamp}-${suffix}.sqlite`);
}

async function portIsAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePort) => {
    const probe = createNetServer();
    probe.unref();
    probe.once('error', () => resolvePort(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolvePort(true));
    });
  });
}

async function availablePort(preferred: number): Promise<number> {
  for (let port = preferred; port <= Math.min(65_535, preferred + 20); port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error(`端口 ${preferred}..${Math.min(65_535, preferred + 20)} 均被占用`);
}

async function ollamaTags(): Promise<OllamaTagsResponse | null> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    return await response.json() as OllamaTagsResponse;
  } catch {
    return null;
  }
}

function findOllamaExecutable(): string | null {
  const candidates = [
    process.env.OLLAMA_EXE,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : undefined,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Ollama', 'ollama.exe') : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const where = spawnSync('where.exe', ['ollama.exe'], { encoding: 'utf8', windowsHide: true });
  if (where.status !== 0) return null;
  return where.stdout.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean) ?? null;
}

function openExternal(url: string): void {
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function waitForOllama(): Promise<OllamaTagsResponse | null> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const tags = await ollamaTags();
    if (tags) return tags;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 500));
  }
  return null;
}

async function pullModel(model: string): Promise<void> {
  console.log(`\n首次运行准备本地模型：${model}`);
  const response = await fetch(`${OLLAMA_URL}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`模型 ${model} 下载请求失败（HTTP ${response.status}）`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastPercent = -1;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const update = JSON.parse(line) as { completed?: number; error?: string; status?: string; total?: number };
      if (update.error) throw new Error(update.error);
      if (update.total && update.completed !== undefined) {
        const percent = Math.floor((update.completed / update.total) * 100);
        if (percent >= lastPercent + 5 || percent === 100) {
          console.log(`  ${model}：${percent}%`);
          lastPercent = percent;
        }
      } else if (update.status === 'success') {
        console.log(`  ${model}：准备完成`);
      }
    }
    if (done) break;
  }
}

async function ensureLocalOllama(): Promise<string[]> {
  let tags = await ollamaTags();
  if (!tags) {
    const executable = findOllamaExecutable();
    if (!executable) {
      openExternal('https://ollama.com/download/windows');
      throw new Error('未检测到本机 Ollama。已打开官方下载页，安装后重新运行本程序即可。');
    }
    console.log('正在启动本机 Ollama 推理服务……');
    const server = spawn(executable, ['serve'], {
      detached: true,
      env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_NO_CLOUD: '1' },
      stdio: 'ignore',
      windowsHide: true,
    });
    server.unref();
    tags = await waitForOllama();
    if (!tags) throw new Error('Ollama 已启动，但本地推理接口在 20 秒内没有就绪');
  }

  const profile = resolveOllamaProfile(process.env.OLLAMA_PROFILE);
  const required = [...new Set([profile.model, profile.smallModel])];
  const installed = new Set(
    (tags.models ?? []).flatMap((entry) => [entry.name, entry.model]).filter((name): name is string => Boolean(name)),
  );
  for (const model of required) {
    if (!installed.has(model)) await pullModel(model);
  }
  return required;
}

async function verifyRealModel(gateway: LLMGateway): Promise<void> {
  const response = await gateway.complete({
    tier: 'small',
    template: 'desktop_executable_smoke',
    messages: [
      { role: 'system', content: '你是本地运行检查器。只输出符合 schema 的 JSON。' },
      { role: 'user', content: '确认本地模型可以完成一次结构化推理。' },
    ],
    jsonMode: true,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ready'],
      properties: { ready: { type: 'boolean', const: true } },
    },
    maxTokens: 32,
    temperature: 0,
    reasoning: false,
    priority: 'action',
    scopeId: 'desktop-smoke',
    timeoutMs: 120_000,
  });
  const parsed = response.parsed as { ready?: unknown } | null;
  if (parsed?.ready !== true) throw new Error('本地模型没有返回有效的结构化检查结果');
}

async function main(): Promise<void> {
  console.log('MultiAgent Town · 多智能体社会涌现实验平台');
  console.log('数据与实验记录保存在当前 Windows 用户的本地应用数据目录。\n');
  const args = parseDesktopArgs(process.argv.slice(2));
  process.env.LLM_PROVIDER = 'ollama';
  process.env.OLLAMA_PROFILE ||= 'qwen3-balanced';
  process.env.OLLAMA_BASE_URL = OLLAMA_URL;
  process.env.OLLAMA_NO_CLOUD = '1';
  process.env.LLM_MAX_CONCURRENCY ||= '1';
  process.env.LLM_MAX_QUEUE ||= '96';

  const models = await ensureLocalOllama();
  const appRoot = localDataRoot();
  mkdirSync(appRoot, { recursive: true });
  const publicDir = runtimePublicDir(appRoot);
  const dbPath = uniqueDatabasePath(appRoot);
  const port = await availablePort(args.port);
  const webArgs: TownWebArgs = {
    speed: args.speed,
    port,
    dbPath,
    dbPathExplicit: false,
  };
  const dbPaths = assertFreshWorldDbPaths(webArgs);
  const gateway = new LLMGateway({ ...gatewayConfigFromEnv(), expectedActiveAgents: 18 });
  if (args.smoke) await verifyRealModel(gateway);
  const worlds = [
    createManagedWorld('w1', 'mem-on', { seed: 1, gameMinutesPerTick: args.speed * 0.5, gateway, dbPath: dbPaths.w1 }),
    createManagedWorld('w2', 'mem-off', { seed: 1, gameMinutesPerTick: args.speed * 0.5, gateway, dbPath: dbPaths.w2 }),
    createManagedWorld('w3', 'rumor', { seed: 1, gameMinutesPerTick: args.speed * 0.5, gateway, dbPath: dbPaths.w3 }),
  ];
  const primary = worlds[0];
  let webServer: TownWebServer | null = null;
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    stopAllWorlds(worlds);
    if (webServer) await webServer.close();
    await Promise.all(worlds.map((world) => world.loop.drain()));
    await Promise.all(worlds.map((world) => world.mind.dispose()));
    await gateway.drain();
    for (const world of worlds) world.db.raw.close();
  };
  process.once('SIGINT', () => void close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void close().finally(() => process.exit(0)));

  try {
    webServer = await createTownServer({
      world: primary.world,
      time: primary.time,
      loop: primary.loop,
      log: primary.log,
      mind: primary.mind,
      player: primary.player,
      rels: primary.mind.rels,
      rumors: primary.mind.rumors,
      experiment: primary.experiment ?? undefined,
      worlds,
      port,
      llm: gateway,
      publicDir,
    });
    startAllWorlds(worlds);
    const url = `http://127.0.0.1:${webServer.port}/`;
    console.log(`本地模型：${models.join(' + ')}`);
    console.log(`实验数据库：${dirname(dbPath)}`);
    console.log(`研究控制台：${url}`);
    console.log('保持此窗口运行；关闭窗口即可结束本次实验。\n');
    if (!args.noBrowser) openExternal(url);
    if (args.smoke) {
      const state = await fetch(`${url}api/state`, { signal: AbortSignal.timeout(10_000) });
      if (!state.ok) throw new Error(`可执行文件 HTTP 冒烟失败（${state.status}）`);
      const snapshot = await state.json() as { agents?: unknown[]; worldId?: string };
      if (!Array.isArray(snapshot.agents) || snapshot.agents.length !== 6 || snapshot.worldId !== 'w1') {
        throw new Error('可执行文件世界快照不符合三世界基线');
      }
      console.log('SMOKE_OK real_model=true worlds=3 agents_per_world=6');
      await close();
    }
  } catch (error) {
    await close();
    throw error;
  }
}

void main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n启动失败：${message}`);
  console.error('问题处理完成后，重新双击 MultiagentTown.exe 即可。');
  if (!process.argv.includes('--smoke') && process.stdin.isTTY) {
    console.error('\n按 Enter 键关闭此窗口。');
    process.stdin.resume();
    await new Promise<void>((resolveInput) => process.stdin.once('data', () => resolveInput()));
    process.stdin.pause();
  }
  process.exitCode = 1;
});
