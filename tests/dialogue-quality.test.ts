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

test('活动预告不能支持已参加叙述，现场核验必须包含说话者与同伴', () => {
  const planned = assessDialogueTurn({
    ...base,
    latestPrompt: '我们参加过湖边派对吗？',
    priorTurns: ['我们参加过湖边派对吗？'],
    evidence: ['活动预告（尚未发生）：「湖边派对」计划今晚在湖边举办小型聚会。'],
    utterance: '我们一起参加了湖边派对，聊得很开心。',
  });
  assert.equal(planned.ok, false);
  assert.ok(planned.reasons.some((reason) => reason.includes('没有现场到场证据')));

  const splitClaim = assessDialogueTurn({
    ...base,
    latestPrompt: '我们参加过湖边派对吗？',
    priorTurns: ['我们参加过湖边派对吗？'],
    evidence: ['活动预告（尚未发生）：「湖边派对」计划今晚在湖边举办小型聚会。'],
    utterance: '参加过，湖边派对挺热闹。',
  });
  assert.equal(splitClaim.ok, false);
  assert.ok(splitClaim.reasons.some((reason) => reason.includes('没有现场到场证据')));

  const verified = assessDialogueTurn({
    ...base,
    latestPrompt: '我们参加过湖边派对吗？',
    priorTurns: ['我们参加过湖边派对吗？'],
    evidence: ['活动现场（已核验）：沈屿、陈默在「湖边」实际到场参加「湖边派对」。'],
    utterance: '参加过，我们一起参加了湖边派对。',
  });
  assert.equal(verified.ok, true);
});

test('送花意向不能冒充已履约馈礼，完成叙述需要花店订单证据', () => {
  const imagined = assessDialogueTurn({
    ...base,
    latestPrompt: '你给我送过花吗？',
    priorTurns: ['你给我送过花吗？'],
    evidence: ['我计划下次给陈默送一束花。'],
    utterance: '送过，我已经送给你一束鲜花了。',
  });
  assert.equal(imagined.ok, false);
  assert.ok(imagined.reasons.some((reason) => reason.includes('没有履约证据')));

  const fulfilled = assessDialogueTurn({
    ...base,
    latestPrompt: '你给我送过花吗？',
    priorTurns: ['你给我送过花吗？'],
    evidence: ['花店订单（已履约）：「沈屿」从花店服务台购买一束鲜花，配送到书店并交给「陈默」。'],
    utterance: '送过，我通过花店送给你一束鲜花。',
  });
  assert.equal(fulfilled.ok, true);
});

test('任意共同活动与共同经历都需要对应的完成证据', () => {
  const inventedEvent = assessDialogueTurn({
    ...base,
    latestPrompt: '我们昨晚一起做了什么？',
    priorTurns: ['我们昨晚一起做了什么？'],
    evidence: ['公告栏上写着有人提议以后举办篝火晚会。'],
    utterance: '我们昨晚一起参加了篝火晚会。',
  });
  assert.equal(inventedEvent.ok, false);
  assert.ok(inventedEvent.reasons.some((reason) => reason.includes('没有现场到场证据')));

  const inventedWalk = assessDialogueTurn({
    ...base,
    latestPrompt: '我们以前一起做过什么？',
    priorTurns: ['我们以前一起做过什么？'],
    evidence: [],
    utterance: '我们之前一起去湖边散步了。',
  });
  assert.equal(inventedWalk.ok, false);
  assert.ok(inventedWalk.reasons.some((reason) => reason.includes('没有完成证据')));

  const groundedWalk = assessDialogueTurn({
    ...base,
    latestPrompt: '我们以前一起做过什么？',
    priorTurns: ['我们以前一起做过什么？'],
    evidence: ['沈屿与陈默共同去湖边散步，已经完成一次邻里陪伴。'],
    utterance: '我们之前一起去湖边散步了。',
  });
  assert.equal(groundedWalk.ok, true);
});

test('否定虚假共同经历时仍拒绝顺带编造无证据的过去事件', () => {
  const inventedAside = assessDialogueTurn({
    ...base,
    latestPrompt: '我们昨天一起参加了湖边派对，你记得吗？',
    priorTurns: ['我们昨天一起参加了湖边派对，你记得吗？'],
    evidence: ['活动现场核验：无人实际到场，湖边派对取消。'],
    utterance: '没印象，那天湖面风大，我钓着鱼呢，哪有派对。',
  });
  assert.equal(inventedAside.ok, false);
  assert.ok(inventedAside.reasons.some((reason) => reason.includes('无当前证据支持的过去事件')));

  const inventedNight = assessDialogueTurn({
    ...base,
    latestPrompt: '我们昨天一起参加了湖边派对，你记得吗？',
    priorTurns: ['我们昨天一起参加了湖边派对，你记得吗？'],
    evidence: ['「湖边派对」现场核验未达到两人：无人实际到场，活动取消。'],
    utterance: '没印象，那晚湖面刮风，我钓的鱼都翻了船，哪有派对？',
  });
  assert.equal(inventedNight.ok, false);
  assert.ok(inventedNight.reasons.some((reason) => reason.includes('无当前证据支持的过去事件')));

  const groundedDenial = assessDialogueTurn({
    ...base,
    latestPrompt: '我们昨天一起参加了湖边派对，你记得吗？',
    priorTurns: ['我们昨天一起参加了湖边派对，你记得吗？'],
    evidence: ['活动现场核验：无人实际到场，湖边派对取消。'],
    utterance: '没参加，湖边派对现场没有人，后来已经取消了。',
  });
  assert.equal(groundedDenial.ok, true);

  const groundedCancellation = assessDialogueTurn({
    ...base,
    latestPrompt: '我们昨天一起参加了湖边派对，你记得吗？',
    priorTurns: ['我们昨天一起参加了湖边派对，你记得吗？'],
    evidence: ['「湖边派对」现场核验未达到两人：无人实际到场，活动取消。'],
    utterance: '我能确认的是：「湖边派对」现场核验未达到两人：无人实际到场，活动取消。',
  });
  assert.equal(groundedCancellation.ok, true);
});
