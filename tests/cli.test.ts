import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
