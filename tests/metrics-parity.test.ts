import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { metricsOf, type Choice } from '../src/engine/metrics';

interface MetricsFixture {
  schemaVersion: 'metrics-parity.fixture/v1';
  agentIds: string[];
  days: Array<{ day: number; choices: Array<[string, string]> }>;
  expected: {
    repeat: number[];
    recipRate: number[];
    recipBaseline: number[];
    recip: number[];
    clus: number[];
    div: number[];
    hhi: number[];
    persistence: number[];
    hub: number[];
    pairs: Record<string, number>;
  };
}

const fixturePath = fileURLToPath(new URL('./fixtures/metrics-parity-v1.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as MetricsFixture;
const sequenceKeys = ['repeat', 'recipRate', 'recipBaseline', 'recip', 'clus', 'div', 'hhi', 'persistence', 'hub'] as const;

function assertSequenceClose(actual: number[], expected: number[], label: string): void {
  assert.equal(actual.length, expected.length, `${label} sequence length`);
  for (let index = 0; index < expected.length; index++) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= 1e-12,
      `${label}[${index}]: expected ${expected[index]}, got ${actual[index]}`
    );
  }
}

test('TypeScript metrics match the shared TS-Python golden sequence', () => {
  assert.equal(fixture.schemaVersion, 'metrics-parity.fixture/v1');
  const choices: Choice[] = fixture.days.flatMap(({ day, choices: dailyChoices }) => (
    dailyChoices.map(([from, to]) => ({ day, from, to }))
  ));
  const actual = metricsOf(choices, fixture.agentIds);

  for (const key of sequenceKeys) assertSequenceClose(actual[key], fixture.expected[key], key);
  assert.deepEqual(actual.seriesDays.persistence, [14, 15, 16]);
  assert.equal(actual.availability.persistence.state, 'ready');
  assert.deepEqual(Object.fromEntries(actual.pairs), fixture.expected.pairs);
});
