import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { webBuildFixture } from './web-build-fixture';

const NODE = process.execPath;

async function waitForState(port: number, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (res.ok) return await res.json();
    } catch {
      /* 未就绪，继续等 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('town-web 启动超时');
}

test('town-web 启动后可访问快照接口', async (t) => {
  const root = webBuildFixture();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(
    NODE,
    ['--no-warnings', '--import', import.meta.resolve('tsx'), resolve('src/cli/town-web.ts'), '--port', String(port), '--db', ':memory:'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let out = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
  try {
    const snap = (await waitForState(port, 15_000)) as { agents: unknown[] };
    assert.equal(snap.agents.length, 6);
    const registry = await (await fetch(`http://127.0.0.1:${port}/api/worlds`)).json() as { worlds: unknown[] };
    assert.equal(registry.worlds.length, 1);
    assert.ok(out.includes('浏览器打开'));
  } finally {
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))]);
  }
});

for (const entry of ['src/cli/town-web.ts', 'src/desktop/main.ts']) {
  test(`${entry} 在创建实验与日志之前拒绝陈旧前端`, async (t) => {
    const root = webBuildFixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'src/web/client/main.ts'), 'updated');
    const child = spawn(NODE, [
      '--no-warnings', '--import', import.meta.resolve('tsx'), resolve(entry),
      ...(entry.includes('/cli/') ? ['--db', join(root, 'data/town.sqlite')] : ['--no-browser', '--smoke']),
    ], { cwd: root, env: { ...process.env, LOCALAPPDATA: join(root, 'appdata') }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    let out = '';
    child.stdout.on('data', (data: Buffer) => { out += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { out += data.toString(); });
    const [code] = await once(child, 'exit', { signal: AbortSignal.timeout(15_000) });
    assert.equal(code, 1);
    assert.match(out, /pnpm build:web/);
    assert.equal(existsSync(join(root, 'data')), false);
    assert.equal(existsSync(join(root, 'appdata')), false);
  });
}
