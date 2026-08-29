import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROTOCOL_SCHEMA_VERSION,
  assertPartnerChoiceRound,
  assertStudyManifest,
  candidateOrderFor,
  canonicalJson,
  hashPartnerChoiceObservation,
  hashPartnerChoiceProtocol,
  toLegacyChoicePayload,
  type PartnerChoiceProtocolV1,
  type PartnerChoiceReplayV1,
  type PartnerChoiceStudyManifestV1,
} from '../src/engine/experiment-contract';

interface GoldenRecord {
  recordType: 'protocol' | 'choice';
  payload: unknown;
}

function loadJson(path: URL): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function loadGolden(): { protocol: PartnerChoiceProtocolV1; events: PartnerChoiceReplayV1[] } {
  const records = readFileSync(new URL('./fixtures/partner-choice-v1.jsonl', import.meta.url), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as GoldenRecord);
  assert.equal(records[0]?.recordType, 'protocol');
  return {
    protocol: records[0].payload as PartnerChoiceProtocolV1,
    events: records.slice(1).map((record) => {
      assert.equal(record.recordType, 'choice');
      return record.payload as PartnerChoiceReplayV1;
    }),
  };
}

test('AgentSociety² 正式实验清单固定 2×2 主矩阵与 recent-3 稳健性组', () => {
  const manifest = loadJson(new URL('../platform/agentsociety2/experiment-manifest.v1.json', import.meta.url)) as PartnerChoiceStudyManifestV1;
  assert.doesNotThrow(() => assertStudyManifest(manifest));
  assert.equal(manifest.participantCount, 24);
  assert.equal(manifest.days, 60);
  assert.equal(manifest.seeds.length, 5);
  assert.equal(manifest.coreConditions.length, 4);
  assert.equal(manifest.analysis.confirmatoryOutcome.metric, 'directed_edge_repeat_rate');
  assert.deepEqual(manifest.analysis.confirmatoryOutcome.windowDays, [31, 60]);
  assert.equal(manifest.analysis.inference.minimumTwoSidedExactP, 0.0625);
  assert.equal(manifest.analysis.missingness.lateOrSkippedRound, 'invalidate_run');
});

test('golden Replay：协议哈希、候选顺序、历史暴露与每人一次选择均合法', () => {
  const { protocol, events } = loadGolden();
  assert.equal(
    hashPartnerChoiceProtocol(protocol),
    'sha256:10b16a57bd8cff317777920c3013f872f6e8eb29797ba5c04f9c2f1ef45e67a7',
  );
  assert.doesNotThrow(() => assertPartnerChoiceRound(protocol, events));
});

test('none 条件保持相同候选流程且拒绝任何伙伴历史暴露', () => {
  const { protocol, events } = loadGolden();
  const noneProtocol: PartnerChoiceProtocolV1 = {
    ...structuredClone(protocol),
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    runId: 'golden-none-seed-101',
    conditionId: 'memory-none__gift-off',
    manipulation: { historyMode: 'none', giftExchange: false },
  };
  const protocolHash = hashPartnerChoiceProtocol(noneProtocol);
  const noneEvents = events.map((source) => {
    const event: PartnerChoiceReplayV1 = {
      ...structuredClone(source),
      eventId: `${source.eventId}-none`,
      runId: noneProtocol.runId,
      conditionId: noneProtocol.conditionId,
      protocolHash,
      historyMode: 'none',
      visibleHistory: {},
      decision: { ...structuredClone(source.decision), observationHash: '' },
    };
    event.decision.observationHash = hashPartnerChoiceObservation(event);
    return event;
  });

  assert.doesNotThrow(() => assertPartnerChoiceRound(noneProtocol, noneEvents));

  const leaked = structuredClone(noneEvents);
  leaked[0].visibleHistory[leaked[0].candidateIds[0]] = [];
  leaked[0].decision.observationHash = hashPartnerChoiceObservation(leaked[0]);
  assert.throws(() => assertPartnerChoiceRound(noneProtocol, leaked), /must expose no partner history/);
});

test('配对条件的候选顺序是协议不变量', () => {
  const { protocol, events } = loadGolden();
  const pairedProtocol: PartnerChoiceProtocolV1 = {
    ...structuredClone(protocol),
    runId: 'golden-none-seed-101',
    conditionId: 'memory-none__gift-off',
    manipulation: { historyMode: 'none', giftExchange: false },
  };
  assert.deepEqual(candidateOrderFor(protocol, 1, 'a02'), candidateOrderFor(pairedProtocol, 1, 'a02'));

  const reordered = structuredClone(events);
  reordered[0].candidateIds.reverse();
  assert.throws(() => assertPartnerChoiceRound(protocol, reordered), /paired candidate order/);
});

test('叙事投影保留 mode/candidates/chosen，canonical JSON 不受对象插入顺序影响', () => {
  const { events } = loadGolden();
  const legacy = toLegacyChoicePayload(events[0]);
  assert.equal(legacy.kind, 'experiment_pair_choice');
  assert.equal(legacy.mode, 'on');
  assert.equal(legacy.chosen, events[0].chosenId);
  assert.deepEqual(legacy.candidates.map((candidate) => candidate.id), events[0].candidateIds);
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), canonicalJson({ a: { b: 3, y: 2 }, z: 1 }));
});
