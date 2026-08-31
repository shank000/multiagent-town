import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';

const run = promisify(execFile);
const NODE = process.execPath;

test('run --until-minutes 正常结束且日志可回放', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'town-cli-'));
  const db = join(dir, 't.sqlite');
  try {
    const { stdout } = await run(
      NODE,
      ['--no-warnings', '--import', 'tsx', 'src/cli/run.ts', '--until-minutes', '60', '--speed', '120', '--db', db],
      { cwd: process.cwd(), timeout: 30_000 }
    );
    assert.match(stdout, /\[multiagent-town M0\]/);
    assert.match(stdout, /运行结束/);
    const persisted = openDb(db);
    try {
      const row = persisted.raw.prepare("SELECT COUNT(*) AS count FROM conversations WHERE status = 'active'")
        .get() as { count: number };
      assert.equal(row.count, 0, '有限运行完成后数据库不能遗留 active 会话');
    } finally {
      persisted.raw.close();
    }
    const { stdout: rp } = await run(
      NODE,
      ['--no-warnings', '--import', 'tsx', 'src/cli/replay.ts', '--day', '1', '--db', db],
      { cwd: process.cwd(), timeout: 30_000 }
    );
    assert.match(rp, /事件回放/);
    assert.match(rp, /第1天开始/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
