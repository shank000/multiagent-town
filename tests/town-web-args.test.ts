import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertFreshWorldDbPaths,
  parseArgs,
  TOWN_WORLD_IDS,
  worldDbPath,
} from '../src/cli/town-web-config';

test('town-web applies speed, port and one isolated database path per world', () => {
  const args = parseArgs(['--speed', '120', '--port', '9000', '--db', join('data', 'town.sqlite')]);
  assert.equal(args.speed, 120);
  assert.equal(args.port, 9000);
  assert.equal(args.dbPathExplicit, true);
  assert.equal(worldDbPath(args.dbPath, 'w2'), join('data', 'town-w2.sqlite'));
  assert.equal(worldDbPath(':memory:', 'w2'), ':memory:');
});

test('town-web keeps a unique default database prefix and allows in-memory experiments', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.dbPathExplicit, false);
  assert.match(defaults.dbPath, /data[\\/]runs[\\/]town-.+-\d+\.sqlite$/);

  const memory = parseArgs(['--db', ':memory:']);
  assert.deepEqual(assertFreshWorldDbPaths(memory), { w1: ':memory:', w2: ':memory:', w3: ':memory:' });
});

test('town-web rejects an explicitly supplied database file that already exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'town-web-db-'));
  try {
    const basePath = join(dir, 'experiment.sqlite');
    writeFileSync(basePath, 'occupied');
    assert.throws(
      () => assertFreshWorldDbPaths(parseArgs(['--db', basePath])),
      (error) => error instanceof Error && error.message.includes('全新数据库路径') && error.message.includes(basePath)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('town-web rejects every occupied derived world database before startup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'town-web-world-db-'));
  try {
    for (const worldId of TOWN_WORLD_IDS) {
      const basePath = join(dir, `experiment-${worldId}.sqlite`);
      const occupiedPath = worldDbPath(basePath, worldId);
      writeFileSync(occupiedPath, 'occupied');
      assert.throws(
        () => assertFreshWorldDbPaths(parseArgs(['--db', basePath])),
        (error) => error instanceof Error && error.message.includes('全新数据库路径') && error.message.includes(occupiedPath)
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('town-web rejects invalid runtime settings before starting worlds', () => {
  assert.throws(() => parseArgs(['--speed', '0']), /--speed/);
  assert.throws(() => parseArgs(['--speed', 'Infinity']), /--speed/);
  assert.throws(() => parseArgs(['--speed', '361']), /--speed/);
  assert.throws(() => parseArgs(['--port', '70000']), /--port/);
  assert.throws(() => parseArgs(['--db', '']), /--db/);
});
