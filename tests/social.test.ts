import test from 'node:test';
import assert from 'node:assert/strict';
import { SocialTicker } from '../src/engine/social';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { makeAgent, persona } from './helpers';

function setup() {
  const log = new EventLog(openDb(':memory:'));
  const a = makeAgent({ id: 'agent:a', name: '甲', x: 0, y: 0, locationId: 'obj:plaza' });
  const b = makeAgent({ id: 'agent:b', name: '乙', x: 0, y: 1, locationId: 'obj:plaza' });
  const ticker = new SocialTicker(log);
  return { log, a, b, ticker };
}

test('相邻累计 3 分钟触发 chat 事件', () => {
  const { log, a, b, ticker } = setup();
  ticker.tick([a, b], 2, 10); // 累计 2 分钟
  assert.equal(log.count(), 0);
  ticker.tick([a, b], 1, 11); // 累计 3 分钟 → 触发
  const chat = log.eventsForDay(1).filter((e) => e.type === 'chat');
  assert.equal(chat.length, 1);
  assert.equal(chat[0].actorId, 'agent:a');
  assert.deepEqual(chat[0].targetIds, ['agent:b']);
  assert.equal(chat[0].payload?.line, '你好呀！'); // 无台词池 → 通用池第 0 条
  assert.match(chat[0].description, /^「甲」对「乙」说：「你好呀！」$/);
});

test('触发后冷却 90 分钟内不再触发，之后台词轮换', () => {
  const { log, a, b, ticker } = setup();
  ticker.tick([a, b], 3, 10); // 第 1 次
  for (let t = 15; t <= 99; t += 5) ticker.tick([a, b], 5, t); // 冷却期内不断相邻
  assert.equal(log.eventsForDay(1).filter((e) => e.type === 'chat').length, 1);
  ticker.tick([a, b], 1, 100); // 10 + 90 = 100 → 冷却结束
  const chats = log.eventsForDay(1).filter((e) => e.type === 'chat');
  assert.equal(chats.length, 2);
  assert.equal(chats[1].payload?.line, '今天天气真不错。'); // 通用池第 1 条
});

test('分离后累计清零', () => {
  const { log, a, b, ticker } = setup();
  ticker.tick([a, b], 2, 10); // 相邻 2 分钟
  a.x = 5; a.y = 5;           // 走远
  ticker.tick([a, b], 1, 11);
  a.x = 0; a.y = 0;           // 回来，重新累计
  ticker.tick([a, b], 2, 12);
  assert.equal(log.eventsForDay(1).filter((e) => e.type === 'chat').length, 0);
});

test('persona 台词池优先，冷却后轮换', () => {
  const log = new EventLog(openDb(':memory:'));
  const a = makeAgent({ id: 'agent:a', name: '甲', x: 0, y: 0, persona: persona({ greetingPool: ['你好！', '再见！'] }) });
  const b = makeAgent({ id: 'agent:b', name: '乙', x: 0, y: 1 });
  const ticker = new SocialTicker(log, { cooldownMinutes: 10 });
  ticker.tick([a, b], 3, 5);
  ticker.tick([a, b], 3, 16); // 冷却已过，再累计 3 分钟触发第二次
  const chats = log.eventsForDay(1).filter((e) => e.type === 'chat');
  assert.equal(chats[0].payload?.line, '你好！');
  assert.equal(chats[1].payload?.line, '再见！');
});

test('完整对话引擎拒绝新会话时不生成缺少 conversationId 的散落 chat', () => {
  const log = new EventLog(openDb(':memory:'));
  const a = makeAgent({ id: 'agent:a', name: '甲', x: 0, y: 0 });
  const b = makeAgent({ id: 'agent:b', name: '乙', x: 0, y: 1 });
  let attempts = 0;
  const dialogue = {
    isActive: () => false,
    start: () => { attempts++; return false; },
  } as unknown as import('../src/engine/dialogue').DialogueEngine;
  const ticker = new SocialTicker(log, {}, dialogue);
  ticker.tick([a, b], 3, 10);
  assert.equal(attempts, 1);
  assert.equal(log.count(), 0);
});
