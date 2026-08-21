// 伙伴选择实验单测：选择逻辑（记忆开=按亲密度/新鲜度打分，关=随机）+ 每日轮次事件
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { buildTown } from '../src/engine/seed';
import { LLMGateway } from '../src/llm/gateway';
import { MindEngine } from '../src/engine/mind';
import { PartnerChoiceExperiment } from '../src/engine/experiment';
import type { Agent } from '../src/core/types';

function setup() {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const mind = new MindEngine({ db, llm: new LLMGateway({ provider: 'mock' }), log });
  return { db, log, world, mind };
}

test('记忆关：选择均匀随机（分布覆盖多伙伴）', () => {
  const { db, log, world, mind } = setup();
  const exp = new PartnerChoiceExperiment(log, world, mind, { historyAccess: 'off' });
  const agent = world.allAgents()[0];
  const picks = new Map<string, number>();
  for (let i = 0; i < 200; i++) {
    const p = exp.pickPartner(agent);
    assert.ok(p && p.id !== agent.id, 'partner 不能是自己');
    picks.set(p.id, (picks.get(p.id) ?? 0) + 1);
  }
  assert.ok(picks.size >= 3, '随机条件应覆盖多个伙伴');
});

test('记忆开：优先选择亲密度更高的伙伴', () => {
  const { db, log, world, mind } = setup();
  const agents = world.allAgents();
  const me = agents[0];
  const high = agents[1];
  const low = agents[2];
  mind.rels.update(me.id, high.id, { affectionDelta: 0.35 }, 1000);
  mind.rels.update(me.id, low.id, { affectionDelta: -0.2 }, 1000);
  const exp = new PartnerChoiceExperiment(log, world, mind, { historyAccess: 'on' });
  const wins = { high: 0, low: 0 };
  for (let i = 0; i < 100; i++) {
    const p = exp.pickPartner(me)!;
    if (p.id === high.id) wins.high++;
    else if (p.id === low.id) wins.low++;
  }
  assert.ok(wins.high > wins.low * 2, `高亲密度应显著占优 (high=${wins.high}, low=${wins.low})`);
});

test('round：全员各选一伙伴并记录 choice 事件', () => {
  const { db, log, world, mind } = setup();
  const exp = new PartnerChoiceExperiment(log, world, mind, { historyAccess: 'off' });
  exp.round(1170);
  const ev = log.eventsBetween(0, 1e9).filter((e) => (e.payload as { kind?: string } | null)?.kind === 'experiment_pair_choice');
  assert.equal(ev.length, world.allAgents().length, '每位参与者一条选择事件');
});
