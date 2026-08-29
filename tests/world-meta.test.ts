import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedWorld, type WorldKind } from '../src/engine/world-factory';

test('平行世界元数据明确展示各自处理条件与研究用途', () => {
  const worlds = (['mem-on', 'mem-off', 'rumor'] as WorldKind[])
    .map((kind, index) => createManagedWorld(`w${index + 1}`, kind));
  try {
    assert.deepEqual(worlds[0].meta.badges.map((x) => [x.label, x.value]), [
      ['历史', '可见'], ['馈礼', '开启'], ['用途', '联合处理展示'],
    ]);
    assert.deepEqual(worlds[1].meta.badges.map((x) => [x.label, x.value]), [
      ['历史', '隐藏'], ['馈礼', '关闭'], ['用途', '零处理参考'],
    ]);
    assert.deepEqual(worlds[2].meta.badges.map((x) => [x.label, x.value]), [
      ['处理', '秘密注入'], ['观测', '传播链'], ['伙伴实验', '不适用'],
    ]);
    assert.match(worlds[0].meta.desc, /2×2/);
    assert.match(worlds[1].meta.desc, /相同 LLM 决策流程/);
  } finally {
    for (const world of worlds) {
      world.loop.stop();
      world.db.raw.close();
    }
  }
});

test('world factory applies runtime clock settings while keeping paired experiment seeds stable', async () => {
  const fast = createManagedWorld('fast', 'mem-on', { seed: 17, gameMinutesPerTick: 180 });
  const paired = createManagedWorld('paired', 'mem-on', { seed: 17, gameMinutesPerTick: 30 });
  try {
    assert.equal(fast.time.gameMinutesPerTick, 180);
    assert.equal(paired.time.gameMinutesPerTick, 30);
    fast.mind.dialogue.start = () => {};
    paired.mind.dialogue.start = () => {};
    for (const managed of [fast, paired]) {
      managed.experiment?.start(1, 0);
      managed.experiment?.tick(1170);
    }
    const choices = (managed: typeof fast) => managed.log
      .eventsOfKind('experiment_pair_choice')
      .map((event) => [event.payload?.fromId, event.payload?.toId]);
    assert.deepEqual(choices(fast), choices(paired));
  } finally {
    await Promise.all([fast.mind.dispose(), paired.mind.dispose()]);
    fast.db.raw.close();
    paired.db.raw.close();
  }
});
