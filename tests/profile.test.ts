// 阶段 B：6 份 persona 全属性档案完整性 + 快照 AgentView 档案字段
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SEED } from '../src/engine/seed';
import { buildTown } from '../src/engine/seed';
import { TimeEngine } from '../src/core/time';
import { buildSnapshot } from '../src/web/snapshot';

test('每份 persona 档案字段完整且合法', () => {
  for (const p of DEFAULT_SEED.personas) {
    assert.ok(p.gender === '男' || p.gender === '女', `${p.name} gender 非法`);
    assert.ok(p.appearance.hairStyle.length > 0, `${p.name} 缺发型`);
    assert.ok(p.appearance.hairColor.length > 0, `${p.name} 缺发色`);
    assert.ok(p.appearance.skinTone.length > 0, `${p.name} 缺肤色`);
    assert.ok(p.appearance.outfit.length > 0, `${p.name} 缺服装`);
    assert.ok(p.hobbies.length >= 2, `${p.name} 爱好不足`);
    assert.ok(Object.keys(p.skills).length >= 3, `${p.name} 技能不足`);
    for (const v of Object.values(p.skills)) {
      assert.ok(v >= 0 && v <= 10, `${p.name} 技能数值越界`);
    }
    assert.ok(p.values.length >= 2, `${p.name} 价值观不足`);
    assert.ok(p.motivation.length >= 10, `${p.name} 动机过短`);
    assert.ok(p.background.length >= 80, `${p.name} 背景故事过短`);
  }
});

test('快照 AgentView 携带档案全字段', () => {
  const world = buildTown();
  const time = new TimeEngine(60);
  const snap = buildSnapshot(world, time, false, 1);
  for (const a of snap.agents) {
    assert.ok(['男', '女'].includes(a.gender));
    assert.ok(a.hobbies.length >= 2);
    assert.ok(Object.keys(a.skills).length >= 3);
    assert.ok(a.values.length >= 2);
    assert.ok(a.motivation.length > 0);
    assert.ok(a.personality && typeof a.personality.extraversion === 'number');
    assert.ok(a.appearance && a.appearance.outfit.length > 0);
  }
});
