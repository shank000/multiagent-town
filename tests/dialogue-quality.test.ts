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

test('首轮可以自然开场，后续台词必须语用承接并推进上一句', () => {
  const opening = assessDialogueTurn({
    ...base,
    latestPrompt: '',
    priorTurns: [],
    evidence: [],
    utterance: '早上好，今天店里还顺利吗？',
  });
  assert.equal(opening.ok, true);

  const advancement = assessDialogueTurn({
    ...base,
    latestPrompt: '我最近在准备画展，那幅雨天街道还没收尾。',
    priorTurns: ['最近在忙什么？', '我最近在准备画展，那幅雨天街道还没收尾。'],
    evidence: [],
    utterance: '雨天街道的光线确实难处理，你准备先调整哪一处？',
  });
  assert.equal(advancement.ok, true);

  const acknowledgement = assessDialogueTurn({
    ...base,
    latestPrompt: '今天事情很多，我有些累。',
    priorTurns: ['今天事情很多，我有些累。'],
    evidence: [],
    utterance: '听起来很辛苦，你先休息一会儿吧。',
  });
  assert.equal(acknowledgement.ok, true);

  const topicJump = assessDialogueTurn({
    ...base,
    latestPrompt: '我最近在准备画展，那幅雨天街道还没收尾。',
    priorTurns: ['我最近在准备画展，那幅雨天街道还没收尾。'],
    evidence: [],
    utterance: '湖边的咖啡香像夏天一样温柔。',
  });
  assert.equal(topicJump.ok, false);
  assert.ok(topicJump.reasons.some((reason) => reason.includes('语用承接')));

  const sharedFillerOnly = assessDialogueTurn({
    ...base,
    latestPrompt: '最近在整理书架，把放错位置的书放回去了。',
    priorTurns: ['最近在整理书架，把放错位置的书放回去了。'],
    evidence: ['最近在画小镇的咖啡馆。'],
    utterance: '我最近在画小镇的咖啡馆，阳光像柠檬黄。',
  });
  assert.equal(sharedFillerOnly.ok, false);
  assert.ok(sharedFillerOnly.reasons.some((reason) => reason.includes('语用承接')));

  const personaBridgeOnly = assessDialogueTurn({
    ...base,
    latestPrompt: '这本书谈到人与土地，也让我想到我们的小镇。',
    priorTurns: ['这本书谈到人与土地，也让我想到我们的小镇。'],
    evidence: ['人物背景：画家每天在小镇咖啡馆为林晚晴画速写。'],
    utterance: '我画的是林晚晴擦杯子的样子，阳光是柠檬黄。',
  });
  assert.equal(personaBridgeOnly.ok, false);
  assert.ok(personaBridgeOnly.reasons.some((reason) => reason.includes('语用承接')));
});

test('连续替换意象的隐喻循环与主题词近义复写被拒绝', () => {
  const turns = [
    '那缕花香落进咖啡杯里，像夏天留下的一点温柔。',
    '那缕花香落在湖边的风里，像夏天留下的一点温柔。',
  ];
  const loop = assessDialogueTurn({
    ...base,
    latestPrompt: turns[1],
    priorTurns: turns,
    evidence: [],
    utterance: '那缕花香飘进咖啡馆，像夏天的温柔又回来了。',
  });
  assert.equal(loop.ok, false);
  assert.ok(loop.reasons.some((reason) => reason.includes('高度重复')));

  const paraphrase = assessDialogueTurn({
    ...base,
    latestPrompt: '花香、咖啡和夏日的暖意让人舍不得离开。',
    priorTurns: ['咖啡杯边的花香，有一种夏天般的温柔。', '花香、咖啡和夏日的暖意让人舍不得离开。'],
    evidence: [],
    utterance: '温柔的夏天藏在咖啡和花香里。',
  });
  assert.equal(paraphrase.ok, false);
  assert.ok(paraphrase.reasons.some((reason) => reason.includes('高度重复')));

  const repeatedBookPlacement = assessDialogueTurn({
    ...base,
    latestPrompt: '书放回原位，就像把一段安静的时光重新摆正了。',
    priorTurns: [
      '最近在整理书架，发现《乡土中国》被放到了小说区，就把它放回了社会学书架。',
      '书放回原位，就像把一段安静的时光重新摆正了。',
    ],
    evidence: ['今天把《乡土中国》放回社会学书架。'],
    utterance: '那本《乡土中国》确实该在社会学区，我刚放回去了。',
  });
  assert.equal(repeatedBookPlacement.ok, false);
  assert.ok(repeatedBookPlacement.reasons.some((reason) => reason.includes('重复')));

  const repeatedPaintingImage = assessDialogueTurn({
    ...base,
    latestPrompt: '那本书确实该放在社会学区。',
    priorTurns: [
      '我最近在画林晚晴在咖啡馆擦杯子的样子，阳光正好是柠檬黄。',
      '那本书确实该放在社会学区。',
    ],
    evidence: ['人物背景：画家计划画林晚晴在吧台后擦杯子的样子，常用柠檬黄表现阳光。'],
    utterance: '我画的是她擦杯子的样子，吧台上的阳光还是柠檬黄。',
  });
  assert.equal(repeatedPaintingImage.ok, false);
  assert.ok(repeatedPaintingImage.reasons.some((reason) => reason.includes('重复')));
});

