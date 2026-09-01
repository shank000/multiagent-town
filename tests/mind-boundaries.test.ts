import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTown } from '../src/engine/seed';
import { MindEngine } from '../src/engine/mind';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import type { WorldState } from '../src/core/world';

interface SubmittedPlan {
  kind: 'daily' | 'hour';
  day: number;
  hour: number;
  now: number;
}

function planningHarness(): {
  mind: MindEngine;
  world: WorldState;
  submitted: SubmittedPlan[];
  close(): void;
} {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const mind = new MindEngine({ db, llm: new LLMGateway({ provider: 'mock' }), log });
  const agent = buildTown().allAgents()[0];
  const world = { allAgents: () => [agent] } as WorldState;
  const submitted: SubmittedPlan[] = [];

  mind.planner.scheduleDailyAndHour = async (_agent, day, hour, now) => {
    submitted.push({ kind: 'daily', day, hour, now });
  };
  mind.planner.scheduleHour = async (_agent, day, hour, now) => {
    submitted.push({ kind: 'hour', day, hour, now });
  };
  mind.reflection.tick = () => undefined;
  mind.reflection.summarizeDay = async () => undefined;
  mind.dialogue.tick = () => undefined;
  mind.townLife.tick = () => undefined;
  mind.townModel.tick = () => undefined;

  return { mind, world, submitted, close: () => db.raw.close() };
}

test('fractional ticks submit a repeated floored hour boundary only once', () => {
  const { mind, world, submitted, close } = planningHarness();
  try {
    for (let tick = 0; tick < 4; tick++) mind.tick(world, 0.25, 60);
    assert.deepEqual(submitted, [{ kind: 'hour', day: 1, hour: 1, now: 60 }]);
  } finally {
    close();
  }
});

test('dt=0 cognition settlement is idempotent at a daily-plan boundary', () => {
  const { mind, world, submitted, close } = planningHarness();
  try {
    mind.tick(world, 0.25, 300, true);
    mind.tick(world, 0, 300, true);
    assert.deepEqual(submitted, [{ kind: 'daily', day: 1, hour: 5, now: 300 }]);
  } finally {
    close();
  }
});

test('the normal hour after a daily plan remains schedulable and idempotent', () => {
  const { mind, world, submitted, close } = planningHarness();
  try {
    for (let tick = 0; tick < 4; tick++) mind.tick(world, 0.25, 300);
    for (let tick = 0; tick < 4; tick++) mind.tick(world, 0.25, 360);
    assert.deepEqual(submitted, [
      { kind: 'daily', day: 1, hour: 5, now: 300 },
      { kind: 'hour', day: 1, hour: 6, now: 360 },
    ]);
  } finally {
    close();
  }
});

test('a speed change cannot resubmit an already observed hour boundary', () => {
  const { mind, world, submitted, close } = planningHarness();
  try {
    mind.tick(world, 0.25, 419);
    mind.tick(world, 0.25, 420);
    mind.tick(world, 5, 420);
    mind.tick(world, 30, 420);
    assert.deepEqual(submitted, [{ kind: 'hour', day: 1, hour: 7, now: 420 }]);
  } finally {
    close();
  }
});

test('realtime sampling keeps its speed-based hour stride', () => {
  const { mind, world, submitted, close } = planningHarness();
  try {
    mind.tick(world, 5, 180, true);
    mind.tick(world, 5, 240, true);
    mind.tick(world, 30, 360, true);
    mind.tick(world, 0.25, 360, true);
    assert.deepEqual(submitted, [
      { kind: 'hour', day: 1, hour: 3, now: 180 },
      { kind: 'hour', day: 1, hour: 6, now: 360 },
    ]);
  } finally {
    close();
  }
});

test('multi-hour and multi-day jumps submit only the latest relevant boundary', () => {
  const { mind, world, submitted, close } = planningHarness();
  try {
    mind.tick(world, 250, 250);
    mind.tick(world, 3_250, 3_500);
    mind.tick(world, 3_250, 3_500);
    mind.tick(world, 40, 3_540);
    assert.deepEqual(submitted, [
      { kind: 'hour', day: 1, hour: 4, now: 250 },
      { kind: 'daily', day: 3, hour: 5, now: 3_500 },
      { kind: 'hour', day: 3, hour: 11, now: 3_540 },
    ]);
  } finally {
    close();
  }
});
