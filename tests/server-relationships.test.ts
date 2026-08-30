import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeEngine } from '../src/core/time';
import { WorldState } from '../src/core/world';
import { AgentExecutor } from '../src/core/state-machine';
import { WorldLoop } from '../src/engine/loop';
import { LLMGateway } from '../src/llm/gateway';
import { MindEngine } from '../src/engine/mind';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { createTownServer } from '../src/web/server';
import { makeAgent, persona } from './helpers';
import type { WorldObject } from '../src/core/types';

const OBJECTS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
];

test('关系 API 返回世界定址的有向多维投影、不对称性与证据', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const a = makeAgent({ id: 'agent:a', name: '甲', persona: persona({ name: '甲' }) });
  const b = makeAgent({ id: 'agent:b', name: '乙', persona: persona({ name: '乙' }) });
  const c = makeAgent({ id: 'agent:c', name: '丙', persona: persona({ name: '丙' }) });
  const world = new WorldState(OBJECTS, [a, b, c]);
  const time = new TimeEngine(3_000);
  time.tick();
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  mind.rels.update(a.id, b.id, {
    affectionDelta: 0.2, respectDelta: 0.1,
    evidence: {
      kind: 'gift_received', eventId: 'gift:1', text: '收到鲜花',
      trustDelta: 0.05, supportDelta: 0.2,
    },
  }, 100);
  mind.rels.update(b.id, a.id, {
    affectionDelta: -0.1,
    evidence: { kind: 'dialogue', eventId: 'chat:1', text: '发生分歧', trustDelta: -0.05 },
  }, 110);
  mind.rels.update(c.id, a.id, {
    respectDelta: 0.1,
    evidence: { kind: 'dialogue', eventId: 'chat:incoming', text: '丙认可甲的判断', trustDelta: 0.03 },
  }, 115);
  for (const event of [
    { id: 'choice:a-b', fromId: a.id, toId: b.id, gameTime: 2_700 },
    { id: 'choice:b-a', fromId: b.id, toId: a.id, gameTime: 2_800 },
    { id: 'choice:a-c', fromId: a.id, toId: c.id, gameTime: 2_900 },
  ]) {
    log.addEvent({
      id: event.id,
      type: 'chat',
      actorId: event.fromId,
      targetIds: [event.toId],
      description: `${event.fromId} 选择 ${event.toId}`,
      location: null,
      gameTime: event.gameTime,
      payload: {
        kind: 'experiment_pair_choice',
        fromId: event.fromId,
        toId: event.toId,
        mode: 'on',
        candidates: [],
        chosen: event.toId,
      },
    });
  }
  mind.rels.allEvidence = () => {
    throw new Error('关系 API 应使用精确 gameTime 区间查询');
  };
  const loop = new WorldLoop(time, world, new AgentExecutor(gateway, world, log, mind), log, db, {}, undefined, mind);
  const server = await createTownServer({ world, time, loop, log, mind, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const networkResponse = await fetch(`${base}/api/relationships?worldId=w1`);
    assert.equal(networkResponse.status, 200);
    const network = await networkResponse.json() as {
      worldId: string; modelVersion: string;
      window: { days: number | null; startGameTime: number; endGameTime: number };
      measureSchema: { key: string; family: string }[];
      observationSummary: { relationshipEvidence: number; partnerChoices: number };
      directions: {
        fromId: string; toId: string; relationshipStateObserved: boolean; legacy: object | null;
        dimensions: { trust: number; support: number; tension: number }; measures: object;
      }[];
      dyads: { reciprocity: number; asymmetry: number; measures: object }[];
    };
    assert.equal(network.worldId, 'w1');
    assert.equal(network.modelVersion, 'social-relations-v2');
    assert.equal(network.window.days, 7);
    assert.equal(network.measureSchema.length, 10);
    assert.deepEqual(network.observationSummary, { relationshipEvidence: 3, partnerChoices: 3 });
    assert.equal(network.directions.length, 4);
    assert.equal(network.dyads.length, 2);
    assert.ok(network.dyads[0].asymmetry > 0);
    assert.ok(network.dyads[0].reciprocity < 1);
    const ab = network.directions.find((direction) => direction.fromId === a.id);
    assert.ok(ab);
    assert.equal(ab.toId, b.id);
    assert.equal(ab.dimensions.trust, 0.05);
    assert.equal(ab.dimensions.support, 0.2);
    assert.equal(Object.hasOwn(ab, 'evidence'), false, '全网摘要不嵌入逐条关系证据');
    assert.ok(ab.measures);
    const choiceOnly = network.directions.find((direction) => (
      direction.fromId === a.id && direction.toId === c.id
    ));
    assert.ok(choiceOnly);
    assert.equal(choiceOnly.relationshipStateObserved, false);
    assert.equal(choiceOnly.legacy, null);
    assert.equal(Object.hasOwn(network.dyads[0], 'aToB'), false, '全网摘要不嵌入完整双向关系对象');
    assert.equal(Object.hasOwn(network.dyads[0], 'aToBMeasures'), false, '方向测量只在 directions 中返回');

    const recentResponse = await fetch(`${base}/api/relationships?worldId=w1&windowDays=1`);
    assert.equal(recentResponse.status, 200);
    const recent = await recentResponse.json() as {
      window: { days: number | null; startGameTime: number };
      observationSummary: { relationshipEvidence: number; partnerChoices: number };
      directions: { fromId: string; toId: string; evidenceCount: number; dimensions: { trust: number } }[];
    };
    assert.equal(recent.window.days, 1);
    assert.equal(recent.window.startGameTime, 1_561);
    assert.deepEqual(recent.observationSummary, { relationshipEvidence: 0, partnerChoices: 3 });
    const recentAB = recent.directions.find((direction) => direction.fromId === a.id && direction.toId === b.id);
    assert.ok(recentAB);
    assert.equal(recentAB.evidenceCount, 0);
    assert.equal(recentAB.dimensions.trust, 0.05, '有限指标窗不裁掉累计关系画像的历史证据');

    const allHistoryResponse = await fetch(`${base}/api/relationships?worldId=w1&windowDays=all`);
    assert.equal(allHistoryResponse.status, 200);
    const allHistory = await allHistoryResponse.json() as {
      window: { days: number | null; startGameTime: number };
      observationSummary: { relationshipEvidence: number; partnerChoices: number };
    };
    assert.equal(allHistory.window.days, null);
    assert.equal(allHistory.window.startGameTime, 0);
    assert.deepEqual(allHistory.observationSummary, { relationshipEvidence: 3, partnerChoices: 3 });
    assert.equal((await fetch(`${base}/api/relationships?worldId=w1&windowDays=0`)).status, 400);
    assert.equal((await fetch(`${base}/api/relationships?worldId=w1&windowDays=1.5`)).status, 400);

    const dyadResponse = await fetch(
      `${base}/api/relationships/dyad?worldId=w1&aId=${encodeURIComponent(a.id)}&bId=${encodeURIComponent(b.id)}&windowDays=all`,
    );
    assert.equal(dyadResponse.status, 200);
    const dyadDetail = await dyadResponse.json() as {
      schemaVersion: string;
      worldId: string;
      modelVersion: string;
      scope: { source: string; validatedRun: boolean | null };
      people: { a: { id: string; name: string }; b: { id: string; name: string } };
      aToB: { measures: object } | null;
      bToA: { measures: object } | null;
      dyad: { measures: object } | null;
      evidenceSummary: {
        totalCount: number; loadedCount: number; returnedCount: number;
        truncated: boolean; earliestLoaded: number | null;
      };
      evidenceTimeline: { sourceEventId: string; direction: string }[];
      choiceEvents: { fromId: string; toId: string }[];
      conversations: unknown[];
    };
    assert.equal(dyadDetail.schemaVersion, 'social-dyad.response/v2');
    assert.equal(dyadDetail.worldId, 'w1');
    assert.equal(dyadDetail.modelVersion, 'social-relations-v2');
    assert.deepEqual(dyadDetail.scope, { source: 'local_event_log', validatedRun: null });
    assert.deepEqual(dyadDetail.people, {
      a: { id: a.id, name: '甲' },
      b: { id: b.id, name: '乙' },
    });
    assert.ok(dyadDetail.aToB);
    assert.ok(dyadDetail.bToA);
    assert.equal(Object.hasOwn(dyadDetail.aToB, 'evidence'), false);
    assert.equal(Object.hasOwn(dyadDetail.bToA, 'evidence'), false);
    assert.equal(Object.hasOwn(dyadDetail.dyad ?? {}, 'aToB'), false);
    assert.equal(Object.hasOwn(dyadDetail.dyad ?? {}, 'aToBMeasures'), false);
    assert.ok(dyadDetail.dyad?.measures);
    assert.deepEqual(dyadDetail.evidenceSummary, {
      totalCount: 2,
      loadedCount: 2,
      returnedCount: 2,
      truncated: false,
      earliestLoaded: 100,
    });
    assert.deepEqual(
      new Set(dyadDetail.evidenceTimeline.map((item) => item.sourceEventId)),
      new Set(['gift:1', 'chat:1']),
    );
    assert.equal(dyadDetail.choiceEvents.length, 2);

    const recentDyadResponse = await fetch(
      `${base}/api/relationships/dyad?worldId=w1&aId=${encodeURIComponent(a.id)}&bId=${encodeURIComponent(b.id)}&windowDays=1`,
    );
    assert.equal(recentDyadResponse.status, 200);
    const recentDyad = await recentDyadResponse.json() as {
      evidenceSummary: {
        totalCount: number; loadedCount: number; returnedCount: number;
        truncated: boolean; earliestLoaded: number | null;
      };
      evidenceTimeline: unknown[];
    };
    assert.deepEqual(recentDyad.evidenceSummary, {
      totalCount: 0,
      loadedCount: 0,
      returnedCount: 0,
      truncated: false,
      earliestLoaded: null,
    });
    assert.deepEqual(recentDyad.evidenceTimeline, []);

    const egoResponse = await fetch(`${base}/api/relationships/${encodeURIComponent(a.id)}?worldId=w1`);
    assert.equal(egoResponse.status, 200);
    const ego = await egoResponse.json() as {
      worldId: string; proxyNotice: string;
      relations: { otherId: string; affection: number; direction: { directionLabel: string; evidenceCount: number }; reverseDirection: { directionLabel: string }; asymmetry: number }[];
    };
    assert.equal(ego.worldId, 'w1');
    assert.match(ego.proxyNotice, /代理/);
    const bRelation = ego.relations.find((relation) => relation.otherId === b.id);
    assert.ok(bRelation);
    assert.equal(bRelation.affection, 0.2); // 旧字段保持兼容
    assert.equal(bRelation.direction.directionLabel, '甲 → 乙');
    assert.equal(bRelation.reverseDirection.directionLabel, '乙 → 甲');
    assert.ok(bRelation.asymmetry > 0);
    const incomingOnly = ego.relations.find((relation) => relation.otherId === c.id) as {
      direction: { directionLabel: string; relationshipStateObserved: boolean; legacy: object | null };
      reverseDirection: { directionLabel: string; relationshipStateObserved: boolean };
      asymmetry: number;
    } | undefined;
    assert.ok(incomingOnly);
    assert.equal(incomingOnly.direction.directionLabel, '甲 → 丙');
    assert.equal(incomingOnly.direction.relationshipStateObserved, false);
    assert.equal(incomingOnly.direction.legacy, null);
    assert.equal(incomingOnly.reverseDirection.directionLabel, '丙 → 甲');
    assert.equal(incomingOnly.reverseDirection.relationshipStateObserved, true);
    assert.ok(incomingOnly.asymmetry > 0 && incomingOnly.asymmetry < 1);

    assert.equal((await fetch(`${base}/api/relationships?worldId=missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/relationships/${encodeURIComponent('agent:missing')}?worldId=w1`)).status, 404);
    assert.equal((await fetch(
      `${base}/api/relationships/dyad?worldId=w1&aId=${encodeURIComponent(a.id)}&bId=${encodeURIComponent('agent:missing')}`,
    )).status, 404);
    assert.equal((await fetch(
      `${base}/api/relationships/dyad?worldId=w1&aId=${encodeURIComponent(a.id)}&bId=${encodeURIComponent(a.id)}`,
    )).status, 400);
  } finally {
    await server.close();
    await mind.dispose();
    db.raw.close();
  }
});
