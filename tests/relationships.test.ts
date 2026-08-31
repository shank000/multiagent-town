import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { RelationshipStore } from '../src/store/relationships';

function setup() {
  const db = openDb(':memory:');
  return { db, store: new RelationshipStore(db) };
}

test('有向关系：A→B 与 B→A 分存', () => {
  const { store } = setup();
  store.update('agent:a', 'agent:b', { affectionDelta: 0.1 });
  const ab = store.getOrCreate('agent:a', 'agent:b');
  const ba = store.getOrCreate('agent:b', 'agent:a');
  assert.equal(ab.affection, 0.1);
  assert.equal(ba.affection, 0);
});

test('delta 夹紧 ±0.2、值夹紧 -1..1', () => {
  const { store } = setup();
  store.update('agent:a', 'agent:b', { affectionDelta: 0.5 }); // 夹到 0.2
  assert.equal(store.getOrCreate('agent:a', 'agent:b').affection, 0.2);
  store.update('agent:a', 'agent:b', { affectionDelta: 0.2 });
  store.update('agent:a', 'agent:b', { affectionDelta: 0.2 });
  store.update('agent:a', 'agent:b', { affectionDelta: 0.2 });
  store.update('agent:a', 'agent:b', { affectionDelta: 0.2 });
  store.update('agent:a', 'agent:b', { affectionDelta: 0.2 }); // 累计 1.2 → 夹 1
  assert.equal(store.getOrCreate('agent:a', 'agent:b').affection, 1);
  store.update('agent:a', 'agent:b', { affectionDelta: -2 }); // 夹 -0.2 → 0.8
  assert.equal(store.getOrCreate('agent:a', 'agent:b').affection, 0.8);
});

test('knowledge 叙事层追加并截断 20 条', () => {
  const { store } = setup();
  for (let i = 0; i < 25; i++) store.update('agent:a', 'agent:b', { knowledge: [`条目${i}`] });
  const r = store.getOrCreate('agent:a', 'agent:b');
  assert.equal(r.knowledge.length, 20);
  assert.equal(r.knowledge[19], '条目24'); // 保留最新
});

test('allFor 与 allPairs', () => {
  const { store } = setup();
  store.update('agent:a', 'agent:b', { respectDelta: 0.1 });
  store.update('agent:c', 'agent:a', { affectionDelta: 0.1 });
  assert.equal(store.allFor('agent:a').length, 1); // 出边：A 对他人的看法
  assert.equal(store.allPairs().length, 2);
});

test('每次关系变化记录有向来源、时间、实际增量与事件证据', () => {
  const { store } = setup();
  const evidence = store.update('agent:a', 'agent:b', {
    affectionDelta: 0.5,
    respectDelta: 0.1,
    evidence: {
      kind: 'gift_received',
      eventId: 'event:gift-1',
      text: '收到一束鲜花',
      trustDelta: 0.03,
      supportDelta: 0.1,
      metadata: { item: 'flower' },
    },
  }, 1_500.8);

  assert.equal(evidence.affectionBefore, 0);
  assert.equal(evidence.affectionDelta, 0.2); // 保存的是夹紧后的实际变化
  assert.equal(evidence.affectionAfter, 0.2);
  assert.equal(evidence.respectDelta, 0.1);
  assert.equal(evidence.gameTime, 1_500);
  assert.equal(evidence.sourceEventId, 'event:gift-1');
  assert.equal(evidence.sourceKind, 'gift_received');
  assert.equal(evidence.supportDelta, 0.1);
  assert.deepEqual(evidence.metadata, { item: 'flower' });
  assert.deepEqual(store.evidenceFor('agent:a', 'agent:b'), [evidence]);
  assert.deepEqual(store.evidenceFor('agent:b'), []);
});

test('关系状态与证据写入保持原子一致', () => {
  const { store } = setup();
  store.update('agent:a', 'agent:b', { affectionDelta: 0.1 }, 10);
  const before = store.getOrCreate('agent:a', 'agent:b');
  assert.throws(() => store.update('agent:a', 'agent:b', {
    affectionDelta: 0.1,
    evidence: {
      kind: 'other', text: '不可序列化证据', metadata: { invalid: 1n },
    },
  }, 20));
  assert.deepEqual(store.getOrCreate('agent:a', 'agent:b'), before);
  assert.equal(store.evidenceFor('agent:a', 'agent:b').length, 1);
});

