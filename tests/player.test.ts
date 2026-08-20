import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerDirector } from '../src/engine/player';

test('指令 60 游戏分钟内有效，之后过期', () => {
  const p = new PlayerDirector();
  p.act('agent:1', '去公园写生', 100);
  assert.equal(p.current('agent:1', 100), '去公园写生');
  assert.equal(p.current('agent:1', 159), '去公园写生');
  assert.equal(p.current('agent:1', 161), null); // 超 60 分钟
});

test('clear 移除指令；未设置返回 null', () => {
  const p = new PlayerDirector();
  assert.equal(p.current('agent:9', 0), null);
  p.act('agent:1', '去书店', 10);
  p.clear('agent:1');
  assert.equal(p.current('agent:1', 10), null);
});
