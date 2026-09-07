import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDesktopAssets } from '../src/desktop/assets';

test('桌面资源缓存与内嵌内容一致，损坏缓存可恢复且实验数据保持独立', () => {
  const root = mkdtempSync(join(tmpdir(), 'town-desktop-assets-'));
  const manifest = { version: '0123456789abcdef', files: ['client.js', 'assets/town.txt'] };
  const content = (key: string) => Buffer.from(`embedded:${key}`);
  writeFileSync(join(root, 'experiment.sqlite'), 'existing experiment');
  const dir = extractDesktopAssets(root, manifest, content);
  writeFileSync(join(dir, 'client.js'), 'corrupt cache');
  assert.equal(extractDesktopAssets(root, manifest, content), dir);
  assert.equal(readFileSync(join(dir, 'client.js'), 'utf8'), 'embedded:public/client.js');
  assert.equal(readFileSync(join(root, 'experiment.sqlite'), 'utf8'), 'existing experiment');
  const next = extractDesktopAssets(root, { ...manifest, version: '1123456789abcdef' }, content);
  assert.notEqual(dir, next);
  assert.equal(readFileSync(join(dir, 'assets/town.txt'), 'utf8'), 'embedded:public/assets/town.txt');
});

test('桌面资源路径在写入前校验全部清单', () => {
  for (const path of ['../escape', '/absolute', 'C:/escape', 'a\\b', 'a/./b', 'a//b', '']) {
    assert.throws(() => extractDesktopAssets('unused', {
      version: '0123456789abcdef', files: ['client.js', path],
    }, () => { throw new Error('不应读取内容'); }), /界面资源路径无效/);
  }
  assert.throws(() => extractDesktopAssets('unused', { version: '../escape', files: [] }, () => Buffer.from('')), /清单无效/);
});
