import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RELATIONAL_MEASURE_SCHEMA,
  computeRelationalMeasurements,
  relationDirectionKey,
  relationDyadKey,
  type PartnerChoiceObservation,
} from '../src/engine/relational-measures';
import type { Relationship, RelationshipEvidence, RelationshipSourceKind } from '../src/store/relationships';

const DAY = 1440;

function relationship(agentA: string, agentB: string): Relationship {
  return {
    agentA,
    agentB,
    knowledge: [],
    affection: 0,
    respect: 0,
    updatedGameTime: 0,
  };
}

function relationshipEvidence(input: {
  id: string;
  agentA: string;
  agentB: string;
  sourceKind: RelationshipSourceKind;
  gameTime: number;
  sourceEventId?: string | null;
}): RelationshipEvidence {
  return {
    id: input.id,
    agentA: input.agentA,
    agentB: input.agentB,
    sourceKind: input.sourceKind,
    sourceEventId: input.sourceEventId ?? input.id,
    sourceText: input.id,
    gameTime: input.gameTime,
    affectionBefore: 0,
    affectionDelta: 0,
    affectionAfter: 0,
    respectBefore: 0,
    respectDelta: 0,
    respectAfter: 0,
    trustDelta: 0,
    supportDelta: 0,
    tensionDelta: 0,
    metadata: {},
  };
}

function choice(fromId: string, toId: string, gameTime: number, eventId: string): PartnerChoiceObservation {
  return { fromId, toId, gameTime, eventId };
}

test('6+4 schema is complete and unobserved measures remain null', () => {
  const projection = computeRelationalMeasurements(
    [relationship('a', 'b'), relationship('b', 'a')],
    [],
    100,
    { choices: [] },
  );

  assert.equal(RELATIONAL_MEASURE_SCHEMA.length, 10);
  assert.equal(RELATIONAL_MEASURE_SCHEMA.filter((item) => item.family === 'existing-six').length, 6);
  assert.equal(RELATIONAL_MEASURE_SCHEMA.filter((item) => item.family === 'added-four').length, 4);

  const directed = projection.directed.get(relationDirectionKey('a', 'b'));
  assert.ok(directed);
  for (const measure of [
    directed.partnerReturn,
    directed.tiePersistence,
    directed.recencyEffect,
    directed.relationalCarryOver,
    directed.partnerConcentration,
    directed.interactionIntensity,
    directed.multiplexity,
    directed.partnerDependence,
  ]) {
    assert.equal(measure.value, null);
    assert.equal(measure.observed, false);
    assert.equal(measure.numerator, null);
    assert.equal(measure.denominator, null);
  }

  const dyad = projection.dyads.get(relationDyadKey('a', 'b'));
  assert.ok(dyad);
  assert.equal(dyad.reciprocity.value, null);
  assert.equal(dyad.dependenceAsymmetry.value, null);
  assert.equal(dyad.embeddedness.value, null);
});

test('partner return, adjacent-window persistence, carry-over, and actor concentration use distinct denominators', () => {
  const choices: PartnerChoiceObservation[] = [
    choice('a', 'b', 28_000, 'previous-ab-1'),
    choice('a', 'b', 28_100, 'previous-ab-2'),
    choice('a', 'b', 29_000, 'current-ab-1'),
    choice('a', 'b', 29_100, 'current-ab-2'),
    choice('a', 'c', 29_200, 'current-ac-1'),
    choice('a', 'b', 29_300, 'current-ab-3'),
    choice('a', 'b', 29_400, 'current-ab-4'),
  ];
  const projection = computeRelationalMeasurements([], [], 30_000, { windowDays: 1, choices });
  const ab = projection.directed.get(relationDirectionKey('a', 'b'));
  assert.ok(ab);

  assert.deepEqual(ab.partnerReturn, {
    value: 0.6667,
    observed: true,
    numerator: 2,
    denominator: 3,
    basis: 'partner_choice',
  });
  assert.deepEqual(ab.tiePersistence, {
    value: 0.5,
    observed: true,
    numerator: 2,
    denominator: 4,
    basis: 'partner_choice',
  });
  assert.deepEqual(ab.relationalCarryOver, {
    value: 0.75,
    observed: true,
    numerator: 3,
    denominator: 4,
    basis: 'partner_choice',
  });
  assert.deepEqual(ab.partnerConcentration, {
    value: 0.68,
    observed: true,
    numerator: null,
    denominator: 5,
    basis: 'partner_choice',
  });
});

