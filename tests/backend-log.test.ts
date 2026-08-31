import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BackendRuntimeLog, redactSecrets, runtimeLogPathForDatabase } from '../src/runtime/backend-log';

test('后端运行日志以有界内存和完整 JSONL 文件记录并统一脱敏', () => {
  const directory = mkdtempSync(join(tmpdir(), 'backend-log-'));
  const path = join(directory, 'runtime.jsonl');
  const log = new BackendRuntimeLog(path, { captureConsole: false });
  try {
    log.info('startup', '服务已启动');
    log.warn('llm', 'apiKey=secret-value-123 password: "another-secret"');
    log.error('dialogue', 'Bearer private-token-123456');
    const warning = log.query({ level: 'warn', search: 'apiKey', limit: 20 });
    assert.equal(warning.entries.length, 1);
    assert.match(warning.entries[0].message, /\[REDACTED\]/);
    assert.doesNotMatch(warning.entries[0].message, /secret-value|another-secret/);
    assert.equal(warning.filePath, path);
    assert.equal(warning.totalEntries, 4);
    const persisted = readFileSync(path, 'utf8');
    assert.match(persisted, /"source":"dialogue"/);
    assert.doesNotMatch(persisted, /secret-value|another-secret|private-token/);
  } finally {
    log.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('运行日志路径与研究数据库同批次保存且脱敏器覆盖常见凭据格式', () => {
  const databasePath = join('var', 'runs', 'town-1.sqlite');
  assert.equal(
    runtimeLogPathForDatabase(databasePath),
    join('var', 'runs', 'town-1.runtime.jsonl'),
  );
  assert.equal(redactSecrets('Authorization=abc sk-1234567890 API_KEY: xyz'), 'Authorization=[REDACTED] sk-[REDACTED] API_KEY: [REDACTED]');
  assert.notEqual(runtimeLogPathForDatabase(':memory:'), runtimeLogPathForDatabase(':memory:'));
});

test('新工作空间切换到独立日志文件并重置当前会话视图', () => {
  const directory = mkdtempSync(join(tmpdir(), 'backend-log-switch-'));
  const first = join(directory, 'first.runtime.jsonl');
  const second = join(directory, 'second.runtime.jsonl');
  const log = new BackendRuntimeLog(first, { captureConsole: false });
  try {
    log.info('world', '旧工作空间条目');
    const previousSession = log.sessionId;
    log.switchFile(second, 'ws-next');
    log.info('world', '新工作空间条目');
    assert.equal(log.filePath, second);
    assert.notEqual(log.sessionId, previousSession);
    assert.doesNotMatch(readFileSync(second, 'utf8'), /旧工作空间条目/);
    assert.match(readFileSync(second, 'utf8'), /新工作空间条目/);
    assert.match(readFileSync(first, 'utf8'), /工作空间日志封存/);
  } finally {
    log.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