test('第四句起缺少新贡献时必须收束，不能用短回应继续空转', () => {
  const context = {
    ...base,
    latestPrompt: '雨天街道的光线确实很难处理。',
    priorTurns: ['最近在忙什么？', '我在准备雨天街道的画。', '雨天街道的光线确实很难处理。'],
    evidence: [],
    utterance: '我明白了。',
  };
  const stalled = assessDialogueTurn({ ...context, endDialogue: false });
  assert.equal(stalled.ok, false);
  assert.ok(stalled.reasons.some((reason) => reason.includes('会话后半段')));

  const closing = assessDialogueTurn({ ...context, endDialogue: true });
  assert.equal(closing.ok, true);
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

test('已知书名不能支持模型扩写书中观点，作品内容需要独立证据', () => {
  const inventedContent = assessDialogueTurn({
    ...base,
    latestPrompt: '最近在读《乡土中国》，刚把它放回了对的位置。',
    priorTurns: ['最近在读《乡土中国》，刚把它放回了对的位置。'],
    evidence: ['今天把《乡土中国》放回社会学书架。'],
    utterance: '《乡土中国》里说，人和土地是互相看见的。',
  });
  assert.equal(inventedContent.ok, false);
  assert.ok(inventedContent.reasons.some((reason) => reason.includes('作品内容')));

  const groundedContent = assessDialogueTurn({
    ...base,
    latestPrompt: '最近在读《乡土中国》，刚把它放回了对的位置。',
    priorTurns: ['最近在读《乡土中国》，刚把它放回了对的位置。'],
    evidence: ['读书笔记写着：《乡土中国》中讨论了熟人社会的差序格局。'],
    utterance: '《乡土中国》中讨论了熟人社会的差序格局。',
  });
  assert.equal(groundedContent.ok, true, groundedContent.reasons.join('；'));
});

test('对方提到书名不等于当前说话者读过，个人阅读经历需要自身证据', () => {
  const unsupported = assessDialogueTurn({
    ...base,
    latestPrompt: '最近在读《乡土中国》，刚把它放回了对的位置。',
    priorTurns: ['最近在读《乡土中国》，刚把它放回了对的位置。'],
    evidence: ['今天上午在公园画雨后的长椅，没有读书。'],
    utterance: '《乡土中国》我看过，书里说小镇生活很安静。',
  });
  assert.equal(unsupported.ok, false);
  assert.ok(unsupported.reasons.some((reason) => reason.includes('阅读经历')));
  assert.ok(unsupported.reasons.some((reason) => reason.includes('作品内容')));

  const supported = assessDialogueTurn({
    ...base,
    latestPrompt: '最近在读《乡土中国》，刚把它放回了对的位置。',
    priorTurns: ['最近在读《乡土中国》，刚把它放回了对的位置。'],
    evidence: ['上个月读过《乡土中国》，读书笔记记下了书中对熟人社会的讨论。'],
    utterance: '《乡土中国》我读过，书中讨论了熟人社会。',
  });
  assert.equal(supported.ok, true, supported.reasons.join('；'));

  const honestDenial = assessDialogueTurn({
    ...base,
    latestPrompt: '最近在读《乡土中国》，刚把它放回了对的位置。',
    priorTurns: ['最近在读《乡土中国》，刚把它放回了对的位置。'],
    evidence: [],
    utterance: '《乡土中国》我没读过，你觉得哪部分最有意思？',
  });
  assert.equal(honestDenial.ok, true, honestDenial.reasons.join('；'));

  const unsupportedPartialReading = assessDialogueTurn({
    ...base,
    latestPrompt: '刚把《乡土中国》放回了书架。',
    priorTurns: ['刚把《乡土中国》放回了书架。'],
    evidence: ['今天只是整理书架，把《乡土中国》放回原位。'],
    utterance: '最近在读《乡土中国》，只是翻了翻，还没读完。',
  });
  assert.equal(unsupportedPartialReading.ok, false);
  assert.ok(unsupportedPartialReading.reasons.some((reason) => reason.includes('阅读经历')));

  const unsupportedCurrentReading = assessDialogueTurn({
    ...base,
    latestPrompt: '为什么会留意到《乡土中国》？',
    priorTurns: ['为什么会留意到《乡土中国》？'],
    evidence: ['今天只是整理书架，把《乡土中国》放回原位。'],
    utterance: '我最近在看《乡土中国》，书里讲的是人和土地的关系。',
  });
  assert.equal(unsupportedCurrentReading.ok, false);
  assert.ok(unsupportedCurrentReading.reasons.some((reason) => reason.includes('阅读经历')));
  assert.ok(unsupportedCurrentReading.reasons.some((reason) => reason.includes('作品内容')));
});

test('保守回答按问题类型回应且不引入新事实', () => {
  assert.match(conservativeDialogueReply('最近在读什么书？'), /想不起|记不清/);
  assert.match(conservativeDialogueReply('收信人是谁？'), /想不起|记不清/);
  assert.match(conservativeDialogueReply('你怎么看这件事？'), /看法|判断/);
  assert.equal(
    conservativeDialogueReply('今天送信遇到了什么？', ['送信时发现一封信写着旧地址。']),
    '我记得，送信时发现一封信写着旧地址。',
  );
});

test('首轮保底从真实观察发起话题，无观察时使用自然问候', () => {
  const grounded = conservativeDialogueReply('', [
    '第3天日记：我在内部总结关系。',
    '今天上午整理书架，把放错位置的《乡土中国》放回社会学书架。',
  ], { priorTurns: [] });
  assert.match(grounded, /整理书架|乡土中国|社会学书架/);
  assert.match(grounded, /怎么样|最近/);
  assert.doesNotMatch(grounded, /第3天|日记|总结关系|我能确认|依据|记录/);

  const greeting = conservativeDialogueReply('', [], { priorTurns: [] });
  assert.match(greeting, /今天|最近/);
  assert.match(greeting, /[？?]/);
});

test('中段无相关证据时用追问承接陈述，不使用无话题确认句', () => {
  const prompt = '今天上午我把放错位置的书放回了书架。';
  const reply = conservativeDialogueReply(prompt, [], { priorTurns: [prompt] });
  assert.match(reply, /后来|为什么|再说说/);
  assert.match(reply, /[？?]/);
  assert.doesNotMatch(reply, /这件事我先记着|我能确认|依据|记录/);

  const completedPrompt = '我发现书放错了地方，就把它放回了书架。';
  const completedReply = conservativeDialogueReply(completedPrompt, [], { priorTurns: [completedPrompt] });
  assert.match(completedReply, /为什么|感觉|怎么想到/);
  assert.doesNotMatch(completedReply, /后来怎么样/);
});

test('精确承接阅读问题，不引用人设或证据标签', () => {
  const reply = conservativeDialogueReply(
    '最近在读什么书？',
    ['人物背景：沈屿是自由画家，平时喜欢速写。', '记忆记录：最近没有在读书，主要精力都放在画展作品。'],
    { priorTurns: ['最近在读什么书？'] },
  );
  assert.equal(reply, '最近没在读书，我把精力放在画展作品上。');
  assert.doesNotMatch(reply, /人物背景|记忆记录|你刚才提到|围绕我们的话题/);
  assert.doesNotMatch(reply, /《[^》]+》/);
});

test('连续保底轮次保持确定性但不重复同一句', () => {
  const prompt = '最近在读什么书？';
  const first = conservativeDialogueReply(prompt, [], { priorTurns: [prompt] });
  const second = conservativeDialogueReply(prompt, [], { priorTurns: [prompt, first] });
  const repeat = conservativeDialogueReply(prompt, [], { priorTurns: [prompt, first] });
  assert.notEqual(first, second);
  assert.equal(second, repeat);
  assert.match(first, /最近|读/);
  assert.match(second, /最近|读/);
});

test('会话后半段的保底台词自然回应并明确收束', () => {
  const priorTurns = [
    '最近在读《乡土中国》，刚把它放回了对的位置。',
    '我没读过，你为什么把它放在社会学书架？',
    '因为它谈的是人与乡土社会。',
  ];
  const reply = conservativeDialogueReply(priorTurns.at(-1) ?? '', [], { priorTurns });
  assert.match(reply, /明白|听懂|再想想/);
  assert.match(reply, /先聊到这里|改天|下次/);
  assert.doesNotMatch(reply, /我能确认|依据|记录|双方|关系|情感/);

  const groundedButFinished = conservativeDialogueReply(
    priorTurns.at(-1) ?? '',
    ['今天把《乡土中国》放回社会学书架。'],
    { priorTurns },
  );
  assert.match(groundedButFinished, /先聊到这里|改天|下次/);
  assert.doesNotMatch(groundedButFinished, /乡土中国|社会学书架/);
});

test('模型台词中的审计记录与关系元摘要口吻全部被拒绝', () => {
  const badForms = [
    '我能确认的是：第71天19:30，陈默选择了林晚晴一对一交流。',
    '我能确认的是：第76天19:30，白露对林晚晴说：最近还好吗？',
    '双方通过咖啡与画作的隐喻交流，情感渐进升温。',
    '这件事我目前没有足够依据回答，等确认后再告诉你。',
    '嗯，第53天日记：我今天重新理解了这段关系。',
  ];
  for (const utterance of badForms) {
    const result = assessDialogueTurn({
      ...base,
      latestPrompt: '你还记得我们聊过什么吗？',
      priorTurns: ['你还记得我们聊过什么吗？'],
      evidence: [utterance],
      utterance,
    });
    assert.equal(result.ok, false, utterance);
    assert.ok(result.reasons.some((reason) => reason.includes('审计') || reason.includes('元摘要')), utterance);
  }
});

test('日记、计划、选择、事件转录与关系分析不成为保底台词', () => {
  const sources = [
    '第71天日记：最近在读《内部日记书》。',
    '第71天计划：准备阅读《内部计划书》。',
    '选择记录：第71天19:30，陈默选择了林晚晴一对一交流。',
    '事件记录：第71天20:00，沈屿开始阅读《内部事件书》。',
    '对话记录：白露对林晚晴说：我在读《内部转录书》。',
    '关系分析：双方通过画作隐喻交流，情感渐进升温。',
    '第76天19:30，白露对林晚晴说：最近在读《内部原话书》。',
  ];
  const reply = conservativeDialogueReply('最近在读什么书？', sources);
  assert.match(reply, /想不起|记不清/);
  assert.doesNotMatch(reply, /内部|第\d+天|\d{1,2}:\d{2}|记录|依据|证据|确认|双方|情感.*升温/);
});

test('相关现场事实与传闻被自然保留，研究侧来源语法不进入台词', () => {
  const verified = '活动现场（已核验）：沈屿、陈默在「湖边」实际到场参加「湖边派对」。';
  const activityReply = conservativeDialogueReply('我们参加过湖边派对吗？', [verified]);
  assert.match(activityReply, /^参加过，我们/);
  assert.match(activityReply, /湖边派对/);
  assert.doesNotMatch(activityReply, /活动现场|已核验|[「」]|memory|evidence/i);
  assert.equal(assessDialogueTurn({
    ...base,
    latestPrompt: '我们参加过湖边派对吗？',
    priorTurns: ['我们参加过湖边派对吗？'],
    evidence: [verified],
    utterance: activityReply,
  }).ok, true);

  const rumor = '周岚准备下周离开邮局。';
  const rumorReply = conservativeDialogueReply('周岚最近要离开邮局吗？', ['当前实际位置：小镇广场。', rumor], {
    rumorEvidence: [rumor],
  });
  assert.match(rumorReply, /^我听说/);
  assert.match(rumorReply, /周岚.*离开邮局/);
  assert.doesNotMatch(rumorReply, /当前实际位置|系统|ID/);
});

test('功能、预告和他人经历不会被保底回答升级成自己的已完成事实', () => {
  const prompt = '我们参加过湖边派对吗？';
  const capabilityOnly = conservativeDialogueReply(prompt, [
    '小镇功能「湖边服务点」：参加湖边派对（功能存在不代表事件已经发生）',
  ], { speakerName: '沈屿', otherName: '陈默' });
  assert.doesNotMatch(capabilityOnly, /参加过|确实参加|已经参加/);

  const planned = conservativeDialogueReply(prompt, [
    '活动预告（尚未发生）：「湖边派对」计划今晚在湖边举办小型聚会。',
  ], { speakerName: '沈屿', otherName: '陈默' });
  assert.match(planned, /还没有参加|还没发生/);
  assert.doesNotMatch(planned, /活动预告|尚未发生|[「」]/);

  const otherPeople = conservativeDialogueReply(prompt, [
    '活动现场（已核验）：周岚、老周在「湖边」实际到场参加「湖边派对」。',
  ], { speakerName: '沈屿', otherName: '陈默' });
  assert.doesNotMatch(otherPeople, /^参加过|我们确实|我们在/);

  const otherGift = conservativeDialogueReply('你给我送过花吗？', [
    '花店订单（已履约）：周岚购买一束鲜花并交给老周。',
  ], { speakerName: '沈屿', otherName: '陈默' });
  assert.doesNotMatch(otherGift, /^送过|已经送到|交到对方/);
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
  assert.equal(groundedCancellation.ok, false);
  assert.ok(groundedCancellation.reasons.some((reason) => reason.includes('审计')));
});