test('近期重复对话增量递减，而馈礼处理保持原始效应', () => {
  const { store } = setup();
  const dialogueDeltas = [0, 10, 20].map((now) => store.update('agent:a', 'agent:b', {
    affectionDelta: 0.2,
    respectDelta: 0.1,
    evidence: { kind: 'dialogue', text: '继续交谈' },
  }, now));
  assert.equal(dialogueDeltas[0].affectionDelta, 0.2);
  assert.ok(dialogueDeltas[1].affectionDelta < dialogueDeltas[0].affectionDelta);
  assert.ok(dialogueDeltas[2].affectionDelta < dialogueDeltas[1].affectionDelta);
  assert.ok(Number(dialogueDeltas[1].metadata.repetitionScale) < 1);

  const firstGift = store.update('agent:c', 'agent:d', {
    affectionDelta: 0.1,
    evidence: { kind: 'gift_received', text: '收到鲜花' },
  }, 30);
  const secondGift = store.update('agent:c', 'agent:d', {
    affectionDelta: 0.1,
    evidence: { kind: 'gift_received', text: '再次收到鲜花' },
  }, 40);
  assert.equal(firstGift.affectionDelta, 0.1);
  assert.equal(secondGift.affectionDelta, 0.1);
});

test('关系证据按 gameTime 闭区间精确读取并用 SQL 计数', () => {
  const { db, store } = setup();
  store.update('agent:a', 'agent:b', { evidence: { kind: 'dialogue', text: '下界' } }, 100);
  store.update('agent:a', 'agent:c', { evidence: { kind: 'dialogue', text: '区间内其他关系' } }, 150);
  store.update('agent:b', 'agent:a', { evidence: { kind: 'dialogue', text: '反向上界' } }, 200);
  store.update('agent:a', 'agent:b', { evidence: { kind: 'dialogue', text: '区间外' } }, 201);

  assert.deepEqual(
    store.evidenceInGameTimeRange(100, 200).map((item) => [item.gameTime, item.sourceText]),
    [[200, '反向上界'], [150, '区间内其他关系'], [100, '下界']],
  );
  assert.equal(store.countEvidenceInGameTimeRange(100, 200), 3);
  assert.deepEqual(
    store.evidenceForDyadInGameTimeRange('agent:a', 'agent:b', 100, 200)
      .map((item) => [item.gameTime, item.agentA, item.agentB]),
    [[200, 'agent:b', 'agent:a'], [100, 'agent:a', 'agent:b']],
  );
  assert.equal(store.countEvidenceForDyadInGameTimeRange('agent:a', 'agent:b', 100, 200), 2);
  assert.deepEqual(store.evidenceInGameTimeRange(200, 100), []);
  assert.equal(store.countEvidenceInGameTimeRange(200, 100), 0);
  db.raw.close();
});

test('正式时间区间读取完整返回超过 20,000 条证据', () => {
  const { db, store } = setup();
  const total = 20_005;
  const insert = db.raw.prepare(
    `INSERT INTO relationship_evidence(
       id, agent_a, agent_b, source_kind, source_text, game_time,
       affection_before, affection_delta, affection_after,
       respect_before, respect_delta, respect_after, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.raw.exec('BEGIN');
  try {
    for (let index = 0; index < total; index++) {
      insert.run(
        `bulk:${index}`, 'agent:a', 'agent:b', 'dialogue', `证据 ${index}`, index,
        0, 0, 0, 0, 0, 0, '{}',
      );
    }
    db.raw.exec('COMMIT');
  } catch (error) {
    db.raw.exec('ROLLBACK');
    throw error;
  }

  const evidence = store.evidenceInGameTimeRange(0, total - 1);
  assert.equal(evidence.length, total);
  assert.equal(evidence[0].gameTime, total - 1);
  assert.equal(evidence.at(-1)?.gameTime, 0);
  assert.equal(store.countEvidenceInGameTimeRange(0, total - 1), total);
  assert.equal(store.countEvidenceForDyadInGameTimeRange('agent:a', 'agent:b', 0, total - 1), total);
  db.raw.close();
});
