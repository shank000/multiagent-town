import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface EmbeddedManifest {
  files: string[];
  version: string;
}

/** 内容版本隔离的缓存与可执行文件内嵌资源保持一致。 */
export function extractDesktopAssets(appRoot: string, manifest: EmbeddedManifest, asset: (key: string) => Buffer): string {
  if (!/^[a-f0-9]{16}$/.test(manifest.version) || !Array.isArray(manifest.files)) {
    throw new Error('可执行文件中的界面资源清单无效');
  }
  for (const path of manifest.files) {
    if (typeof path !== 'string' || !path || path.includes(':') || path.includes('\\')
      || path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`界面资源路径无效：${path}`);
    }
  }
  const publicDir = join(appRoot, 'runtime', manifest.version, 'public');
  for (const path of manifest.files) {
    const output = join(publicDir, ...path.split('/'));
    const content = asset(`public/${path}`);
    if (existsSync(output) && readFileSync(output).equals(content)) continue;
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, content);
  }
  return publicDir;
}
