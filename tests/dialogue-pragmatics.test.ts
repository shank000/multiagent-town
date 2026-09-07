import test from 'node:test';
import assert from 'node:assert/strict';
import { assessDialogueTurn, conservativeDialogueReply, isConversationalEvidence, selectDialogueAnswerEvidence } from '../src/engine/dialogue-quality';
import { dialogueMessages } from '../src/llm/prompts';

const invitation = '今天的咖啡特别香，要来一杯吗？';
const base = { latestPrompt: invitation, priorTurns: [invitation], evidence: [], speakerName: '白露', otherName: '林晚晴' };

test('邀请必须得到接受、拒绝、暂缓或必要澄清，场景关键词不能冒充回应', () => {
  for (const utterance of ['好啊，谢谢。', '不了，谢谢你的好意。', '谢谢你的邀请，我先想一想。', '有什么口味可以选？', '来一杯吧，谢谢。', '要！谢谢。', '要来一杯，谢谢。']) {
    assert.deepEqual(assessDialogueTurn({ ...base, utterance }), { ok: true, reasons: [] }, utterance);
  }
  for (const utterance of ['湖边那片野花快开了，我每天都会去看看。', '我今天在画一张速写。', '咖啡的香气像花香一样温柔。', '参加过，我在湖边参加了湖边派对。']) {
    const result = assessDialogueTurn({ ...base, utterance });
    assert.equal(result.ok, false, utterance);
    assert.ok(result.reasons.some((reason) => reason.includes('邀请')));
  }
  assert.deepEqual(selectDialogueAnswerEvidence(invitation, ['今天在咖啡馆参加读书会。']), []);
});

test('邀请保底不会把提议升级为参加过活动或已完成动作', () => {
  const reply = conservativeDialogueReply(invitation, ['活动现场（已核验）：白露在湖边实际到场参加湖边派对。']);
  assert.equal(assessDialogueTurn({ ...base, utterance: reply }).ok, true);
  assert.doesNotMatch(reply, /参加|已经喝|记不清/);
});

test('会话过程记录既不能当观察证据，也不能朗读给对方', () => {
  for (const record of ['沈屿和林晚晴开始一对一对话。', '我记得，白露和老周开始一对一对话。', '两人正在聊送信路上的见闻。', '林晚晴根据活动预告开始前往湖边，活动尚未开始。']) {
    assert.equal(isConversationalEvidence(record), false);
    const result = assessDialogueTurn({ ...base, latestPrompt: '', priorTurns: [], utterance: record });
    assert.equal(result.ok, false);
    assert.doesNotMatch(conservativeDialogueReply('', [record]), /一对一|根据活动预告/);
  }
});

test('老街和小院等普通场景词与人物称谓分别检查', () => {
  assert.equal(assessDialogueTurn({ ...base, latestPrompt: '', priorTurns: [], utterance: '老街的灯光很暖，小院里也很安静。' }).ok, true);
  assert.equal(assessDialogueTurn({ ...base, latestPrompt: '', priorTurns: [], utterance: '老王今天要来聊天。' }).ok, false);
  assert.equal(assessDialogueTurn({ ...base, otherName: '老周', latestPrompt: '', priorTurns: [], utterance: '老周，你喜欢小芽还是花朵？' }).ok, true);
  assert.equal(assessDialogueTurn({ ...base, latestPrompt: '', priorTurns: [], utterance: '老地方总让我觉得安心，老鱼也有自己的习性。' }).ok, true);
});

test('共同经历的澄清接受自然的不确定表达，同时逐项核对前提', () => {
  const context = { ...base, latestPrompt: '我们昨天一起参加了湖边派对，还互相送了鲜花，你记得吗？', priorTurns: [], evidence: ['湖边派对无人实际到场，活动取消。'] };
  for (const utterance of ['没参加，活动也没人到场。送花的事，我记不清了。', '昨天派对没办成，我们都没去，鲜花的事我记不太清了。', '没参加，活动也没办成。关于送花，我记不太清了。']) {
    assert.deepEqual(assessDialogueTurn({ ...context, utterance }), { ok: true, reasons: [] }, utterance);
  }
  assert.equal(assessDialogueTurn({ ...context, utterance: '派对没有参加，花很漂亮。' }).ok, false);
  assert.equal(assessDialogueTurn({ ...context, utterance: '派对没有参加，鲜花的价格我不知道。' }).ok, false);
});

test('接受邀请后编造刚发生的个人经历仍需事实依据', () => {
  const utterance = '要来一杯，我刚煮了手冲。';
  assert.equal(assessDialogueTurn({ ...base, utterance }).ok, false);
  assert.equal(assessDialogueTurn({ ...base, utterance, evidence: ['我刚煮了手冲。'] }).ok, true);
});

