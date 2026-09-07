import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
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
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (!/^[0-9A-Za-z.-]+$/.test(packageVersion)) throw new Error('发布版本号格式无效');
const releaseDir = join(distDir, 'releases', packageVersion);
const publicDir = join(root, 'public');

if (process.platform !== 'win32') {
  throw new Error('Windows 单文件构建必须在 Windows x64 主机上执行');
}
if (process.arch !== 'x64') {
  throw new Error(`当前主机架构为 ${process.arch}，此任务仅生成 Windows x64 可执行文件`);
}
if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Windows 发布构建使用 Node.js 22');
if (existsSync(releaseDir)) throw new Error(`此版本已有发布包，请使用新的版本号：${releaseDir}`);
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
const revision = git('rev-parse', 'HEAD');
const status = git('status', '--porcelain');
if (revision.status !== 0 || status.status !== 0) throw new Error('构建需要可验证的 Git 源码版本');
const dirty = Boolean(status.stdout.trim());
if (process.argv.includes('--release') && dirty) throw new Error('发布构建要求先提交全部源码与说明文件');
const buildInfo = { version: packageVersion, channel: 'collaboration-preview', sourceCommit: revision.stdout.trim(), dirty, builtAt: new Date().toISOString(), node: process.versions.node, platform: 'win32-x64' };

mkdirSync(distDir, { recursive: true });
const workDir = mkdtempSync(join(distDir, '.windows-build-'));
const stagedRelease = join(workDir, 'release');
const outputDir = join(stagedRelease, 'MultiagentTown-Windows-x64');
const executablePath = join(outputDir, 'MultiagentTown.exe');
const archivePath = join(stagedRelease, 'MultiagentTown-Windows-x64.zip');
mkdirSync(outputDir, { recursive: true });

const webBuild = spawnSync(process.execPath, ['--no-warnings', '--import', 'tsx', 'scripts/build-web.ts'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
});
if (webBuild.status !== 0) throw new Error(`前端构建失败：\n${webBuild.stdout}\n${webBuild.stderr}`);
console.log(webBuild.stdout);

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
const buildInfoPath = join(outputDir, 'build-info.json');
writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2) + '\n');

const assets = { 'public-manifest.json': manifestPath, 'build-info.json': buildInfoPath };
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
copyFileSync(join(root, 'ATTRIBUTION.md'), join(outputDir, 'ATTRIBUTION.md'));
copyFileSync(join(dirname(process.execPath), 'LICENSE'), join(outputDir, 'NODE-LICENSE.txt'));
copyFileSync(join(root, 'docs', 'dialogue-continuity-validation.md'), join(outputDir, 'dialogue-validation.md'));
const sizeMiB = statSync(executablePath).size / 1024 / 1024;
const executableHash = createHash('sha256').update(readFileSync(executablePath)).digest('hex');
writeFileSync(join(outputDir, 'MultiagentTown.exe.sha256'), `${executableHash}  MultiagentTown.exe\n`);
const archive = spawnSync('tar.exe', [
  '-a',
  '-cf',
  archivePath,
  '-C',
  stagedRelease,
  basename(outputDir),
], { encoding: 'utf8', windowsHide: true });
if (archive.status !== 0) throw new Error(`发布压缩包生成失败：\n${archive.stdout}\n${archive.stderr}`);
const archiveHash = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
writeFileSync(`${archivePath}.sha256`, `${archiveHash}  ${basename(archivePath)}\n`);
mkdirSync(dirname(releaseDir), { recursive: true });
renameSync(stagedRelease, releaseDir);
console.log(`\n版本：${packageVersion}（协作测试版）源码：${buildInfo.sourceCommit}${dirty ? ' + 未提交修改' : ''}`);
console.log(`Windows 可执行文件：${join(releaseDir, basename(outputDir), 'MultiagentTown.exe')}`);
console.log(`文件大小：${sizeMiB.toFixed(1)} MiB`);
console.log(`SHA-256：${executableHash}`);
console.log(`协作发布包：${join(releaseDir, basename(archivePath))}`);
