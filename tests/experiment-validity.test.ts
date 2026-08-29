import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { buildTown } from '../src/engine/seed';
import { LLMGateway } from '../src/llm/gateway';
import { MindEngine } from '../src/engine/mind';
import {
  PartnerChoiceExperiment,
  recencyBonus,
  type PartnerExperimentConfig,
} from '../src/engine/experiment';

interface ChoicePayload {
  kind: string;
  fromId: string;
  toId: string;
  mode: 'on' | 'off';
  candidates: { id: string; name: string; affection: number; lastInteraction: number }[];
  chosen: string;
}

function setup(config: PartnerExperimentConfig, seed: number) {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const mind = new MindEngine({ db, llm: new LLMGateway({ provider: 'mock' }), log });
  const experiment = new PartnerChoiceExperiment(log, world, mind, config, { seed });
  return { log, world, mind, experiment };
}

function choiceSequence(seed: number, historyAccess: 'on' | 'off'): string {
  const { log, experiment } = setup({ historyAccess, giftExchange: 'off' }, seed);
  for (let day = 0; day < 8; day++) experiment.round(day * 1440 + 1170);
  const choices = log.eventsBetween(0, 20_000)
    .map((event) => event.payload as Partial<ChoicePayload> | null)
    .filter((payload): payload is ChoicePayload => payload?.kind === 'experiment_pair_choice')
    .map(({ fromId, toId, mode, candidates, chosen }) => ({ fromId, toId, mode, candidates, chosen }));
  return JSON.stringify(choices);
}

test('labelled seed makes every pilot partner-choice policy reproducible', () => {
  for (const mode of ['off', 'on'] as const) {
    assert.equal(choiceSequence(17, mode), choiceSequence(17, mode));
    assert.notEqual(choiceSequence(17, mode), choiceSequence(18, mode));
  }
});

test('recency is relative to decision time and absent relationships receive no bonus', () => {
  assert.equal(recencyBonus(10_000, undefined), 0);
  assert.equal(recencyBonus(10_000, null), 0);
  assert.equal(recencyBonus(10_000, 10_000), 1);
  assert.equal(recencyBonus(10_000, 11_000), 1);
  assert.equal(recencyBonus(10_000, 8_800), 0.5);
  assert.equal(recencyBonus(10_000, 7_600), 0);
  assert.equal(recencyBonus(10_000, 6_000), 0);
});

test('candidate snapshots and all choices are frozen before same-round gifts', () => {
  const { log, world, mind, experiment } = setup(
    { historyAccess: 'off', giftExchange: 'on' },
    29
  );

  experiment.round(1170);

  const choices = log.eventsBetween(0, 2000)
    .map((event) => event.payload as Partial<ChoicePayload> | null)
    .filter((payload): payload is ChoicePayload => payload?.kind === 'experiment_pair_choice');
  assert.equal(choices.length, world.allAgents().length);
  for (const choice of choices) {
    assert.equal(choice.chosen, choice.toId);
    assert.equal(choice.mode, 'off');
    assert.equal(choice.candidates.length, world.allAgents().length - 1);
    assert.equal(choice.candidates.find((candidate) => candidate.id === choice.toId)?.affection, 0);
  }
  assert.ok(mind.rels.allPairs().some((relationship) => relationship.affection > 0));
  const events = log.eventsBetween(0, 2000);
  for (const choice of choices) {
    const choiceIndex = events.findIndex((event) =>
      event.payload?.kind === 'experiment_pair_choice' && event.payload.fromId === choice.fromId
    );
    const giftIndex = events.findIndex((event) =>
      event.payload?.kind === 'gift' && event.payload.fromId === choice.fromId
    );
    assert.ok(choiceIndex >= 0 && giftIndex > choiceIndex);
  }
});
