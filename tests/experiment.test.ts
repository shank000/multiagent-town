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
  const exp = new PartnerChoiceExperiment(log, world, mind, { historyAccess: 'off', giftExchange: 'off' });
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
  const exp = new PartnerChoiceExperiment(log, world, mind, { historyAccess: 'on', giftExchange: 'off' });
  const wins = { high: 0, low: 0 };
  for (let i = 0; i < 100; i++) {
    const p = exp.pickPartner(me)!;
    if (p.id === high.id) wins.high++;
    else if (p.id === low.id) wins.low++;
  }
  assert.ok(wins.high > wins.low * 2, `高亲密度应显著占优 (high=${wins.high}, low=${wins.low})`);
});

test('round：全员各选一伙伴、保留候选快照并安排远距一对一会话', async () => {
  const { db, log, world, mind } = setup();
  try {
    world.allAgents().forEach((agent, index) => { agent.x = index * 3; agent.y = 0; });
    const exp = new PartnerChoiceExperiment(log, world, mind, { historyAccess: 'off', giftExchange: 'off' });
    exp.round(1170);
    const ev = log.eventsBetween(0, 1e9).filter((e) => (e.payload as { kind?: string } | null)?.kind === 'experiment_pair_choice');
    assert.equal(ev.length, world.allAgents().length, '每位参与者一条选择事件');
    for (const event of ev) {
      const payload = event.payload as { candidates?: { id: string }[]; chosen?: string };
      assert.equal(payload.candidates?.length, world.allAgents().length - 1);
      assert.ok(payload.candidates?.some((candidate) => candidate.id === payload.chosen));
    }
    const starts = log.eventsBetween(0, 1e9).filter((event) => event.payload?.kind === 'chat_start');
    assert.ok(starts.length >= 1, '正式选择轮次会安排一对一会话');
    assert.ok(starts.every((event) => event.payload?.arranged === true));
  } finally {
    await mind.dispose();
    db.raw.close();
  }
});

test('经济系统：工资/购买/赠送/余额不足', async () => {
  const { db, log, world } = setup();
  void db; void log;
  const { Economy, ITEMS } = await import('../src/engine/economy');
  const eco = new Economy();
  const a = world.allAgents()[0].id;
  const b = world.allAgents()[1].id;
  eco.earnDaily(a);
  assert.equal(eco.getMoney(a), 10);
  assert.equal(eco.buy(a, 'flower'), true);
  assert.equal(eco.getMoney(a), 5);
  assert.equal(eco.buy(a, 'flower'), true);
  assert.equal(eco.getMoney(a), 0);
  assert.equal(eco.buy(a, 'flower'), false, '余额不足不能购买');
  const delta = eco.give(a, b, 'flower');
  assert.equal(delta, ITEMS.flower.affectionDelta);
  assert.equal(eco.inventoryOf(b).flower, 1, '收礼方库存形成可核验物品状态');
  assert.equal(eco.give(a, b, 'flower'), ITEMS.flower.affectionDelta, '第二束花仍可赠送'); // 买了 2 束
  assert.equal(eco.inventoryOf(b).flower, 2);
  assert.equal(eco.give(a, b, 'flower'), null, '无库存不能赠送');
});

test('实验馈礼由花店订单履约并记录来源、配送地点与收礼库存', async () => {
  const { db, log, world, mind } = setup();
  try {
    const exp = new PartnerChoiceExperiment(log, world, mind, { historyAccess: 'off', giftExchange: 'on' }, { seed: 17 });
    exp.round(1170);
    const gifts = log.eventsBetween(0, 2000).filter((event) => event.payload?.kind === 'gift');
    assert.equal(gifts.length, world.allAgents().length);
    for (const gift of gifts) {
      assert.equal(gift.location, 'obj:flower_counter');
      assert.equal(gift.payload?.status, 'fulfilled');
      assert.equal(gift.payload?.mechanism, 'flower_shop_delivery');
      assert.equal(gift.payload?.sourceObjectId, 'obj:flower_counter');
      assert.equal(typeof gift.payload?.deliveryLocationId, 'string');
      assert.ok(Number((gift.payload?.receiverInventory as { flower?: number }).flower) >= 1);
      assert.match(gift.description, /花店订单（已履约）.*配送.*交给/);
    }
  } finally {
    await mind.dispose();
    db.raw.close();
  }
});
