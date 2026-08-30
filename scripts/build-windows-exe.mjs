import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { inject } = require('postject');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const workDir = join(distDir, '.windows-build');
const outputDir = join(distDir, 'MultiagentTown-Windows-x64');
const executablePath = join(outputDir, 'MultiagentTown.exe');
const archivePath = join(distDir, 'MultiagentTown-Windows-x64.zip');
const publicDir = join(root, 'public');

if (process.platform !== 'win32') {
  throw new Error('Windows 单文件构建必须在 Windows x64 主机上执行');
}
if (process.arch !== 'x64') {
  throw new Error(`当前主机架构为 ${process.arch}，此任务仅生成 Windows x64 可执行文件`);
}

rmSync(workDir, { recursive: true, force: true });
rmSync(outputDir, { recursive: true, force: true });
rmSync(archivePath, { force: true });
rmSync(`${archivePath}.sha256`, { force: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'web', 'client', 'main.ts')],
  bundle: true,
  format: 'iife',
  target: 'chrome100',
  outfile: join(publicDir, 'client.js'),
  logLevel: 'info',
});
await build({
  entryPoints: [join(root, 'src', 'web', 'client', 'stats.ts')],
  bundle: true,
  format: 'iife',
  target: 'chrome100',
  outfile: join(publicDir, 'stats.js'),
  logLevel: 'info',
});
await build({
  entryPoints: [join(root, 'src', 'web', 'client', 'logs.ts')],
  bundle: true,
  format: 'iife',
  target: 'chrome100',
  outfile: join(publicDir, 'logs.js'),
  logLevel: 'info',
});

const bundlePath = join(workDir, 'desktop.cjs');
await build({
  entryPoints: [join(root, 'src', 'desktop', 'main.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: bundlePath,
  logLevel: 'info',
});

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolutePath = join(directory, entry);
    if (statSync(absolutePath).isDirectory()) files.push(...listFiles(absolutePath));
    else files.push(absolutePath);
  }
  return files;
}

const publicFiles = listFiles(publicDir).sort();
const relativeFiles = publicFiles.map((file) => relative(publicDir, file).replaceAll('\\', '/'));
const versionHash = createHash('sha256');
for (const file of publicFiles) {
  versionHash.update(relative(publicDir, file).replaceAll('\\', '/'));
  versionHash.update(readFileSync(file));
}
const manifestPath = join(workDir, 'public-manifest.json');
writeFileSync(manifestPath, JSON.stringify({ files: relativeFiles, version: versionHash.digest('hex').slice(0, 16) }));

const assets = { 'public-manifest.json': manifestPath };
for (const [index, file] of publicFiles.entries()) assets[`public/${relativeFiles[index]}`] = file;
const seaBlobPath = join(workDir, 'sea-prep.blob');
const seaConfigPath = join(workDir, 'sea-config.json');
writeFileSync(seaConfigPath, JSON.stringify({
  main: bundlePath,
  output: seaBlobPath,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  execArgv: ['--no-warnings'],
  execArgvExtension: 'none',
  assets,
}, null, 2));

const sea = spawnSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
});
if (sea.status !== 0) throw new Error(`Node SEA 资源生成失败：\n${sea.stdout}\n${sea.stderr}`);

copyFileSync(process.execPath, executablePath);
await inject(
  executablePath,
  'NODE_SEA_BLOB',
  readFileSync(seaBlobPath),
  { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' },
);

const guideSource = join(root, 'packaging', 'windows', '使用说明.txt');
copyFileSync(guideSource, join(outputDir, 'README.txt'));
rmSync(workDir, { recursive: true, force: true });
const sizeMiB = statSync(executablePath).size / 1024 / 1024;
const executableHash = createHash('sha256').update(readFileSync(executablePath)).digest('hex');
writeFileSync(join(outputDir, 'MultiagentTown.exe.sha256'), `${executableHash}  MultiagentTown.exe\n`);
const archive = spawnSync('tar.exe', [
  '-a',
  '-cf',
  archivePath,
  '-C',
  distDir,
  basename(outputDir),
], { encoding: 'utf8', windowsHide: true });
if (archive.status !== 0) throw new Error(`发布压缩包生成失败：\n${archive.stdout}\n${archive.stderr}`);
const archiveHash = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
writeFileSync(`${archivePath}.sha256`, `${archiveHash}  ${basename(archivePath)}\n`);
console.log(`\nWindows 可执行文件：${executablePath}`);
console.log(`文件大小：${sizeMiB.toFixed(1)} MiB`);
console.log(`SHA-256：${executableHash}`);
console.log(`协作发布包：${archivePath}`);