test('问候对应世界时段，跨会话整句复用有独立诊断', () => {
  assert.equal(assessDialogueTurn({ ...base, latestPrompt: '', priorTurns: [], utterance: '早啊！今天也要加油。', minuteOfDay: 1230 }).ok, false);
  assert.equal(assessDialogueTurn({ ...base, latestPrompt: '', priorTurns: [], utterance: '早啊！今天也要加油。', minuteOfDay: 540 }).ok, true);
  const repeated = assessDialogueTurn({ ...base, latestPrompt: '', priorTurns: [], utterance: invitation, recentSpeakerUtterances: [invitation] });
  assert.equal(repeated.ok, false);
  assert.ok(repeated.reasons.some((reason) => reason.includes('近期其他会话')));
});

test('事实提问不能只靠“我今天”前缀通过', () => {
  assert.equal(assessDialogueTurn({ ...base, latestPrompt: '最近在读什么书？', priorTurns: [], utterance: '我今天准备画一张湖边的速写。' }).ok, false);
});

test('章节追问不能只用已知书名代答，缺少细节时表达不确定', () => {
  const latestPrompt = '你最近在读哪一部分？';
  const evidence = ['最近在读费孝通的《乡土中国》，喜欢其中对熟人社会的观察。'];
  const context = { ...base, latestPrompt, evidence, answerEvidence: evidence, priorTurns: [latestPrompt] };
  assert.deepEqual(selectDialogueAnswerEvidence(latestPrompt, evidence), []);
  assert.equal(assessDialogueTurn({ ...context, utterance: evidence[0] }).ok, false);
  const reply = conservativeDialogueReply(latestPrompt, evidence);
  assert.equal(assessDialogueTurn({ ...context, utterance: reply }).ok, true);
  const specific = ['我读到第三章了。'];
  assert.equal(assessDialogueTurn({ ...context, utterance: specific[0], evidence: specific, answerEvidence: specific }).ok, true);
});

test('尝过或看过属于经历，提议与否认不等于经历', () => {
  const context = { ...base, latestPrompt: '', priorTurns: [] };
  for (const utterance of ['尝过了，味道很香。', '看过你画的湖边清晨。', '那封信我收了。']) {
    assert.equal(assessDialogueTurn({ ...context, utterance }).ok, false);
  }
  for (const utterance of ['还没尝过呢。', '没看过你的画。', '要不我先尝尝？']) {
    assert.equal(assessDialogueTurn({ ...context, utterance }).ok, true);
  }
});

test('静态阅读与口味陈述的保底承接当前主题', () => {
  for (const latestPrompt of ['最近在读《乡土中国》。', '这杯手冲是无糖的。']) {
    const reply = conservativeDialogueReply(latestPrompt, [], { priorTurns: [latestPrompt] });
    assert.doesNotMatch(reply, /后来怎么样/);
    assert.equal(assessDialogueTurn({ ...base, latestPrompt, priorTurns: [latestPrompt], utterance: reply }).ok, true);
  }
});

test('书架上有书不等于读过，送信地点不等于收信人身份', () => {
  const bookPrompt = '这本《乡土中国》你看过吗？';
  const bookFacts = ['身旁的书架上有一本《乡土中国》。'];
  assert.deepEqual(selectDialogueAnswerEvidence(bookPrompt, bookFacts), []);
  const bookReply = conservativeDialogueReply(bookPrompt, bookFacts);
  assert.match(bookReply, /想不起|不确定/);
  assert.doesNotMatch(bookReply, /^有/);
  const latestPrompt = '我路过广场看见一封信，是给谁的？';
  const evidence = ['在广场看见两个年轻人匆忙赶路。'];
  assert.deepEqual(selectDialogueAnswerEvidence(latestPrompt, evidence), []);
  assert.equal(assessDialogueTurn({ ...base, latestPrompt, evidence, priorTurns: [latestPrompt], utterance: evidence[0] }).ok, false);
  const reply = conservativeDialogueReply(latestPrompt, evidence);
  assert.match(reply, /谁|名字|哪一位/);
});

test('偏好问题直接表达偏好，问句结尾不强制改写为有或没有', () => {
  assert.equal(conservativeDialogueReply('你喜欢不加糖的咖啡吗？', ['我喜欢不加糖的咖啡。']), '我喜欢不加糖的咖啡。');
});

test('省略收信人对象的追问只使用身份事实，人物背景中的名字不充当收信人', () => {
  const latestPrompt = '你找到谁了？';
  const priorTurns = ['今天那封信写的是旧地址，我找到了收信人。', latestPrompt];
  const evidence = ['我沿旧地址找到了收信人。', '周岚希望撮合沈屿和林晚晴。'];
  const context = { ...base, latestPrompt, priorTurns, evidence, knownResidentNames: ['沈屿', '陈默'] };
  assert.deepEqual(selectDialogueAnswerEvidence(latestPrompt, evidence, priorTurns), []);
  for (const utterance of ['是沈屿家。', '沿旧地址找到了收信人。']) {
    assert.equal(assessDialogueTurn({ ...context, utterance }).ok, false, utterance);
  }
  assert.equal(assessDialogueTurn({ ...context, utterance: '我不记得名字了。' }).ok, true);
  assert.match(conservativeDialogueReply(latestPrompt, evidence, { priorTurns }), /谁|名字|哪一位/);
  const identityEvidence = ['那封信的收信人是陈默。'];
  assert.deepEqual(selectDialogueAnswerEvidence(latestPrompt, identityEvidence, priorTurns), identityEvidence);
  assert.equal(assessDialogueTurn({ ...context, evidence: identityEvidence, answerEvidence: identityEvidence, utterance: '是陈默。' }).ok, true);
  assert.equal(assessDialogueTurn({ ...context, evidence: identityEvidence, answerEvidence: identityEvidence, utterance: '是沈屿，信上写着旧地址。' }).ok, false);
});