test('tie persistence remains missing until a complete equal-length previous window exists', () => {
  const incomplete = computeRelationalMeasurements([], [], 7 * DAY - 1, {
    windowDays: 7,
    choices: [choice('a', 'b', 100, 'early-ab')],
  }).directed.get(relationDirectionKey('a', 'b'));
  assert.ok(incomplete);
  assert.equal(incomplete.tiePersistence.value, null);
  assert.equal(incomplete.tiePersistence.observed, false);

  const complete = computeRelationalMeasurements([], [], 14 * DAY - 1, {
    windowDays: 7,
    choices: [
      choice('a', 'b', 7 * DAY - 1, 'previous-ab'),
      choice('a', 'b', 7 * DAY, 'current-ab'),
    ],
  }).directed.get(relationDirectionKey('a', 'b'));
  assert.ok(complete);
  assert.deepEqual(complete.tiePersistence, {
    value: 1,
    observed: true,
    numerator: 1,
    denominator: 1,
    basis: 'partner_choice',
  });
});

test('interaction intensity deduplicates source events and multiplexity covers all four channels', () => {
  const evidence: RelationshipEvidence[] = [
    relationshipEvidence({ id: 'dialogue-1-a', sourceEventId: 'dialogue-1', agentA: 'a', agentB: 'b', sourceKind: 'dialogue', gameTime: 100 }),
    relationshipEvidence({ id: 'dialogue-1-b', sourceEventId: 'dialogue-1', agentA: 'a', agentB: 'b', sourceKind: 'dialogue', gameTime: 101 }),
    relationshipEvidence({ id: 'gift-1', agentA: 'a', agentB: 'b', sourceKind: 'gift_sent', gameTime: 200 }),
    relationshipEvidence({ id: 'activity-1', agentA: 'a', agentB: 'b', sourceKind: 'shared_activity', gameTime: 300 }),
    relationshipEvidence({ id: 'other-1', agentA: 'a', agentB: 'b', sourceKind: 'other', gameTime: 400 }),
  ];
  const projection = computeRelationalMeasurements(
    [relationship('a', 'b')],
    evidence,
    7 * DAY - 1,
    { windowDays: 7, choices: [choice('a', 'b', 500, 'choice-1')] },
  );
  const ab = projection.directed.get(relationDirectionKey('a', 'b'));
  assert.ok(ab);

  assert.equal(ab.interactionEventCount, 4);
  assert.deepEqual(ab.interactionIntensity, {
    value: 0.6321,
    observed: true,
    numerator: 4,
    denominator: 7,
    basis: 'relationship_evidence',
  });
  assert.deepEqual(ab.channels, ['communication', 'other', 'partner_choice', 'resource_exchange', 'shared_activity']);
  assert.deepEqual(ab.multiplexity, {
    value: 1,
    observed: true,
    numerator: 4,
    denominator: 4,
    basis: 'mixed',
  });
});

test('partner choice is an explicit multiplexity channel without being treated as an interaction episode', () => {
  const projection = computeRelationalMeasurements([], [], 1_000, {
    choices: [choice('a', 'b', 100, 'choice-ab')],
  });
  const ab = projection.directed.get(relationDirectionKey('a', 'b'));
  assert.ok(ab);
  assert.deepEqual(ab.channels, ['partner_choice']);
  assert.equal(ab.interactionIntensity.value, null);
  assert.deepEqual(ab.multiplexity, {
    value: 0.25,
    observed: true,
    numerator: 1,
    denominator: 4,
    basis: 'partner_choice',
  });
});

test('dependence asymmetry compares each actor\'s partner share and remains missing without both denominators', () => {
  const choices: PartnerChoiceObservation[] = [
    choice('a', 'b', 100, 'ab-1'),
    choice('a', 'b', 200, 'ab-2'),
    choice('a', 'b', 300, 'ab-3'),
    choice('a', 'c', 400, 'ac-1'),
    choice('b', 'a', 500, 'ba-1'),
    choice('b', 'c', 600, 'bc-1'),
    choice('d', 'a', 700, 'da-1'),
  ];
  const projection = computeRelationalMeasurements([], [], 1_000, { windowDays: 7, choices });
  const ab = projection.dyads.get(relationDyadKey('a', 'b'));
  assert.ok(ab);
  assert.deepEqual(projection.directed.get(relationDirectionKey('a', 'b'))?.partnerDependence, {
    value: 0.75,
    observed: true,
    numerator: 3,
    denominator: 4,
    basis: 'partner_choice',
  });
  assert.deepEqual(projection.directed.get(relationDirectionKey('b', 'a'))?.partnerDependence, {
    value: 0.5,
    observed: true,
    numerator: 1,
    denominator: 2,
    basis: 'partner_choice',
  });
  assert.equal(ab.dependenceAsymmetry.value, 0.25);
  assert.equal(ab.dependenceAsymmetry.observed, true);

  const ac = projection.dyads.get(relationDyadKey('a', 'c'));
  assert.ok(ac);
  assert.equal(ac.dependenceAsymmetry.value, null);
  assert.equal(ac.dependenceAsymmetry.observed, false);

  const ad = projection.dyads.get(relationDyadKey('a', 'd'));
  assert.ok(ad);
  assert.deepEqual(projection.directed.get(relationDirectionKey('a', 'd'))?.partnerDependence, {
    value: 0,
    observed: true,
    numerator: 0,
    denominator: 4,
    basis: 'partner_choice',
  });
  assert.equal(projection.directed.get(relationDirectionKey('d', 'a'))?.partnerDependence.value, 1);
  assert.equal(ad.dependenceAsymmetry.value, 1);
  assert.equal(ad.dependenceAsymmetry.observed, true);
});

