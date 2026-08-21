import test from 'node:test';
import assert from 'node:assert/strict';

test('测试运行器可用（冒烟）', () => {
  assert.equal(1 + 1, 2);
});
