import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { MemoryStore, memoryRetrievalScore } from '../src/store/memory';

test('旧关键词命中后，无关查询不会被刷新的 lastAccess 锁定', () => {
  const db = openDb(':memory:');
  const store = new MemoryStore(db);
  try {
    store.addMemory({
      id: 'memory:old', agentId: 'agent:1', kind: 'observation',
      content: '在咖啡馆研磨咖啡豆', importance: 5, createdGameTime: 0,
    });
    store.addMemory({
      id: 'memory:new', agentId: 'agent:1', kind: 'observation',
      content: '在湖边安静地看云', importance: 5, createdGameTime: 900,
    });

    const keywordHit = store.retrieve('agent:1', '咖啡馆研磨咖啡豆', 1000, 1);
    assert.equal(keywordHit[0].id, 'memory:old');
    assert.equal(keywordHit[0].lastAccessGameTime, 1000);

    let newerSelections = 0;
    for (let now = 1001; now <= 1010; now += 1) {
      const result = store.retrieve('agent:1', '邮局收取今天的信件', now, 1);
      if (result[0].id === 'memory:new') newerSelections += 1;
    }
    assert.equal(newerSelections, 10, '10/10 次无关查询均应选择真正较新的可比证据');

    const memories = new Map(store.recentMemories('agent:1', 2).map((memory) => [memory.id, memory]));
    assert.equal(memories.get('memory:old')?.lastAccessGameTime, 1000, '旧记忆的审计时间不会被无关查询刷新');
    assert.equal(memories.get('memory:new')?.lastAccessGameTime, 1010);
  } finally {
    db.raw.close();
  }
});

test('同分记忆使用稳定 ID 决胜，插入顺序和既往访问时间不改变排序', () => {
  const rank = (ids: string[]): string[] => {
    const db = openDb(':memory:');
    const store = new MemoryStore(db);
    try {
      for (const id of ids) {
        store.addMemory({
          id, agentId: 'agent:1', kind: 'observation', content: '同一条可比证据',
          importance: 5, createdGameTime: 100,
        });
      }
      store.retrieve('agent:1', '同一条可比证据', 150, 1);
      return store.retrieve('agent:1', '无关问题', 200, 3).map((memory) => memory.id);
    } finally {
      db.raw.close();
    }
  };

  assert.deepEqual(rank(['memory:z', 'memory:a', 'memory:m']), ['memory:a', 'memory:m', 'memory:z']);
  assert.deepEqual(rank(['memory:m', 'memory:z', 'memory:a']), ['memory:a', 'memory:m', 'memory:z']);
});

test('三因子得分公开各分量，并按 createdGameTime 而非 lastAccess 计算近因', () => {
  const older = memoryRetrievalScore({
    content: '相同内容', importance: 5, createdGameTime: 100,
  }, '相同内容', 1000);
  const newer = memoryRetrievalScore({
    content: '相同内容', importance: 5, createdGameTime: 900,
  }, '相同内容', 1000);

  assert.equal(older.importance, newer.importance);
  assert.equal(older.relevance, newer.relevance);
  assert.ok(newer.recency > older.recency);
  assert.ok(newer.total > older.total);
});
