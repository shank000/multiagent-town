import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

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

test('town-web 启动后可访问快照接口', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(
    NODE,
    ['--no-warnings', '--import', 'tsx', 'src/cli/town-web.ts', '--port', String(port), '--db', ':memory:'],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let out = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
  try {
    const snap = (await waitForState(port, 15_000)) as { agents: unknown[] };
    assert.equal(snap.agents.length, 6);
    assert.ok(out.includes('浏览器打开'));
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
  }
});
