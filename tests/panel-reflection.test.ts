import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReflectionCards, type ReflectionView } from '../src/web/client/panel';

test('结构化反思日记呈现种类、日期、心态、信念、修订、指引与证据数量', () => {
  const reflections: ReflectionView[] = [{
    kind: 'daily',
    day: 3,
    diary: '今天我重新理解了咖啡馆里的合作。',
    insights: ['我会更主动地确认伙伴感受。'],
    evidenceIds: ['e1', 'e2', 'e3'],
    mindState: {
      valence: .4, energy: .7, stress: .2, socialNeed: .6, occupationalFocus: .8,
      summary: '情绪平稳，职业专注较高。',
    },
    beliefs: [{ statement: '稳定回应会强化信任。', confidence: .82, evidenceIds: ['e1', 'e2'], status: 'reinforced' }],
    revisions: [{ previous: '独自完成更高效。', revised: '合作在高峰期更稳妥。', reason: '新互动改变了判断。', evidenceIds: ['e3'] }],
    guidance: ['明天开店前先和伙伴确认分工。'],
  }];
  const html = renderReflectionCards(reflections);
  for (const expected of ['每日复盘', '第 3 天', '证据 3 条', '第一人称日记', '心态截面', '信念更新', '认知修订', '后续行为指引', '洞察']) {
    assert.ok(html.includes(expected), expected);
  }
  assert.ok(html.includes('置信 0.82'));
  assert.ok(html.includes('width:70%'));
});

test('旧版仅 insights 的反思仍可呈现，模型文本全部安全转义', () => {
  const attack = '<img src=x onerror="alert(1)">';
  const html = renderReflectionCards([{
    insights: [attack],
    diary: attack,
    mindState: { valence: Number.POSITIVE_INFINITY, energy: -5, stress: 8, summary: attack },
    beliefs: [{ statement: attack, confidence: Number.NaN, supersedes: attack }],
    revisions: [{ previous: attack, revised: attack, reason: attack }],
    guidance: [attack],
    evidenceIds: [],
  }]);
  assert.ok(html.includes('历史反思'));
  assert.ok(html.includes('日期未记录'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('Infinity'));
  assert.match(html, /width:(?:0|50|100)%/);
});

test('空反思列表保持明确空状态', () => {
  assert.equal(renderReflectionCards([]), '<p class="label">暂无反思</p>');
});
