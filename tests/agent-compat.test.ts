import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentView, normalizeAgentViews } from '../src/web/client/agent-compat';
import { normalizePixelAvatar, pixelAvatarMarkup } from '../src/web/client/avatar';
import type { AgentView } from '../src/web/client/panel';

const legacyAgent = {
  id: 'agent:林晚晴', name: '林晚晴', occupation: '咖啡馆老板', state: 'acting',
  age: 32, gender: '女',
  appearance: { hairStyle: '短发', hairColor: '深棕色', skinTone: '浅麦色', outfit: '围裙' },
  hobbies: ['手冲咖啡'], skills: { 手冲咖啡: 9 }, values: ['真诚待人'],
  motivation: '把咖啡馆经营成温暖的公共空间。',
  personality: { extraversion: .7, empathy: .9, honesty: .8, curiosity: .6, patience: .7 },
  x: 3, y: 3, locationId: 'obj:bed_lin', locationName: '床', verb: '睡觉', thought: '按作息休息。',
  actionType: 'interact', targetId: 'obj:bed_lin', targetName: '床', path: [], spriteIndex: 4, background: '小镇居民。',
} as unknown as AgentView;

test('旧版居民快照补齐头像、研究档案与初始心态', () => {
  const normalized = normalizeAgentView(legacyAgent, 0);
  assert.equal(normalized.avatar.sprite, 4);
  assert.match(normalized.avatar.hair, /^#[0-9a-f]{6}$/);
  assert.deepEqual(normalized.traits, []);
  assert.deepEqual(normalized.goals, ['把咖啡馆经营成温暖的公共空间。']);
  assert.match(normalized.speechStyle, /回应事实/);
  assert.equal(normalized.initialState.startingLocationId, 'obj:bed_lin');
  assert.equal(normalized.initialState.energy, .7);
});

test('完整新版字段保持语义，居民数组按顺序确定头像槽位', () => {
  const modern = {
    ...legacyAgent,
    traits: ['温和'], goals: ['完成小说'], speechStyle: '语气温和',
    avatar: { sprite: 2, hair: '#ABCDEF', skin: '#fedcba', outfit: '#112233', accent: '#445566', accessory: 'beret' },
    initialState: { valence: .2, energy: .8, stress: .1, socialNeed: .6, occupationalFocus: .9, startingLocationId: 'obj:cafe' },
  } as AgentView;
  const [normalized] = normalizeAgentViews([modern]);
  assert.deepEqual(normalized.traits, ['温和']);
  assert.deepEqual(normalized.goals, ['完成小说']);
  assert.equal(normalized.avatar.hair, '#abcdef');
  assert.equal(normalized.avatar.accessory, 'beret');
  assert.equal(normalized.initialState.startingLocationId, 'obj:cafe');
});

test('头像渲染对缺失和非法输入保持可用且转义名称', () => {
  assert.doesNotThrow(() => normalizePixelAvatar(undefined, 7));
  const markup = pixelAvatarMarkup('林<晚晴', undefined, 'roster-avatar');
  assert.match(markup, /data-sprite="0"/);
  assert.match(markup, /林&lt;晚晴的像素头像/);
  assert.doesNotMatch(markup, /undefined/);
});
