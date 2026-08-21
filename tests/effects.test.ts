// 粒子系统：上限/衰减/清理 + 各发射器产出合法粒子（node 可测，draw 需 mock ctx 仅冒烟）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ParticleSystem, sitDust, steamPuff, sparkleBurst, zzzPuff, smokePuff, fireflySpawn, paperFlutter,
  rainDrop, rainSplash,
} from '../src/web/client/effects';
import { actionIconFor } from '../src/web/client/hud';

function mockCtx() {
  const noop = () => {};
  return {
    fillRect: noop, strokeRect: noop, beginPath: noop, arc: noop, fill: noop, ellipse: noop,
    fillText: noop, strokeText: noop, measureText: () => ({ width: 0 }), drawImage: noop,
    save: noop, restore: noop, translate: noop, scale: noop, setTransform: noop,
    createRadialGradient: () => ({ addColorStop: noop }),
    globalAlpha: 1, fillStyle: '', strokeStyle: '', font: '', lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
}

test('ParticleSystem 上限 512：超出时丢最旧粒子', () => {
  const sys = new ParticleSystem();
  for (let i = 0; i < 600; i++) sys.spawn(steamPuff(i, 0));
  assert.equal(sys.particles.length, 512);
  // shift 丢弃前 88 个 → 存活最老的是 i=88 的粒子（x≈88±4）
  assert.ok(sys.particles[0].x >= 84 && sys.particles[0].x <= 92);
});

test('update 衰减并清理死亡粒子', () => {
  const sys = new ParticleSystem();
  sys.spawn(zzzPuff(0, 0));
  const p = sys.particles[0];
  sys.update(p.maxLife + 1);
  assert.equal(sys.particles.length, 0);
});

test('各发射器返回坐标/寿命合法的粒子', () => {
  for (const ps of [sitDust(10, 20), steamPuff(10, 20), sparkleBurst(10, 20, '#fff'), zzzPuff(10, 20), smokePuff(10, 20), fireflySpawn(10, 20), paperFlutter(10, 20)]) {
    assert.ok(ps.length >= 1);
    for (const p of ps) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
      assert.ok(p.life > 0 && p.maxLife >= p.life);
      assert.ok(Number.isFinite(p.vx) && Number.isFinite(p.vy));
    }
  }
});

test('rainDrop/rainSplash 返回合法雨粒子', () => {
  for (const ps of [rainDrop(10, 20), rainSplash(10, 20)]) {
    assert.ok(ps.length >= 1);
    for (const p of ps) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
      assert.ok(p.life > 0 && p.maxLife >= p.life);
    }
  }
});

test('draw 冒烟：mock ctx 不抛异常', () => {
  const sys = new ParticleSystem();
  sys.spawn([...sitDust(5, 5), ...zzzPuff(5, 5), ...fireflySpawn(5, 5)]);
  sys.draw(mockCtx(), 1000);
});

test('actionIconFor：verb 关键词映射动作图标', () => {
  assert.equal(actionIconFor('煮咖啡招待客人', null), '☕');
  assert.equal(actionIconFor('在公园写生', null), '🎨');
  assert.equal(actionIconFor('到咖啡馆送信', null), '✉️');
  assert.equal(actionIconFor('睡觉', '床'), '💤');
  assert.equal(actionIconFor('坐在沙发上看书', null), '📖');
  assert.equal(actionIconFor('在码头钓鱼', null), '🎣');
  assert.equal(actionIconFor('随便走走', null), null);
});
