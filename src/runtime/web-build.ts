import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const WEB_BUILD_MANIFEST = 'web-build.json';
export const WEB_BUNDLES = {
  'client.js': 'src/web/client/main.ts',
  'stats.js': 'src/web/client/stats.ts',
  'logs.js': 'src/web/client/logs.ts',
} as const;
export const WEB_PAGES = ['index.html', 'stats.html', 'logs.html', 'style.css'] as const;
export const WEB_BUILD_CONFIG = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'scripts/build-web.ts'] as const;
export type WebBundles = Record<keyof typeof WEB_BUNDLES, Uint8Array>;
type Fingerprints = Record<string, string>;

interface WebBuildManifest {
  schemaVersion: 1;
  buildId: string;
  inputs: Fingerprints;
  outputs: Fingerprints;
}

function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function sourceFiles(root: string, directory = 'src'): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(root, path);
    return entry.isFile() && /\.(?:ts|json)$/.test(entry.name) ? [path] : [];
  });
}

/** 内容指纹独立于检出时间，同时覆盖浏览器依赖与构建配置。 */
export function fingerprintWebInputs(root: string): Fingerprints {
  const paths = [...WEB_BUILD_CONFIG, ...sourceFiles(root), ...WEB_PAGES.map((name) => `public/${name}`)].sort();
  return Object.fromEntries(paths.map((path) => [path, digest(readFileSync(join(root, path)))]));
}

function buildId(inputs: Fingerprints, outputs: Fingerprints): string {
  return digest(JSON.stringify({ inputs, outputs })).slice(0, 16);
}

function atomicWrite(path: string, content: string | Uint8Array): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { flag: 'wx' });
    renameSync(temporaryPath, path);
  } finally {
    try { unlinkSync(temporaryPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** 完整编译后逐文件原子发布，最后发布配套资源清单。 */
export function publishWebBuild(root: string, bundles: WebBundles, inputs: Fingerprints): string {
  if (JSON.stringify(fingerprintWebInputs(root)) !== JSON.stringify(inputs)) {
    throw new Error('构建期间源文件发生变化，请重新运行 pnpm build:web。');
  }
  for (const name of Object.keys(WEB_BUNDLES) as Array<keyof WebBundles>) {
    if (!(bundles[name] instanceof Uint8Array) || bundles[name].length === 0) {
      throw new Error(`前端编译结果不完整：${name}`);
    }
  }
  const outputs: Fingerprints = {};
  for (const name of [...Object.keys(WEB_BUNDLES), ...WEB_PAGES].sort()) {
    outputs[name] = digest(name in WEB_BUNDLES ? bundles[name as keyof WebBundles] : readFileSync(join(root, 'public', name)));
  }
  const manifest: WebBuildManifest = { schemaVersion: 1, buildId: buildId(inputs, outputs), inputs, outputs };
  for (const name of Object.keys(WEB_BUNDLES) as Array<keyof WebBundles>) {
    atomicWrite(join(root, 'public', name), bundles[name]);
  }
  atomicWrite(join(root, 'public', WEB_BUILD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.buildId;
}

function isFingerprints(value: unknown): value is Fingerprints {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item));
}

/** 源码启动与打包启动共享资源完整性校验；源码启动额外校验当前源码。 */
export function assertWebBuildCurrent(publicDir: string, sourceRoot?: string): string {
  try {
    const value = JSON.parse(readFileSync(join(publicDir, WEB_BUILD_MANIFEST), 'utf8')) as Partial<WebBuildManifest> | null;
    if (!value || value.schemaVersion !== 1 || !isFingerprints(value.inputs) || !isFingerprints(value.outputs)
      || value.buildId !== buildId(value.inputs, value.outputs)) {
      throw new Error('前端资源清单格式或指纹无效');
    }
    const expectedOutputs = [...Object.keys(WEB_BUNDLES), ...WEB_PAGES].sort();
    if (JSON.stringify(Object.keys(value.outputs).sort()) !== JSON.stringify(expectedOutputs)) {
      throw new Error('前端资源清单不完整');
    }
    for (const name of expectedOutputs) {
      if (digest(readFileSync(join(publicDir, name))) !== value.outputs[name]) {
        throw new Error(`前端资源与清单不一致：${name}`);
      }
    }
    if (sourceRoot && JSON.stringify(fingerprintWebInputs(sourceRoot)) !== JSON.stringify(value.inputs)) {
      throw new Error('前端构建与当前源码或页面不一致');
    }
    return value.buildId!;
  } catch (error) {
    const remedy = sourceRoot ? '请先运行 pnpm build:web，再按原参数启动。' : '请使用完整的 Windows 发布包重新启动。';
    throw new Error(`前端版本检查未通过：${error instanceof Error ? error.message : String(error)}。${remedy}`, { cause: error });
  }
}