test('embeddedness distinguishes a closed triangle from an open dyad neighborhood', () => {
  const triangle = computeRelationalMeasurements([], [
    relationshipEvidence({ id: 'unrelated-xy', agentA: 'x', agentB: 'y', sourceKind: 'dialogue', gameTime: 50 }),
  ], 1_000, {
    choices: [
      choice('a', 'b', 100, 'triangle-ab'),
      choice('a', 'c', 200, 'triangle-ac'),
      choice('b', 'c', 300, 'triangle-bc'),
    ],
  }).dyads.get(relationDyadKey('a', 'b'));
  assert.ok(triangle);
  assert.deepEqual(triangle.embeddedness, {
    value: 1,
    observed: true,
    numerator: 1,
    denominator: 1,
    basis: 'partner_choice',
  });
  assert.equal(triangle.commonNeighborCount, 1);
  assert.equal(triangle.unionNeighborCount, 1);

  const open = computeRelationalMeasurements([], [], 1_000, {
    choices: [
      choice('a', 'b', 100, 'open-ab'),
      choice('a', 'c', 200, 'open-ac'),
      choice('b', 'd', 300, 'open-bd'),
    ],
  }).dyads.get(relationDyadKey('a', 'b'));
  assert.ok(open);
  assert.deepEqual(open.embeddedness, {
    value: 0,
    observed: true,
    numerator: 0,
    denominator: 2,
    basis: 'partner_choice',
  });
  assert.equal(open.commonNeighborCount, 0);
  assert.equal(open.unionNeighborCount, 2);
});

test('finite recency windows exclude older observations while all includes them', () => {
  const oldEvidence = relationshipEvidence({
    id: 'old-ab', agentA: 'a', agentB: 'b', sourceKind: 'dialogue', gameTime: 100,
  });
  const now = 31 * DAY;
  for (const windowDays of [7, 30]) {
    const finite = computeRelationalMeasurements([], [oldEvidence], now, { windowDays })
      .directed.get(relationDirectionKey('a', 'b'));
    assert.ok(finite);
    assert.equal(finite.recencyEffect.value, null);
    assert.equal(finite.recencyEffect.observed, false);
  }
  const all = computeRelationalMeasurements([], [oldEvidence], now, { windowDays: null })
    .directed.get(relationDirectionKey('a', 'b'));
  assert.ok(all);
  assert.equal(all.recencyEffect.observed, true);
  assert.equal(all.recencyEffect.numerator, now - oldEvidence.gameTime);
});

test('30-day window includes its exact boundary and compares the complete preceding window', () => {
  const now = 60 * DAY - 1;
  const boundary = 30 * DAY;
  const projection = computeRelationalMeasurements([], [
    relationshipEvidence({ id: 'before-window', agentA: 'a', agentB: 'b', sourceKind: 'dialogue', gameTime: boundary - 1 }),
    relationshipEvidence({ id: 'at-window', agentA: 'a', agentB: 'b', sourceKind: 'dialogue', gameTime: boundary }),
    relationshipEvidence({ id: 'future', agentA: 'a', agentB: 'b', sourceKind: 'dialogue', gameTime: now + 1 }),
  ], now, {
    windowDays: 30,
    choices: [
      choice('a', 'b', boundary - 1, 'previous-boundary'),
      choice('a', 'b', boundary, 'current-boundary'),
      choice('a', 'b', now + 1, 'future-choice'),
    ],
  });
  assert.deepEqual(projection.window, {
    days: 30,
    startGameTime: boundary,
    endGameTime: now,
    label: '近 30 日',
  });
  assert.deepEqual(projection.observationSummary, { relationshipEvidence: 1, partnerChoices: 1 });
  const ab = projection.directed.get(relationDirectionKey('a', 'b'));
  assert.ok(ab);
  assert.equal(ab.interactionEventCount, 1);
  assert.equal(ab.tiePersistence.value, 1);
  assert.equal(ab.recencyEffect.numerator, now - boundary);
});
