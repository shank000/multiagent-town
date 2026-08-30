import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSocialRelationships, SOCIAL_RELATION_MODEL_VERSION } from '../src/engine/social-relations';
import { openDb } from '../src/store/db';
import { RelationshipStore } from '../src/store/relationships';

test('社会关系投影区分方向、代理维度、近期变化与证据', () => {
  const db = openDb(':memory:');
  try {
    const store = new RelationshipStore(db);
    store.update('agent:a', 'agent:b', {
      affectionDelta: 0.2,
      respectDelta: 0.1,
      evidence: {
        kind: 'gift_received', eventId: 'gift-1', text: '甲收到乙的鲜花',
        trustDelta: 0.08, supportDelta: 0.2,
      },
    }, 9 * 1440);
    store.update('agent:a', 'agent:b', {
      affectionDelta: 0.2,
      evidence: { kind: 'dialogue', eventId: 'chat-1', text: '甲与乙坦诚交谈', trustDelta: 0.12 },
    }, 10 * 1440);
    store.update('agent:b', 'agent:a', {
      affectionDelta: -0.2,
      respectDelta: -0.1,
      evidence: { kind: 'dialogue', eventId: 'chat-2', text: '乙对甲的承诺表示怀疑', trustDelta: -0.1 },
    }, 10 * 1440);

    const projection = projectSocialRelationships(
      store.allPairs(),
      store.allEvidence(),
      new Map([['agent:a', '甲'], ['agent:b', '乙']]),
      10 * 1440,
      {
        windowDays: 7,
        choices: [
          { fromId: 'agent:a', toId: 'agent:b', gameTime: 10 * 1440 - 20, eventId: 'choice-ab' },
          { fromId: 'agent:b', toId: 'agent:a', gameTime: 10 * 1440 - 10, eventId: 'choice-ba' },
        ],
      },
    );
    assert.equal(projection.modelVersion, SOCIAL_RELATION_MODEL_VERSION);
    assert.equal(projection.modelVersion, 'social-relations-v2');
    assert.equal(projection.window.days, 7);
    assert.equal(projection.measureSchema.length, 10);
    assert.equal(projection.measureSchema.filter((item) => item.family === 'existing-six').length, 6);
    assert.equal(projection.measureSchema.filter((item) => item.family === 'added-four').length, 4);
    assert.deepEqual(projection.observationSummary, { relationshipEvidence: 3, partnerChoices: 2 });
    assert.match(projection.proxyNotice, /只读观察量|描述性代理/);
    assert.equal(projection.directions.length, 2);
    const ab = projection.directions.find((direction) => direction.fromId === 'agent:a');
    const ba = projection.directions.find((direction) => direction.fromId === 'agent:b');
    assert.ok(ab);
    assert.ok(ba);
    assert.equal(ab.directionLabel, '甲 → 乙');
    assert.equal(ab.relationshipStateObserved, true);
    assert.ok(ab.legacy);
    assert.equal(ab.dimensions.closeness, 0.4);
    assert.equal(ab.dimensions.trust, 0.2);
    assert.equal(ab.dimensions.support, 0.2);
    assert.ok(ab.dimensions.frequency > 0);
    assert.ok(ab.recentChange > 0);
    assert.equal(ab.evidence[0].sourceEventId, 'chat-1');
    assert.equal(ab.measures.interactionIntensity.observed, true);
    assert.equal(ab.measures.partnerDependence.value, 1);
    assert.equal(ba.dimensions.closeness, -0.2);
    assert.ok(ba.dimensions.tension > 0);
    assert.ok(ba.recentChange < 0);
    assert.equal(ba.tieType, 'strained');

    assert.equal(projection.dyads.length, 1);
    const dyad = projection.dyads[0];
    assert.equal(dyad.aId, 'agent:a');
    assert.equal(dyad.bId, 'agent:b');
    assert.ok(dyad.asymmetry > 0);
    assert.ok(dyad.reciprocity < 1);
    assert.equal(dyad.tieType, 'strained');
    assert.equal(dyad.measures.dependenceAsymmetry.value, 0);
    assert.equal(dyad.measures.embeddedness.value, 0);
    assert.equal(dyad.aToBMeasures.partnerDependence.value, 1);
    assert.equal(dyad.bToAMeasures.partnerDependence.value, 1);
  } finally {
    db.raw.close();
  }
});

test('choice-only directions remain observable without fabricating relationship state', () => {
  const projection = projectSocialRelationships(
    [],
    [],
    new Map([['agent:a', '甲'], ['agent:b', '乙']]),
    1_000,
    {
      windowDays: 7,
      choices: [
        { fromId: 'agent:a', toId: 'agent:b', gameTime: 100, eventId: 'choice-ab' },
        { fromId: 'agent:b', toId: 'agent:a', gameTime: 200, eventId: 'choice-ba' },
      ],
    },
  );

  assert.equal(projection.directions.length, 2);
  const ab = projection.directions.find((direction) => (
    direction.fromId === 'agent:a' && direction.toId === 'agent:b'
  ));
  const ba = projection.directions.find((direction) => (
    direction.fromId === 'agent:b' && direction.toId === 'agent:a'
  ));
  assert.ok(ab);
  assert.ok(ba);
  assert.equal(ab.relationshipStateObserved, false);
  assert.equal(ab.legacy, null);
  assert.equal(ab.evidenceCount, 0);
  assert.equal(ab.lastInteraction, 100);
  assert.equal(ab.measures.partnerDependence.value, 1);
  assert.equal(ab.measures.multiplexity.value, 0.25);
  assert.equal(ba.relationshipStateObserved, false);
  assert.equal(ba.legacy, null);
  assert.equal(ba.lastInteraction, 200);

  assert.equal(projection.dyads.length, 1);
  assert.equal(projection.dyads[0].measures.dependenceAsymmetry.value, 0);
  assert.equal(projection.dyads[0].measures.reciprocity.value, 1);
});

test('投影标签是只读派生结果，不改变旧字段或证据', () => {
  const db = openDb(':memory:');
  try {
    const store = new RelationshipStore(db);
    store.update('agent:a', 'agent:b', {
      affectionDelta: 0.1,
      evidence: { kind: 'shared_activity', eventId: 'activity-1', text: '共同参加读书会' },
    }, 100);
    const beforeRelationship = store.getOrCreate('agent:a', 'agent:b');
    const beforeEvidence = store.allEvidence();
    const projection = projectSocialRelationships(
      store.allPairs(), beforeEvidence, new Map(), 200
    );
    assert.equal(projection.directions[0].tieType, 'acquaintance');
    assert.deepEqual(store.getOrCreate('agent:a', 'agent:b'), beforeRelationship);
    assert.deepEqual(store.allEvidence(), beforeEvidence);
  } finally {
    db.raw.close();
  }
});