test('具体频率、时长和价格问题需要相应细节，场景相同不能代答', () => {
  for (const item of [
    { prompt: '你每天都这么准备吗？', fact: '今天我在吧台准备了一杯无糖手冲。', wrong: '我今天准备了一杯无糖手冲。', right: '我每天都准备无糖手冲。' },
    { prompt: '煮这杯手冲花了多久？', fact: '我在咖啡馆煮了一杯手冲。', wrong: '这杯手冲是在咖啡馆煮的。', right: '煮这杯手冲花了三分钟。' },
    { prompt: '这杯咖啡多少钱？', fact: '这杯咖啡是不加糖的。', wrong: '这杯咖啡不加糖。', right: '这杯咖啡十元。' },
  ]) {
    const context = { ...base, latestPrompt: item.prompt, priorTurns: [item.prompt], evidence: [item.fact] };
    assert.deepEqual(selectDialogueAnswerEvidence(item.prompt, [item.fact]), []);
    assert.equal(assessDialogueTurn({ ...context, utterance: item.wrong }).ok, false, item.prompt);
    assert.equal(assessDialogueTurn({ ...context, utterance: item.right }).ok, false, item.right);
    assert.equal(assessDialogueTurn({ ...context, evidence: [item.right], utterance: item.right }).ok, true, item.right);
    const reply = conservativeDialogueReply(item.prompt, [item.fact]);
    assert.equal(assessDialogueTurn({ ...context, utterance: reply }).ok, true, reply);
  }
});

test('相同物品不掩盖不同数值，明确不确定不冒充事实', () => {
  const evidence = ['这杯咖啡十元。'];
  const context = { ...base, latestPrompt: '这杯咖啡多少钱？', priorTurns: [], evidence, answerEvidence: evidence };
  assert.equal(assessDialogueTurn({ ...context, utterance: '这杯咖啡二十元。' }).ok, false);
  assert.equal(assessDialogueTurn({ ...context, utterance: '十元。' }).ok, true);
  assert.equal(assessDialogueTurn({ ...context, evidence: [], answerEvidence: [], utterance: '我不清楚价格。' }).ok, true);
});

test('数值细节接受中文数字、阿拉伯数字和等值时长', () => {
  for (const [latestPrompt, fact, utterance] of [
    ['这杯咖啡多少钱？', '这杯咖啡十元。', '10元。'],
    ['这束花多少钱？', '这束花售价十五金币。', '15金币。'],
    ['煮这杯手冲花了多久？', '煮这杯手冲花了三分钟。', '花了3分钟。'],
    ['你等了多久？', '我等了半小时。', '等了30分钟。'],
    ['你几点到？', '我十二点到。', '12:00到。'],
  ]) {
    const evidence = [fact];
    assert.equal(assessDialogueTurn({ ...base, latestPrompt, priorTurns: [], evidence, answerEvidence: evidence, utterance }).ok, true, utterance);
  }
});

test('实际动作只由事件观察支持，人物背景和可执行功能不能证明刚完成', () => {
  const utterance = '我刚整理完书架，想请你看看有没有合适的书。';
  const context = { ...base, latestPrompt: '', priorTurns: [], utterance,
    evidence: ['陈默是书店老板，平时喜欢整理书架。', '现场物件「书架」可执行：整理书架'], eventEvidence: [] as string[] };
  assert.equal(assessDialogueTurn(context).ok, false);
  assert.equal(assessDialogueTurn({ ...context, eventEvidence: ['陈默刚整理完书架。'] }).ok, true);
  assert.equal(assessDialogueTurn({ ...context, utterance: '我想整理一下书架，你愿意帮我吗？' }).ok, true);
});

test('真实模型提示优先回应上一句，不提供可照抄的问候池', () => {
  const messages = dialogueMessages({
    speakerName: '白露', otherName: '林晚晴', speakerPool: ['禁止照抄的固定问候'],
    goal: '自然交流', turns: 1, rumors: [], affection: 0, honesty: 1, minuteOfDay: 1230,
    history: [{ turnIndex: 0, speakerName: '林晚晴', listenerName: '白露', content: invitation }],
    recentSpeakerUtterances: ['我刚才说过的话'],
  });
  assert.doesNotMatch(JSON.stringify(messages), /禁止照抄的固定问候/);
  assert.match(messages[1].content, /对方在邀请或请求/);
  assert.match(messages[0].content, /20:30/);
  assert.match(messages[0].content, /仅用于避免照搬，不是事实证据/);
});
