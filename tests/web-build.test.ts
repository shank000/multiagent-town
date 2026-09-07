import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertWebBuildCurrent, fingerprintWebInputs, publishWebBuild, WEB_BUILD_MANIFEST } from '../src/runtime/web-build';
import { fixtureBundles, webBuildFixture } from './web-build-fixture';

test('前端内容指纹可复现，文件时间变化保持同一版本', (t) => {
  const root = webBuildFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = assertWebBuildCurrent(join(root, 'public'), root);
  utimesSync(join(root, 'src/web/client/main.ts'), new Date(0), new Date(0));
  assert.equal(assertWebBuildCurrent(join(root, 'public'), root), first);
  assert.equal(publishWebBuild(root, fixtureBundles(), fingerprintWebInputs(root)), first);
  assert.equal(assertWebBuildCurrent(join(root, 'public')), first);
  assert.equal(readdirSync(join(root, 'public')).some((name) => name.endsWith('.tmp')), false);
});

for (const path of ['src/web/client/main.ts', 'public/index.html', 'public/style.css', 'scripts/build-web.ts', 'pnpm-lock.yaml']) {
  test(`启动校验识别内容变化：${path}`, (t) => {
    const root = webBuildFixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, path), 'updated');
    assert.throws(() => assertWebBuildCurrent(join(root, 'public'), root), /pnpm build:web/);
  });
}

for (const name of ['client.js', 'stats.js', 'logs.js', WEB_BUILD_MANIFEST]) {
  test(`启动校验识别缺失及损坏资源：${name}`, (t) => {
    const root = webBuildFixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    unlinkSync(join(root, 'public', name));
    assert.throws(() => assertWebBuildCurrent(join(root, 'public'), root), /前端版本检查未通过/);
    writeFileSync(join(root, 'public', name), 'invalid');
    assert.throws(() => assertWebBuildCurrent(join(root, 'public')), /完整的 Windows 发布包/);
  });
}

test('构建期间源码变化时保留上一套脚本与清单', (t) => {
  const root = webBuildFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputs = fingerprintWebInputs(root);
  const script = readFileSync(join(root, 'public/client.js'), 'utf8');
  const manifest = readFileSync(join(root, 'public', WEB_BUILD_MANIFEST), 'utf8');
  writeFileSync(join(root, 'src/web/client/main.ts'), 'updated');
  const bundles = fixtureBundles();
  bundles['client.js'] = Buffer.from('new bundle');
  assert.throws(() => publishWebBuild(root, bundles, inputs), /构建期间源文件发生变化/);
  assert.equal(readFileSync(join(root, 'public/client.js'), 'utf8'), script);
  assert.equal(readFileSync(join(root, 'public', WEB_BUILD_MANIFEST), 'utf8'), manifest);
});

test('三份脚本齐备且有效后才发布', (t) => {
  const root = webBuildFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = readFileSync(join(root, 'public', WEB_BUILD_MANIFEST), 'utf8');
  const bundles = fixtureBundles();
  bundles['logs.js'] = new Uint8Array();
  assert.throws(() => publishWebBuild(root, bundles, fingerprintWebInputs(root)), /logs.js/);
  assert.equal(readFileSync(join(root, 'public', WEB_BUILD_MANIFEST), 'utf8'), before);
  assert.equal(readFileSync(join(root, 'public/client.js'), 'utf8'), 'void 1;');
});

test('新增或删除源码文件也需要重新构建', (t) => {
  const root = webBuildFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const extra = join(root, 'src/web/client/extra.ts');
  writeFileSync(extra, 'extra');
  assert.throws(() => assertWebBuildCurrent(join(root, 'public'), root), /当前源码/);
  publishWebBuild(root, fixtureBundles(), fingerprintWebInputs(root));
  unlinkSync(extra);
  assert.throws(() => assertWebBuildCurrent(join(root, 'public'), root), /当前源码/);
});
