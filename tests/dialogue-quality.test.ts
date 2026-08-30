import test from 'node:test';
import assert from 'node:assert/strict';
import { assessDialogueTurn, conservativeDialogueReply } from '../src/engine/dialogue-quality';

const base = {
  latestPrompt: '最近在读什么书？',
  priorTurns: ['最近在读什么书？'],
  evidence: ['最近没有在读书，主要精力都放在画展作品。'],
  speakerName: '沈屿',
  otherName: '陈默',
  knownResidentNames: ['沈屿', '陈默', '周岚'],
};

test('直接回答且受证据支持的台词通过质量门', () => {
  const result = assessDialogueTurn({ ...base, utterance: '最近没有在读书，我主要在准备画展。' });
  assert.deepEqual(result, { ok: true, reasons: [] });
});

test('机械复述、问题回避和本轮重复均被拒绝', () => {
  const formula = assessDialogueTurn({ ...base, utterance: '我认真想了想，你刚才提到最近在读什么书。' });
  assert.equal(formula.ok, false);
  assert.ok(formula.reasons.some((reason) => reason.includes('机械')));
  const greeting = assessDialogueTurn({ ...base, utterance: '早啊！今天也要加油。' });
  assert.equal(greeting.ok, false);
  const repeat = assessDialogueTurn({ ...base, priorTurns: ['最近没有在读书，我主要在准备画展。'], utterance: '最近没有在读书，我主要在准备画展。' });
  assert.equal(repeat.ok, false);
});

test('无证据的第三方居民和作品名不能进入正式台词', () => {
  const resident = assessDialogueTurn({
    ...base,
    latestPrompt: '今天送信路上遇到什么事？',
    evidence: ['发现一封信写着旧地址，后来在广场找到了收信人并核对姓名。'],
    utterance: '送信时发现旧地址，后来确认收信人是周岚。',
  });
  assert.equal(resident.ok, false);
  assert.ok(resident.reasons.some((reason) => reason.includes('周岚')));
  const book = assessDialogueTurn({ ...base, evidence: [], utterance: '最近在读《乡土中国》。' });
  assert.equal(book.ok, false);
  assert.ok(book.reasons.some((reason) => reason.includes('乡土中国')));
  const inventedRecipient = assessDialogueTurn({
    ...base,
    latestPrompt: '今天送信路上遇到什么事？',
    evidence: ['发现一封信写着旧地址，后来在广场找到了收信人并核对姓名。'],
    utterance: '送信时发现旧地址，收信人是老李家。',
  });
  assert.equal(inventedRecipient.ok, false);
  assert.ok(inventedRecipient.reasons.some((reason) => reason.includes('无证据身份')));
  const inventedAnecdote = assessDialogueTurn({
    ...base,
    latestPrompt: '你怎么看年轻人总是匆匆忙忙？',
    evidence: ['傍晚在广场看见两个年轻人匆忙赶路。'],
    utterance: '我见过老张走得很慢，他比谁都踏实。',
  });
  assert.equal(inventedAnecdote.ok, false);
  assert.ok(inventedAnecdote.reasons.some((reason) => reason.includes('老张')));
});

test('保守回答按问题类型回应且不引入新事实', () => {
  assert.match(conservativeDialogueReply('最近在读什么书？'), /没有.*阅读记录/);
  assert.match(conservativeDialogueReply('收信人是谁？'), /不能确认.*谁/);
  assert.match(conservativeDialogueReply('你怎么看这件事？'), /判断/);
  assert.equal(
    conservativeDialogueReply('今天送信遇到了什么？', ['送信时发现一封信写着旧地址。']),
    '我能确认的是：送信时发现一封信写着旧地址。',
  );
});

test('问题可通过已知证据桥接到不复述问题词面的直接答案', () => {
  const result = assessDialogueTurn({
    ...base,
    latestPrompt: '今天送信路上遇到什么值得留意的事？',
    evidence: ['今天送信时发现一封信写着旧地址，后来在广场找到了收信人。'],
    utterance: '有一封信写着旧地址，我后来在广场找到了收信人。',
  });
  assert.equal(result.ok, true);
});
