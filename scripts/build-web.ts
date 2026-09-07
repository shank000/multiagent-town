import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { assertWebBuildCurrent, fingerprintWebInputs, publishWebBuild, WEB_BUNDLES, type WebBundles } from '../src/runtime/web-build';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--check')) {
  console.log(`前端版本一致：${assertWebBuildCurrent(join(root, 'public'), root)}`);
} else {
  const inputs = fingerprintWebInputs(root);
  const bundles = {} as WebBundles;
  for (const name of Object.keys(WEB_BUNDLES) as Array<keyof WebBundles>) {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [WEB_BUNDLES[name]],
      bundle: true,
      format: 'iife',
      target: 'chrome100',
      outfile: join(root, 'public', name),
      write: false,
      logLevel: 'info',
    });
    if (result.outputFiles.length !== 1) throw new Error(`前端编译结果不完整：${name}`);
    bundles[name] = result.outputFiles[0].contents;
  }
  const version = publishWebBuild(root, bundles, inputs);
  assertWebBuildCurrent(join(root, 'public'), root);
  console.log(`前端构建已就绪：${version}（主界面、深度统计、后端日志）`);
}
