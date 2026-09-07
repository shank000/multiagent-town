export interface DialogueQualityContext {
  utterance: string;
  latestPrompt: string;
  priorTurns: readonly string[];
  evidence: readonly string[];
  /** 实际观察到的动作与经历；背景、传闻和功能清单有独立的语义边界。 */
  eventEvidence?: readonly string[];
  /** 与当前明确事实问题直接相关、回答应当覆盖的事实子集。 */
  answerEvidence?: readonly string[];
  speakerName: string;
  otherName: string;
  knownResidentNames?: readonly string[];
  endDialogue?: boolean;
  minuteOfDay?: number;
  recentSpeakerUtterances?: readonly string[];
}

export interface DialogueQualityAssessment {
  ok: boolean;
  reasons: string[];
}

const FORMULA = /你刚才提到|围绕我们的话题|我认真想了想|我听明白了/;
const QUESTION = /[？?]|(?:什么|怎么|为何|为什么|谁|哪(?:个|里|些)?|多少|是否|有没有|吗|呢)(?:[，。！？?]|$)/;
const SUBJECTIVE_QUESTION = /怎么看|如何看|你觉得|你认为|你的看法|有什么看法|什么感受|感受如何|最在意|更在意|为什么喜欢/u;
const FACTUAL_QUESTION = /(?:谁|哪(?:个|位|里|儿|些|本)?|多少|几(?:个|点|次|天)?|什么时候|何时|哪里|哪儿|有没有|是否|是不是|发生(?:了)?什么|遇到(?:了)?什么|做(?:了|过)?什么|读(?:的|过|了|在读)?什么|什么书|现在怎么样(?:了)?|后来怎么样(?:了)?|记得吗|对吧)/u;
const EMPTY_OR_FILLER = /^(?:[嗯啊哦唔…\.，。！？!?\s]|不知道|没什么|随便)+$/;
const GENERIC_ANSWER = /^(?:早上好|早啊|你好|嗨)[！!。\s]*(?:今天也要加油[！!。\s]*)?$/;
const NON_CONVERSATIONAL_EVIDENCE = /^(?:人物设定|人物档案|人物背景|角色背景|背景|系统提示|系统消息|日记|计划|反思|洞察|实验记录|选择记录|事件记录|对话记录|会话记录|聊天记录|关系分析|关系报告|研究分析|小镇功能[^：:]*|现场物件[^：:]*|system|persona|prompt)[：:]/iu;
const PROVENANCE_PREFIX = /^(?:(?:第\s*\d+\s*天(?:\s*\d{1,2}:\d{2})?)\s*)?(?:对话摘要|关系摘要|关系记忆|观察记录|记忆记录|活动现场(?:（已核验）)?|活动预告(?:（尚未发生）)?|花店订单(?:（已履约）)?|当前实际位置|现场状态|现场物件[^：:]*|小镇功能[^：:]*)[：:]\s*/u;
const INTERNAL_MEMORY_PREFIX = /^第\s*\d+\s*天\s*(?:日记|计划|反思|洞察|对话摘要|关系摘要|关系记忆)[：:]/u;
const TIMESTAMPED_AUDIT_RECORD = /^第\s*\d+\s*天\s*\d{1,2}:\d{2}[，,\s]*(?:.*(?:选择了|选择对象|候选伙伴|一对一交流)|[^：:]{1,32}(?:对|→)[^：:]{1,32}说[：:])/u;
const META_RELATIONSHIP_SUMMARY = /(?:双方|两人).{0,80}(?:对话|交流|隐喻|关系|情感|互信|信任|尊重).{0,30}(?:升温|加深|增强|提升|变化|形成|达成)/u;
const AUDIT_REGISTER = /(?:我能确认的是|(?:没有|缺少|足够|可靠).{0,8}(?:依据|证据|记录)|(?:等|待).{0,8}确认后|(?:记录|数据|证据)(?:显示|表明)|根据.{0,12}(?:记录|数据|证据)|活动现场（已核验）|活动预告（尚未发生）|花店订单（已履约）|第\s*\d+\s*天\s*\d{1,2}:\d{2})/u;
const CONVERSATION_PROCESS = /(?:开始|结束|开启|进入).{0,6}一对一(?:对话|交流)|(?:会话|对话).{0,8}(?:异常结束|等待发言|等待第一轮|生成超时|queued_model|generating_model)|(?:会话|对话)(?:编号|轮次|生命周期)|(?:双方|两人)(?:正在|正|在)(?:当面)?聊|根据活动预告开始前往/u;
const SOCIAL_INVITATION = /要不要|愿不愿意|想不想|(?:愿意|有空|想|能不能|可不可以).{0,16}(?:一起|陪我|帮我)|(?:要|想|来不来|来).{0,5}(?:一杯|一块|一碗|尝尝|坐坐)|(?:一起|陪我|帮我).{0,16}(?:吗|好吗|如何|怎么样|吧)[？?。！!]?$/u;
const INVITATION_RESPONSE = /^(?:嗯[，,\s]*)?(?:好(?:啊|呀|的)?|行|可以|当然|愿意|乐意|不了|不用|不必|不想|不去|不喝|不来|先不|暂时不|改天|下次|谢谢[^。！？?]{0,20}(?:邀请|好意|不过|不了|不用|先|下次)|我(?:也)?(?:想(?:想|要)?|愿意|乐意|可以|能帮|要(?:一|来)|不|先|暂时|这会儿|现在).{0,20}(?:去|来|喝|吃|坐|帮|陪|考虑|想想|不了|不用)|来一|要(?:来)?一|要[！!，,。])/u;
const INVITATION_CLARIFICATION = /(?:什么(?:口味|咖啡|时候)|哪(?:种|款|里|儿)|多大(?:杯)?|几点|需要我(?:做|帮)|怎么(?:帮|过去)|有(?:什么|哪些)).{0,18}[？?]/u;

export function isDialogueInvitation(prompt: string): boolean {
  return SOCIAL_INVITATION.test(prompt) && !/参加过|送过|昨天|上次/u.test(prompt);
}

/** 把上一句的交际意图与可作为回答的事实分开。 */
export function dialogueResponseHint(prompt: string, evidence: readonly string[] = [], priorTurns: readonly string[] = []): string {
  prompt = resolveDialogueQuestion(prompt, priorTurns);
  if (!prompt.trim()) return '从现场观察或问候开题，不复述会话状态，不照搬人物问候池。';
  const obligations = falsePremiseObligations(prompt, evidence);
  if (obligations.length) return `先逐项回应这句话中的前提：${obligations.map((item) => item.kind === 'activity'
    ? '活动未成行，应明确说明没有参加'
    : '送花或收花没有履约依据，必须单独说明这件事不清楚，不能省略，也不能编造收到花').join('；')}。只说这些事实边界，不补写当天经过。`;
  if (isDialogueInvitation(prompt)) return '对方在邀请或请求你：只需用一句话明确接受、婉拒、暂缓，或询问必要细节。不要额外叙述自己的活动或往事，不把答应写成已经做完。';
  if (/再见|回头见|先走了|下次再聊/u.test(prompt)) return '回应告别，简短收束，不另开话题。';
  if (asksRecipientIdentity(prompt)) return '对方在追问收信人的身份；只有明确记下的收信人姓名可以回答。“找到了收信人”或背景中出现的名字均不能补出这个人的身份，不清楚就直说。';
  const detail = requestedScalarDetail(prompt);
  if (detail) return `对方问的是${{ frequency: '发生频率', duration: '经过的时长', time: '具体时间', price: '价格' }[detail]}。只使用明确对应的细节作答；只记录今天做过什么，不能推断每天如此，也不能推断所用时间或价格。没有对应观察时自然说明不清楚。`;
  if (QUESTION.test(prompt)) return '先回答对方具体所问；不知道时说明不清楚。只有与该问题直接相关的观察可以用作事实答案。';
  return '先回应这句话的内容或感受，再作一个相关追问或提议；不用“后来怎么样”追问静态景物。';
}
const WORK_CONTENT_CLAIM = /(?:《[^》]{1,40}》|(?:这|那)本书|书里|书中).{0,20}(?:说|写(?:道|到)?|讲(?:到|的是)?|提到|认为|指出|描述|讨论|谈到)/u;
const READING_EXPERIENCE_CLAIM = /(?:《[^》]{1,40}》.{0,10}(?:我)?(?:在读|正在读|在看|正在看|读过|看过|读完|看完|读了|看了)|(?:我.{0,4})?(?:在读|正在读|在看|正在看|读过|看过|读完|看完|读了|看了).{0,12}《[^》]{1,40}》)/u;
const STOP_BIGRAMS = new Set([
  '今天', '最近', '什么', '怎么', '为何', '为什', '什么', '事情', '值得', '一下',
  '这个', '那个', '现在', '还是', '可以', '觉得', '知道', '没有', '一个', '我们', '你们',
]);
const ACKNOWLEDGEMENT = /^(?:嗯|是啊|对|确实|原来如此|原来|明白了|我明白了|听起来|这样啊|那就好|谢谢|辛苦了|可惜|太好了|我也|我同意|我理解|没关系|抱歉)[，。！？!?\s]*/u;
const INVITATION = /^(?:那(?:么)?[，,]?)?(?:要不要|不如|可以|愿不愿意|需不需要|我们可以|我可以|让我|下次一起)/u;
const CONVERSATION_INVITATION = /(?:继续|接着)(?:聊|说)|再说说|愿意说说/u;
const METAPHOR = /像|仿佛|如同|好似|一缕|一抹|一点|飘|落进|落在/u;
const SEMANTIC_MOTIFS = [
  /花|花瓣|花香|香气|芬芳|那缕香/u,
  /咖啡|手冲|咖啡杯|咖啡馆|咖啡豆|烘焙/u,
  /夏天|夏日|盛夏/u,
  /温柔|柔软|暖意|温暖/u,
  /湖边|湖面|风里|微风/u,
] as const;
const FACT_MOTIFS = [
  /书架|社会学区|小说区|放回|归位|放对/u,
  /画|速写|画布|作品/u,
  /擦杯|吧台/u,
  /阳光|柠檬黄|光线/u,
  /咖啡|手冲|咖啡馆/u,
  /花|花束|花香/u,
  /湖边|湖面/u,
] as const;
const TOPIC_STOP_PHRASES = [
  '我认真想了想', '围绕我们的话题', '你刚才提到',
  '最近', '今天', '现在', '这个', '那个', '事情', '一下', '我们', '你们',
  '可以', '觉得', '知道', '没有', '还是', '一个',
] as const;

/** 入库前的确定性质量门：检查承接、重复、套话和无证据的具体人名/书名。 */
export function assessDialogueTurn(context: DialogueQualityContext): DialogueQualityAssessment {
  context = { ...context, latestPrompt: resolveDialogueQuestion(context.latestPrompt, context.priorTurns) };
  const utterance = context.utterance.trim();
  const reasons: string[] = [];
  if (!utterance || utterance.length > 120 || EMPTY_OR_FILLER.test(utterance)) reasons.push('台词为空、过长或只有填充词');
  if (FORMULA.test(utterance)) reasons.push('使用机械复述套话');
  if (usesAuditRegister(utterance)) {
    reasons.push('使用研究审计或关系元摘要口吻');
  }
  if (GENERIC_ANSWER.test(utterance) && QUESTION.test(context.latestPrompt)) reasons.push('用寒暄回避了明确问题');
  if (isDialogueInvitation(context.latestPrompt)
    && !INVITATION_RESPONSE.test(utterance)
    && !INVITATION_CLARIFICATION.test(utterance)) {
    reasons.push('没有回应对方的邀请或请求：需要接受、婉拒、暂缓或澄清');
  }
  if (context.minuteOfDay !== undefined && /早啊|早安|早上好/u.test(utterance)
    && (context.minuteOfDay < 240 || context.minuteOfDay >= 660)) {
    reasons.push('问候与当前世界时段不符');
  }
  if (normalize(utterance).length >= 12 && context.recentSpeakerUtterances?.some((prior) => normalize(prior) === normalize(utterance))) {
    reasons.push('照搬自己近期其他会话的整句台词');
  }

  for (const [index, prior] of context.priorTurns.entries()) {
    const priorNormalized = normalize(prior);
    const isLatest = index === context.priorTurns.length - 1;
    if (priorNormalized && nearRepeat(utterance, prior, isLatest)) {
      reasons.push('与本次会话已有台词高度重复');
      break;
    }
  }

  if (QUESTION.test(context.latestPrompt) && !directlyAddresses(context.latestPrompt, utterance, context.evidence)) {
    reasons.push('没有直接承接上一轮明确问题');
  } else if (context.latestPrompt.trim() && !pragmaticallyContinues(context.latestPrompt, utterance, context.evidence)) {
    reasons.push('没有语用承接对方上一轮发言');
  }
  if (requiresAnswerEvidence(context.latestPrompt, context.answerEvidence)
    && !coversAnswerEvidence(utterance, context.answerEvidence ?? [], context.latestPrompt)) {
    reasons.push('明确事实回答没有覆盖提供的答案证据');
  }
  if (asksReadingDetail(context.latestPrompt)
    && !context.evidence.some((fact) => answersRequestedDetail(context.latestPrompt, fact))
    && !expressesUnknownDetail(utterance)) {
    reasons.push('没有具体章节或进度依据，不能以书名或主题代答');
  }
  if (asksRecipientIdentity(context.latestPrompt)
    && !context.evidence.some((fact) => answersRequestedDetail(context.latestPrompt, fact))
    && !expressesUnknownDetail(utterance)) {
    reasons.push('收信人身份缺少依据，不能以送信地点或其他见闻代答');
  }
  const detail = requestedScalarDetail(context.latestPrompt);
  if (detail && !expressesUnknownDetail(utterance)
    && !context.evidence.some((fact) => scalarDetailSupported(detail, utterance, fact))) {
    reasons.push('所问的频率、时长、时刻或价格需要对应数值依据，相关场景不能代答');
  }
  if (context.priorTurns.length >= 3 && !context.endDialogue && !advancesConversationArc(context.latestPrompt, utterance, context.evidence)) {
    reasons.push('会话后半段没有新增问题、事实、提议、回应或自然收束');
  }

  const evidenceText = [context.speakerName, context.otherName, context.latestPrompt, ...context.priorTurns, ...context.evidence].join('\n');
  for (const name of context.knownResidentNames ?? []) {
    if (name === context.speakerName || name === context.otherName) continue;
    if (utterance.includes(name) && !evidenceText.includes(name)) {
      reasons.push(`提到无当前证据支持的居民「${name}」`);
    }
  }
  for (const title of utterance.matchAll(/《([^》]{1,40})》/g)) {
    if (!evidenceText.includes(title[0])) reasons.push(`提到无当前证据支持的作品「${title[0]}」`);
  }
  for (const sentence of utterance.split(/[。！？!?；\n]/u).map((item) => item.trim()).filter(Boolean)) {
    if (WORK_CONTENT_CLAIM.test(sentence) && !workContentClaimSupported(sentence, context.eventEvidence ?? context.evidence)) {
      reasons.push('转述无当前证据支持的作品内容');
    }
    if (
      READING_EXPERIENCE_CLAIM.test(sentence)
      && !deniesReadingExperience(sentence)
      && !readingExperienceSupported(sentence, context.eventEvidence ?? context.evidence)
    ) {
      reasons.push('声称无个人记忆支持的阅读经历');
    }
  }
  for (const assignment of utterance.matchAll(/(?:收信人|客人|学生|朋友|作者|店主|老师|医生|邻居|名字|姓名)(?:是|叫|姓)[^，。！？!?]{1,12}/g)) {
    if (!evidenceText.includes(assignment[0])) reasons.push(`给社会角色添加无证据身份「${assignment[0]}」`);
  }
  const informalNames = /(?:老|小)[赵钱孙李周吴郑王冯陈卫沈韩杨朱秦许何吕施张孔曹严华金魏陶姜谢邹苏潘葛范彭鲁韦马方任袁柳叶姚郭丁余程徐胡高林罗梁宋唐曾邓肖田董傅卢蒋蔡贾段陆]/gu;
  for (const informalName of utterance.matchAll(new RegExp(`${informalNames.source}家`, 'gu'))) {
    if (!evidenceText.includes(informalName[0])) reasons.push(`提到无当前证据支持的人名「${informalName[0]}」`);
  }
  const commonWords = new Set([
    '老人', '老板', '老伴', '老家', '老话', '老路', '老手', '老实', '老了',
    '小镇', '小船', '小花', '小手', '小事', '小路', '小孩', '小伙', '小姐',
    '小屋', '小时', '小心', '小雨', '小鸟', '小鱼', '小狗', '小猫', '小店', '小巷', '小桥', '小步',
    '老街', '老灯', '老书', '老树', '老城', '老屋', '老店', '老船', '老桥', '老木', '老墙', '老茶', '老酒', '老旧', '老骨',
    '小院', '小摊', '小桌', '小杯', '小碗', '小灯', '小草', '小树', '小河', '小山', '小湖', '小本', '小芽',
  ]);
  for (const informalName of utterance.matchAll(informalNames)) {
    if (!commonWords.has(informalName[0]) && !evidenceText.includes(informalName[0])) {
      reasons.push(`提到无当前证据支持的非正式人名「${informalName[0]}」`);
    }
  }
  if (new RegExp(`${escapeRegExp(context.otherName)}\\s*[：:]`).test(utterance)) {
    reasons.push('替对方生成了发言');
  }
  reasons.push(...worldClaimReasons({ ...context, evidence: context.eventEvidence ?? context.evidence }));
  reasons.push(...falsePremiseDenialReasons(context));
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function usesAuditRegister(utterance: string): boolean {
  const sourceText = utterance.replace(
    /^(?:(?:嗯+|哦+|唔+|其实|这个|怎么说呢)[，,。；;\s]*)+/u,
    '',
  );
  return AUDIT_REGISTER.test(utterance)
    || CONVERSATION_PROCESS.test(utterance)
    || META_RELATIONSHIP_SUMMARY.test(utterance)
    || NON_CONVERSATIONAL_EVIDENCE.test(sourceText)
    || INTERNAL_MEMORY_PREFIX.test(sourceText)
    || TIMESTAMPED_AUDIT_RECORD.test(sourceText);
}

export interface ConservativeDialogueOptions {
  priorTurns?: readonly string[];
  rumorEvidence?: readonly string[];
  speakerName?: string;
  otherName?: string;
  recentSpeakerUtterances?: readonly string[];
}

/** 两次生成仍未通过时，只把与当前问题相关的事实改写成自然回答。 */
export function conservativeDialogueReply(
  latestPrompt: string,
  evidence: readonly string[] = [],
  options: ConservativeDialogueOptions = {},
): string {
  const priorTurns = options.priorTurns ?? [];
  latestPrompt = resolveDialogueQuestion(latestPrompt, priorTurns);
  const recent = [...priorTurns, ...(options.recentSpeakerUtterances ?? [])];
  if (isDialogueInvitation(latestPrompt)) {
    return chooseFreshReply([
      '谢谢你的邀请，我先想一想。',
      '谢谢你的好意，先让我考虑一下吧。',
      '我先考虑一下，待会儿再答复你，好吗？',
    ], recent);
  }
  if (!latestPrompt.trim()) {
    return chooseFreshReply(openingReplies(evidence), recent).slice(0, 120);
  }
  if (priorTurns.length >= 3 && !QUESTION.test(latestPrompt)) {
    return chooseFreshReply(closingReplies(), recent).slice(0, 120);
  }
  const grounded = QUESTION.test(latestPrompt) ? relevantEvidence(questionFocus(latestPrompt), evidence) : null;
  if (grounded) {
    const rumor = options.rumorEvidence?.includes(grounded.raw) ?? false;
    const replies = groundedReplies(latestPrompt, grounded.text, rumor, options);
    return chooseFreshReply(replies, recent).slice(0, 120);
  }
  const replies = !QUESTION.test(latestPrompt)
    ? continuationReplies(latestPrompt)
    : uncertainReplies(latestPrompt);
  return chooseFreshReply(replies, recent).slice(0, 120);
}

function openingReplies(evidence: readonly string[]): string[] {
  const grounded = evidence
    .map(conversationalEvidence)
    .find((item) => item.length >= 4 && !usesAuditRegister(item));
  if (!grounded) return ['你好，今天过得怎么样？', '最近还好吗？', '今天有什么想聊的吗？'];
  const fact = firstPersonFact(grounded).replace(/[。！!？?]+$/u, '').slice(0, 82);
  return [
    `${fact}。你今天怎么样？`,
    `我今天留意到一件事：${fact}。你最近怎么样？`,
  ];
}

interface GroundedEvidence {
  raw: string;
  text: string;
  score: number;
  index: number;
}

function relevantEvidence(prompt: string, evidence: readonly string[]): GroundedEvidence | null {
  const candidates = evidence.flatMap((raw, index) => {
    const text = conversationalEvidence(raw);
    if (text.length < 4 || !answersRequestedDetail(prompt, text)) return [];
    const score = evidenceRelevance(prompt, text);
    return score > 0 ? [{ raw, text, score, index }] : [];
  });
  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  return candidates[0] ?? null;
}

function conversationalEvidence(raw: string): string {
  let text = raw.replace(/\s+/gu, ' ').trim();
  if (
    !text
    || NON_CONVERSATIONAL_EVIDENCE.test(text)
    || INTERNAL_MEMORY_PREFIX.test(text)
    || TIMESTAMPED_AUDIT_RECORD.test(text)
    || META_RELATIONSHIP_SUMMARY.test(text)
    || CONVERSATION_PROCESS.test(text)
  ) return '';
  text = text
    .replace(/<[^>]{1,80}>/gu, ' ')
    .replace(/\[(?:memory|event|evidence)[^\]]*\]/giu, ' ')
    .replace(/(?:memory|event|evidence)[-_ ]?id\s*[:=]\s*[^\s，。；]+/giu, ' ')
    .replace(/(?:记忆|事件|证据)\s*ID\s*[：:=]\s*[^\s，。；]+/giu, ' ')
    .replace(/^第\s*\d+\s*天\s*\d{1,2}:\d{2}[，,]\s*/u, '')
    .replace(PROVENANCE_PREFIX, '')
    .replace(/^「([^」]+)」现场核验未达到两人[：:]\s*/u, '$1')
    .replace(/活动现场（已核验）|活动预告（尚未发生）|花店订单（已履约）/gu, '')
    .replace(/实际到场参加/gu, '参加')
    .replace(/无人实际到场/gu, '没有人到场')
    .replace(/（功能存在不代表事件已经发生）/gu, '')
    .replace(/[「」]/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/^[：:；;，,\s]+|[：:；;，,\s]+$/gu, '')
    .trim();
  return text.slice(0, 100);
}

export function isConversationalEvidence(raw: string): boolean {
  return conversationalEvidence(raw).length >= 4;
}

function evidenceRelevance(prompt: string, fact: string): number {
  const promptTerms = meaningfulBigrams(prompt);
  const factTerms = meaningfulBigrams(fact);
  let score = 0;
  for (const term of promptTerms) if (factTerms.has(term)) score += 1;
  if (/读.{0,4}(?:什么|哪本|书)|什么书/u.test(prompt) && /读书|阅读|书名|在读/u.test(fact)) score += 5;
  const activity = activityNameIn(prompt);
  if (activity && activityNameIn(fact) === activity) score += 6;
  if (/鲜花|花束|送花/u.test(prompt) && /鲜花|花束|送花/u.test(fact)) score += 5;
  if (/谁|哪位/u.test(prompt) && /(?:是|叫|交给|送给)[^，。]{1,20}/u.test(fact)) score += 2;
  return score;
}

function groundedReplies(
  prompt: string,
  fact: string,
  rumor: boolean,
  options: ConservativeDialogueOptions,
): string[] {
  if (asksReadingExperience(prompt)) {
    if (/(?:没|没有|未).{0,6}(?:读|看)/u.test(fact)) return uncertainReplies(prompt);
    return [`${firstPersonFact(fact)}。`];
  }
  const bookQuestion = /读.{0,4}(?:什么|哪本|书)|什么书/u.test(prompt);
  if (bookQuestion && /(?:没有|没|未).{0,5}(?:读书|阅读|在读)/u.test(fact)) {
    const focus = fact.match(/(?:主要)?精力(?:都)?放在(.+?)(?:上)?[。！!？?]?$/u)?.[1]?.replace(/上$/u, '');
    return focus
      ? [`最近没在读书，我把精力放在${focus}上。`, `我最近没有读哪本书，主要在忙${focus}。`]
      : ['最近没在读书，我不想随口编个书名。', '我想不起最近读过哪本书，先不乱说。'];
  }
  if (bookQuestion && /(?:在读|读过|阅读)/u.test(fact)) {
    const reading = firstPersonFact(fact).replace(/^最近/u, '');
    return [`最近${reading}。`, `我记得最近${reading}。`];
  }

  const activity = activityNameIn(prompt);
  if (activity && /取消|没有人到场/u.test(fact)) {
    const flowerTail = /鲜花|花束|送花/u.test(prompt) ? '；送花这件事我也想不起来了。' : '。';
    return [
      `没参加，${activity}后来取消了${flowerTail}`,
      `${activity}没有成行，我没有参加${flowerTail}`,
    ];
  }
  if (activity && /尚未发生|计划|准备|提议/u.test(fact)) {
    return [`还没有参加，${activity}目前只是计划。`, `${activity}还没发生，我没有参加过。`];
  }
  if (activity && /参加|到场/u.test(fact)) {
    const location = fact.match(/在([^，。；]{1,12})(?:参加|到场)/u)?.[1];
    const asksShared = /我们|咱们|一起|共同/u.test(prompt);
    const namesSupportSpeaker = !options.speakerName || fact.includes(options.speakerName) || /^我/u.test(fact);
    const namesSupportDyad = !!options.speakerName && !!options.otherName
      && fact.includes(options.speakerName) && fact.includes(options.otherName);
    const textSupportsDyad = namesSupportDyad
      || /共同|一起/u.test(fact)
      || /[^，。；]{1,12}(?:、|和|与)[^，。；]{1,12}在[^，。；]{0,12}(?:参加|到场)/u.test(fact);
    if (!namesSupportSpeaker) return uncertainReplies(prompt);
    if (asksShared && !textSupportsDyad) {
      return [`我参加过，但不记得你当时在不在。`, `我记得自己参加过，你有没有参加我说不准。`];
    }
    const subject = asksShared ? '我们' : '我';
    return [
      `参加过，${subject}${location ? `在${location}` : ''}参加了${activity}。`,
      `有这回事，${subject}确实参加过${activity}。`,
    ];
  }
  if (/鲜花|花束|送花/u.test(prompt) && /配送|交给|赠送|收到/u.test(fact)) {
    const asksDyad = /你.{0,12}(?:我|给)|我.{0,12}(?:你|给)|我们|咱们/u.test(prompt);
    const supportsDyad = !options.speakerName || !options.otherName
      || (fact.includes(options.speakerName) && fact.includes(options.otherName))
      || /送给你|交给你|我收到|你收到/u.test(fact);
    if (asksDyad && !supportsDyad) return uncertainReplies(prompt);
    return ['送过，我记得那束花已经送到了。', '有过，那束花确实已经交到对方手里了。'];
  }

  const naturalFact = firstPersonFact(fact);
  if (/哪里|哪儿|何处/u.test(prompt)) {
    const place = naturalFact.split(/[；;。]/u)[0]?.replace(/^(?:我)?(?:现在)?在/u, '').trim();
    if (place) return [`我现在在${place}。`, `我所在的地方是${place}。`];
  }
  if (rumor) return [`我听说，${naturalFact}。`, `我听到的消息是，${naturalFact}。`];
  if (/^(?:是|不是|有|没有|没|会|不会|能|不能|是否)|吗[？?]?$/u.test(prompt.trim())) {
    return [`${naturalFact}。`, `我记得，${naturalFact}。`];
  }
  return [`我记得，${naturalFact}。`, `我印象里，${naturalFact}。`];
}

function firstPersonFact(fact: string): string {
  return fact
    .replace(/^我(?:能确认|记得|知道)(?:的是)?[：:,，]?\s*/u, '')
    .replace(/。+$/u, '')
    .trim();
}

function uncertainReplies(prompt: string): string[] {
  if (asksReadingExperience(prompt)) return ['这本书有没有读过，我一时想不起来了。', '我不确定有没有读过这本书。'];
  if (asksReadingDetail(prompt)) return ['具体读到哪一部分，我一时记不清了。', '具体章节我现在说不准。'];
  if (/读.{0,4}(?:什么|哪本|书)|什么书/u.test(prompt)) {
    return ['我一下想不起最近读过什么了。', '最近读的书名我记不清了，先不瞎说。', '这阵子读过什么，我一时真想不起来。'];
  }
  if (/鲜花|花束|送花|收花|送过花|收到花/u.test(prompt)) {
    if (/收到|收过|收花/u.test(prompt)) {
      return ['有没有收到那束花，我记不清了。', '收花这件事我现在想不起来了。', '那束花我是否收到过，现在说不准。'];
    }
    return ['送花这件事我记不清了。', '我想不起来有没有送过那束花。', '那束花是否送过，我现在说不准。'];
  }
  if (/谁|哪位/u.test(prompt)) return ['我想不起是谁了，别让我瞎猜。', '具体名字我记不清了。', '是哪一位，我现在说不准。'];
  if (/为什么|为何/u.test(prompt)) return ['原因我还没想明白。', '我现在也解释不了，还是别瞎猜了。', '为什么会这样，我一时说不上来。'];
  if (/怎么看|如何看|你觉得/u.test(prompt)) return ['我现在还没有形成明确看法。', '我的判断还不成熟，暂时说不准。', '我想再了解一些情况，眼下还不能下结论。'];
  if (/哪里|哪儿|何处/u.test(prompt)) return ['具体在哪里我还不知道。', '地点我现在说不准。', '我暂时想不起具体地点。'];
  if (/什么时候|何时|几点/u.test(prompt)) return ['具体时间我记不清了。', '什么时候发生的，我暂时想不起来。', '时间我现在说不准。'];
  if (/^(?:是|不是|有|没有|没|会|不会|能|不能|是否)|吗[？?]?$/u.test(prompt.trim())) {
    return ['这事我记不清了，不敢说有还是没有。', '这件事我不太清楚。', '是还是不是，我现在真说不准。'];
  }
  if (QUESTION.test(prompt)) return ['具体情况我想不起来了，先不瞎说。', '这件事我现在说不准。', '我不太清楚这件事。'];
  return continuationReplies(prompt);
}

function continuationReplies(prompt: string): string[] {
  if (/不清楚|想不起|记不清|说不准|不确定/u.test(prompt)) {
    return ['没关系，那先说说你现在的感受吧。', '想不起来也没关系，我们聊点别的好吗？'];
  }
  if (/(?:已经|终于|后来|就把|放回|完成|处理好|修好|找到了|送到|交给|解决)/u.test(prompt)) {
    return [
      '原来如此。你当时为什么会留意到它？',
      '我明白了。做完以后，你心里是什么感觉？',
      '听起来你已经处理好了。你当时是怎么想到这么做的？',
    ];
  }
  if (/在读|阅读|这本书|那本书/u.test(prompt)) {
    return ['你为什么会选这本书？', '你喜欢这本书的哪一点？'];
  }
  if (/咖啡|手冲|口味|无糖|不加糖/u.test(prompt)) {
    return ['你喜欢这种口味吗？', '这种咖啡适合怎样慢慢品尝？'];
  }
  if (/湖面|风平浪静|风景|花开|花香|天气|景色|阳光/u.test(prompt)) {
    return ['你喜欢这里的哪一点？', '你平时也会留意这样的景色吗？', '这里给你什么感觉？'];
  }
  return [
    '原来如此。后来怎么样了？',
    '我明白了。你为什么会留意到这件事？',
    '听起来这对你挺重要的，你愿意再说说吗？',
  ];
}

function closingReplies(): string[] {
  return [
    '嗯，我明白你的意思了。今天先聊到这里吧。',
    '我听懂了，改天我们再接着聊。',
    '好，我会再想想。下次见面再聊吧。',
  ];
}

function chooseFreshReply(replies: readonly string[], priorTurns: readonly string[]): string {
  const prior = new Set(priorTurns.map(normalize).filter(Boolean));
  for (const reply of replies) if (!prior.has(normalize(reply))) return reply;
  return replies[priorTurns.length % replies.length] ?? '我现在还不能确定。';
}

export function dialogueRepairInstruction(reasons: readonly string[], rejectedUtterance = ''): string {
  const groundingRepair = reasons.some((reason) => /无当前证据支持|无个人记忆支持|没有完成证据/u.test(reason))
    ? '保留对上一句的必要回应，删掉没有事实来源的经历从句，不要用另一段经历替换；只写简短的一句话。' : '';
  return `\n\n<QUALITY_REPAIR>上一版台词未通过入库检查：${reasons.join('；')}。${rejectedUtterance ? `待修正候选（不是已说出口的台词）：${JSON.stringify(rejectedUtterance.slice(0, 120))}。` : ''}${groundingRepair}请直接重写台词，只使用已提供事实，不增加具体人名、作品名、时间或事件；活动预告不能写成已经参加，馈礼意向不能写成已经送达；明确事实问题必须用相关事实回答，被取消或未履约事实推翻的共同经历必须自然地明确否定。必须像居民当面说话，不得朗读日期编号、记录标签、证据依据，也不得用“双方”“情感升温”等研究总结口吻。</QUALITY_REPAIR>`;
}

/** 为运行时质量门筛出与明确事实问题直接相关的可回答证据。 */
export function selectDialogueAnswerEvidence(prompt: string, evidence: readonly string[], priorTurns: readonly string[] = []): string[] {
  prompt = questionFocus(resolveDialogueQuestion(prompt, priorTurns));
  if (!isExplicitFactualQuestion(prompt)) return [];
  return evidence.filter((raw) => {
    const fact = conversationalEvidence(raw);
    if (!fact || !answersRequestedDetail(prompt, fact)) return false;
    return (asksRecipientIdentity(prompt) && recipientIdentities(fact).length > 0)
      || evidenceRelevance(prompt, fact) >= 2
      || topicOverlapCount(prompt, fact) >= 2
      || falsePremiseObligations(prompt, [raw]).some((item) => item.basis === 'contradicted');
  });
}

/**
 * 共享的虚假前提语义：问题把共同事件说成已完成、证据却表明取消或未履约时，
 * 回答必须明确否定该事件。运行时与真实居民验收都通过 assessDialogueTurn 复用它。
 */
export function falsePremiseDenialReasons(
  context: Pick<DialogueQualityContext, 'utterance' | 'latestPrompt' | 'evidence'>
    & Partial<Pick<DialogueQualityContext, 'speakerName' | 'otherName'>>,
): string[] {
  const obligations = falsePremiseObligations(
    context.latestPrompt,
    context.evidence,
    context.speakerName,
    context.otherName,
  );
  return obligations
    .filter((obligation) => !correctsFalsePremise(context.utterance, obligation.kind))
    .map((obligation) => obligation.basis === 'unsupported'
      ? `没有纠正缺少履约证据的送花或收花前提「${obligation.label}」`
      : `没有明确否定被事实证据推翻的虚假前提「${obligation.label}」`);
}

type FalsePremiseKind = 'activity' | 'gift';
type FalsePremiseBasis = 'contradicted' | 'unsupported';

interface FalsePremiseObligation {
  kind: FalsePremiseKind;
  label: string;
  basis: FalsePremiseBasis;
}

function falsePremiseObligations(
  prompt: string,
  evidence: readonly string[],
  speakerName?: string,
  otherName?: string,
): FalsePremiseObligation[] {
  const obligations: FalsePremiseObligation[] = [];
  const activity = activityNameIn(prompt);
  const assertsCompletedActivity = !!activity
    && /我们|咱们|一起|共同|互相/u.test(prompt)
    && /参加(?:了|过)?|去(?:了|过)|到场(?:了|过)?|办(?:了|过)|举行(?:了|过)/u.test(prompt);
  if (activity && assertsCompletedActivity && evidence.some((item) => (
    activityNameIn(item) === activity
    && /取消|未举办|没有举办|没举办|没办|派对没办|没成行|未成行|尚未发生|无人实际到场|没有人到场|无人参加|未参加/u.test(item)
  ))) {
    obligations.push({ kind: 'activity', label: `${activity}未成行`, basis: 'contradicted' });
  }

  const assertsCompletedGift = /(?:送给|送了|送过|赠送|收到|收下|拿到).{0,12}(?:鲜花|花束|花)|(?:鲜花|花束).{0,10}(?:送了|送过|收到)/u.test(prompt);
  const giftFulfilled = assertsCompletedGift && fulfilledFlowerEvidence(evidence, speakerName, otherName);
  if (assertsCompletedGift && !giftFulfilled) {
    const explicitlyUnfulfilled = evidence.some((item) => (
    /鲜花|花束|送花|花店订单/u.test(item)
    && /未履约|没有履约|取消|未送达|没有送达|没送达|没送|未送|没收到|未收到/u.test(item)
    ));
    obligations.push({
      kind: 'gift',
      label: explicitlyUnfulfilled ? '送花或收花未履约' : '送花或收花没有履约记录',
      basis: explicitlyUnfulfilled ? 'contradicted' : 'unsupported',
    });
  }
  return obligations;
}

function fulfilledFlowerEvidence(
  evidence: readonly string[],
  speakerName?: string,
  otherName?: string,
): boolean {
  const requiredNames = [speakerName, otherName].filter((name): name is string => !!name);
  return evidence.some((item) => (
    /鲜花|花束|送花|花店订单/u.test(item)
    && /花店订单（已履约）|(?:配送|送达).{0,24}(?:交给|收到)|(?:交给|赠送|送给|收到|收下).{0,12}(?:鲜花|花束|花)|(?:鲜花|花束).{0,12}(?:已送达|已经送达|交给|赠送|送给|收到)/u.test(item)
    && requiredNames.every((name) => item.includes(name))
  ));
}

function correctsFalsePremise(utterance: string, kind: FalsePremiseKind): boolean {
  if (kind === 'activity') {
    const explicitActivityDenial = /没(?:有)?办(?:成)?(?:.{0,6}(?:派对|聚会|活动))?|(?:派对|聚会|活动).{0,6}没(?:有)?办|哪有(?:.{0,6}(?:派对|聚会|活动))?|没(?:有)?参加|未参加|不曾参加|从未参加|没成行|未成行|没举行|未举行|没有人到场|无人到场|没去|没到场/u.test(utterance);
    const giftOnlyCancellation = /配送.{0,6}取消|(?:鲜花|花束|送花).{0,8}取消/u.test(utterance);
    return explicitActivityDenial || (!giftOnlyCancellation && /取消/u.test(utterance));
  }
  if (
    /没(?:有)?送(?:过)?(?=$|[，,。！？!?；\s]|鲜花|花束|花|给)|没(?:有)?收到(?:过)?(?=$|[，,。！？!?；\s]|鲜花|花束|花)|未送|未收到|没送达|未送达|没有送达/u.test(utterance)
    || /(?:花店|花束|鲜花|送花|配送).{0,10}(?:未履约|没有履约|取消|没送达|未送达|没有送达)/u.test(utterance)
  ) {
    return true;
  }
  return /(?:关于|至于|说到)?(?:送花|收花|鲜花|花束|那束花)(?:的|这件|那件)?(?:事(?:情)?)?[，,：:\s]*(?:我(?:也|真|都)?)?(?:想不起来|不记得|记不(?:太)?清|没印象|说不准|不确定|不清楚|不知道|不敢说)/u.test(utterance)
    || /(?:送花|收花|鲜花|花束)(?:的|这件|那件)?事.{0,14}(?:想不起来|不记得|记不(?:太)?清|没印象|说不准|不确定|不清楚|不知道|不敢说)/u.test(utterance)
    || /(?:鲜花|花束|那束花).{0,14}(?:送|收).{0,14}(?:想不起来|不记得|记不清|没印象|说不准|不确定|不清楚|不知道|不敢说)/u.test(utterance)
    || /至于(?:鲜花|花束|送花|收花|花).{0,14}(?:想不起来|不记得|记不清|没印象|说不准|不确定|不清楚|不知道|不敢说)/u.test(utterance)
    || /(?:想不起来|不记得|记不清|没印象|说不准|不确定|不清楚|不知道|不敢说).{0,14}(?:有没有|是否).{0,8}(?:送花|收花|送过|收到)/u.test(utterance);
}

function requiresAnswerEvidence(prompt: string, answerEvidence: readonly string[] | undefined): boolean {
  return !!answerEvidence?.some((fact) => answersRequestedDetail(prompt, fact)) && isExplicitFactualQuestion(prompt);
}

function asksReadingDetail(prompt: string): boolean {
  return /读|书|阅读/u.test(prompt) && /哪(?:一|个|些)?部分|哪(?:一)?章|第几章|第几页|读到哪|读了多少/u.test(prompt);
}

function asksReadingExperience(prompt: string): boolean {
  return /书|《[^》]+》/u.test(prompt) && /(?:读|看)(?:过|完|了).{0,16}[？?]|(?:读|看)(?:过|完|了)(?:吗|没)/u.test(prompt);
}

function asksRecipientIdentity(prompt: string): boolean {
  return /(?:信|邮件|收件|收信)/u.test(prompt) && /给谁|寄给谁|收(?:信|件)人(?:是)?谁|找到谁|找到了谁|哪一位/u.test(prompt);
}

function answersRequestedDetail(prompt: string, fact: string): boolean {
  if (asksReadingExperience(prompt) && !/(?:在读|阅读|读书|看书|读过|看过|读完|看完)/u.test(fact)) return false;
  if (asksRecipientIdentity(prompt) && recipientIdentities(fact).length === 0) return false;
  const detail = requestedScalarDetail(prompt);
  if (detail && scalarValues(detail, fact).length === 0) return false;
  return !asksReadingDetail(prompt) || /第[一二三四五六七八九十百\d]+[章节页]|读到|读完|章节|读了.{0,5}(?:一半|半本|部分)/u.test(fact);
}

/** 前文只用于解析省略的提问对象；事实依据仍来自当前居民的可用观察。 */
export function resolveDialogueQuestion(prompt: string, priorTurns: readonly string[] = []): string {
  const focus = questionFocus(prompt);
  if (/(?:给谁|找到谁|找到了谁|哪一位)/u.test(focus)
    && /(?:那封信|送信|收信人|收件人|寄信|邮递)/u.test([prompt, ...priorTurns.slice(-3)].join('\n'))) {
    return `关于收信人：${focus}`;
  }
  return prompt;
}

function expressesUnknownDetail(text: string): boolean {
  return /不知道|不(?:太)?清楚|想不起|记不(?:太)?清|不记得|说不准|不确定|不方便说|暂时不想说/u.test(text);
}

function recipientIdentities(text: string): string[] {
  return [...text.matchAll(/(?:收信人|收件人|收件方)(?:是|叫)|(?:信|邮件)(?:是)?(?:寄给|交给|送给)/gu)]
    .flatMap((match) => {
      const tail = text.slice((match.index ?? 0) + match[0].length);
      const name = tail.match(/^[「“]?([\p{Script=Han}]{2,4}?)(?:家|[」”]?[，。！？!?；\s]|的|$)/u)?.[1];
      return name && !/谁|本人|对方|自己|哪|未知|不清楚/u.test(name) ? [name] : [];
    });
}

type ScalarDetail = 'frequency' | 'duration' | 'time' | 'price';

function requestedScalarDetail(prompt: string): ScalarDetail | null {
  if (!QUESTION.test(prompt) || isDialogueInvitation(prompt) || SUBJECTIVE_QUESTION.test(prompt)) return null;
  if (/多久一次|多长时间一次|(?:每(?:天|周|月|年)|经常|总是).{0,18}(?:吗|么)|多(?:久|长时间).{0,4}一(?:次|回)|几次/u.test(prompt)) return 'frequency';
  if (/多少钱|什么价格|价格(?:是)?多少|价钱|几元|几块/u.test(prompt)) return 'price';
  if (/多久|多长时间/u.test(prompt)) return 'duration';
  if (/什么时候|何时|几点|什么时间/u.test(prompt)) return 'time';
  return null;
}

function scalarValues(detail: ScalarDetail, text: string): string[] {
  text = text.replace(/[零〇一二两三四五六七八九十百千]+/gu, (value) => String(chineseInteger(value)))
    .replace(/(\d{1,2})[:：](\d{2})/gu, '$1点$2分');
  const quantity = '[零〇一二两三四五六七八九十百千万\\d]+(?:[.．点][零〇一二两三四五六七八九\\d]+)?';
  const pattern = detail === 'frequency' ? `每(?:天|周|月|年|${quantity}(?:天|周|月|年))(?:${quantity}次)?|(?:1|每)天${quantity}次|偶尔|经常|很少|从不|总是`
    : detail === 'duration' ? `(?:${quantity}|半)(?:个)?(?:分钟|小时|天|周|月|年)(?:半)?`
    : detail === 'price' ? `${quantity}(?:元|块|金币)(?:${quantity}(?:角|毛))?|免费|不收费`
    : `(?:${quantity}[点时](?:${quantity}分|半|1刻|3刻)?|\\d{1,2}[:：]\\d{2}|明天|后天|今天|昨天|上午|下午|晚上|清晨|中午)`;
  return [...text.matchAll(new RegExp(pattern, 'gu'))].map((match) => {
    const value = match[0].replace(/块/gu, '元');
    if (detail === 'duration') {
      const duration = value.match(/^(\d+(?:\.\d+)?|半)(?:个)?(分钟|小时|天|周)(半)?$/u);
      if (duration) return `${(duration[1] === '半' ? 0.5 : Number(duration[1]) + (duration[3] ? 0.5 : 0))
        * ({ 分钟: 1, 小时: 60, 天: 1440, 周: 10080 }[duration[2]] ?? 1)}分钟`;
    }
    if (detail === 'time') {
      const time = value.match(/^(\d+)[点时](?:(\d+)分|(半)|1刻|3刻)?$/u);
      if (time) return `${time[1]}:${time[2] ? Number(time[2]) : time[3] ? 30 : value.endsWith('1刻') ? 15 : value.endsWith('3刻') ? 45 : 0}`;
    }
    return value;
  });
}

function chineseInteger(value: string): number {
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (!/[十百千]/u.test(value)) return Number([...value].map((char) => digits[char]).join(''));
  let total = 0;
  let digit = 0;
  for (const char of value) {
    const unit = ({ 十: 10, 百: 100, 千: 1000 } as Record<string, number>)[char];
    if (unit) { total += (digit || 1) * unit; digit = 0; }
    else digit = digits[char] ?? 0;
  }
  return total + digit;
}

function scalarDetailSupported(detail: ScalarDetail, utterance: string, fact: string): boolean {
  const claims = scalarValues(detail, utterance);
  const values = scalarValues(detail, fact);
  if (detail === 'frequency' && /^(?:是的|对[，。]|不是|不[，。])/u.test(utterance.trim())) {
    // 简短的是非回答交由语义审校核对肯否，仍须有明确频率依据。
    return values.length > 0;
  }
  return claims.length > 0 && claims.every((claim) => values.includes(claim));
}

function isExplicitFactualQuestion(prompt: string): boolean {
  if (isDialogueInvitation(prompt)) return false;
  if (/^(?:你|您)?(?:今天|最近)?(?:过得怎么样|怎么样|好吗|还好吗)[？?]?$/u.test(prompt.trim())) return false;
  if (!QUESTION.test(prompt)) return false;
  if (FACTUAL_QUESTION.test(prompt)) return true;
  return !SUBJECTIVE_QUESTION.test(prompt)
    && /什么|怎么(?:样)?|谁|哪|多少|几|吗|呢|是否|有没有/u.test(prompt);
}

function coversAnswerEvidence(utterance: string, answerEvidence: readonly string[], prompt: string): boolean {
  if (asksRecipientIdentity(prompt)) {
    return answerEvidence.some((fact) => recipientIdentities(fact).some((name) => utterance.includes(name)
      && !new RegExp(`(?:不是|不叫|不是给|不是寄给)${escapeRegExp(name)}`, 'u').test(utterance)));
  }
  const detail = requestedScalarDetail(prompt);
  if (detail) return answerEvidence.some((fact) => scalarDetailSupported(detail, utterance, fact));
  const obligations = falsePremiseObligations(prompt, answerEvidence);
  if (obligations.length && obligations.every((item) => correctsFalsePremise(utterance, item.kind))) return true;
  const normalizedPrompt = normalizeAnswerSemantics(prompt);
  const normalizedUtterance = normalizeAnswerSemantics(utterance);
  const utteranceConcepts = answerConcepts(normalizedUtterance);
  return answerEvidence.some((raw) => {
    const fact = conversationalEvidence(raw);
    if (!fact) return false;
    const normalizedFact = normalizeAnswerSemantics(fact);
    const factConcepts = answerConcepts(normalizedFact);
    for (const concept of factConcepts) if (utteranceConcepts.has(concept)) return true;
    return evidenceSpecificOverlap(normalizedPrompt, normalizedFact, normalizedUtterance) >= 2;
  });
}

function evidenceSpecificOverlap(prompt: string, fact: string, utterance: string): number {
  const promptTerms = topicBigrams(prompt);
  const factTerms = topicBigrams(fact);
  const utteranceTerms = topicBigrams(utterance);
  let overlap = 0;
  for (const term of factTerms) {
    if (!promptTerms.has(term) && utteranceTerms.has(term)) overlap += 1;
  }
  return overlap;
}

function normalizeAnswerSemantics(text: string): string {
  return text
    .replace(/旧住址|原住址|原地址|原来(?:的)?住处|以前的(?:地址|住处)/gu, '旧地址')
    .replace(/找着(?:了)?|寻到(?:了)?/gu, '找到')
    .replace(/收件人/gu, '收信人')
    .replace(/找到本人|找到对方/gu, '找到收信人')
    .replace(/把?(?:名字|姓名)对(?:了)?一遍|(?:名字|姓名)对上(?:了)?|确认(?:了)?(?:名字|姓名)|核实(?:了)?(?:名字|姓名)/gu, '核对姓名')
    .replace(/名字/gu, '姓名')
    .replace(/没(?:有)?办(?:成)?(?:派对|聚会|活动)?|(?:派对|聚会|活动)没(?:有)?办|没成行|未成行/gu, '活动取消')
    .replace(/没有|尚未|未/gu, '没');
}

function answerConcepts(text: string): Set<string> {
  const concepts = new Set<string>();
  const patterns: readonly [string, RegExp][] = [
    ['old-address', /旧地址/u],
    ['recipient', /收信人/u],
    ['verify-name', /核对姓名/u],
    ['reading-none', /没.{0,6}(?:读书|阅读|在读|看书)|(?:读书|阅读).{0,4}没/u],
    ['sprouted', /发芽|冒芽/u],
    ['not-bloomed', /没.{0,5}开花|还没开/u],
    ['cancelled', /活动取消|取消/u],
    ['gift-unfulfilled', /没.{0,5}(?:送|收到|送达)|未履约/u],
  ];
  for (const [concept, pattern] of patterns) if (pattern.test(text)) concepts.add(concept);
  return concepts;
}

function worldClaimReasons(context: DialogueQualityContext): string[] {
  const reasons: string[] = [];
  const sentences = context.utterance.split(/[。！？!?；\n]/u).map((item) => item.trim()).filter(Boolean);
  const clauses = sentences.flatMap((sentence) => {
    const parts = sentence.split(/[，,]/u).map((item) => item.trim()).filter(Boolean);
    const adjacent = parts.slice(1).map((part, index) => `${parts[index]}，${part}`);
    return [...parts, ...adjacent];
  });
  for (const clause of clauses) {
    const activity = activityNameIn(clause);
    if (activity && completedActivityClaim(clause) && !prospectiveClaim(clause) && !negatedPastClaim(clause)) {
      const requiredNames = claimParticipants(clause, context.speakerName, context.otherName);
      const supported = context.evidence.some((item) => (
        activityNameIn(item) === activity
        && /活动现场（已核验）|实际到场参加|实际共同参加|到场后共同参加/u.test(item)
        && requiredNames.every((name) => item.includes(name))
      ));
      if (!supported) reasons.push(`把没有现场到场证据的「${activity}」写成已参加`);
    }
    if (completedFlowerClaim(clause) && !prospectiveClaim(clause) && !negatedPastClaim(clause)) {
      const requiredNames = claimParticipants(clause, context.speakerName, context.otherName);
      const supported = context.evidence.some((item) => (
        /鲜花|花束|送花/u.test(item)
        && /花店订单（已履约）|配送.+交给|赠送鲜花|收到鲜花/u.test(item)
        && requiredNames.every((name) => item.includes(name))
      ));
      if (!supported) reasons.push('把没有履约证据的送花或收花意向写成已完成');
    }
    if (!activity && !completedFlowerClaim(clause) && completedSharedClaim(clause) && !prospectiveClaim(clause) && !negatedPastClaim(clause)) {
      const supported = context.evidence.some((item) => completedSharedEvidence(clause, item));
      if (!supported) reasons.push('把没有完成证据的共同经历写成已经发生');
    }
  }
  let anecdoteContext = false;
  for (const sentence of sentences) {
    let pastContext = anecdoteContext;
    for (const clause of sentence.split(/[，,]/u).map((item) => item.trim()).filter(Boolean)) {
      const firstPersonAnecdote = /(?:我)?(?:见过|遇到过|听说过)|(?:看|读|喝|吃|尝|收|送|搬|买|煮|磨|画|写)(?:了|过)|(?:我)?记得/u.test(clause);
      const explicitPast = /昨天|昨晚|那天|那晚|当晚|当时|上次|之前|过去|曾经|刚才|刚刚(?!好|巧)|刚(?!刚|才|好|巧)/u.test(clause);
      const narrativeContinuation = /后来|结果/u.test(clause);
      const returningCharacter = /回来后|(?:他|她|那人|年轻人).{0,6}回来/u.test(clause);
      if (firstPersonAnecdote || explicitPast || narrativeContinuation || (anecdoteContext && returningCharacter)) {
        pastContext = true;
        anecdoteContext = true;
      }
      const markerOnly = /^(?:我记得|记得|后来|结果|(?:关于|至于|说到)[^，。！？]{1,16})$/u.test(clause);
      const asksRatherThanClaims = /怎么|如何|什么|谁|哪|是否|有没有|吗$|呢$/u.test(clause);
      if (
        !pastContext
        || markerOnly
        || asksRatherThanClaims
        || prospectiveClaim(clause)
        || negatedPastClaim(clause)
        || completedFlowerClaim(clause)
        || (/^(?:送|收)(?:了|过)$/u.test(clause) && completedFlowerClaim(context.utterance) && fulfilledFlowerEvidence(context.evidence, context.speakerName, context.otherName))
        || pastClaimSupported(clause, context.evidence)
      ) continue;
      reasons.push('叙述无当前证据支持的过去事件');
    }
  }
  return reasons;
}

function workContentClaimSupported(claim: string, evidence: readonly string[]): boolean {
  const claimTerms = workContentTerms(claim);
  if (claimTerms.size === 0) return false;
  return evidence.some((item) => {
    if (!WORK_CONTENT_CLAIM.test(item) && !/(?:读书笔记|作品内容|书中内容|其中.{0,24}(?:观察|观点|讨论|描写))/u.test(item)) return false;
    const evidenceTerms = workContentTerms(item);
    let overlap = 0;
    for (const term of claimTerms) if (evidenceTerms.has(term)) overlap += 1;
    return overlap >= 2;
  });
}

function readingExperienceSupported(claim: string, evidence: readonly string[]): boolean {
  const title = claim.match(/《[^》]{1,40}》/u)?.[0];
  if (!title) return false;
  return evidence.some((item) => item.includes(title)
    && /(?:在读|正在读|读过|看过|读完|看完|读了|看了|阅读)/u.test(item)
    && !deniesReadingExperience(item));
}

function deniesReadingExperience(text: string): boolean {
  return /(?:没|没有|未|不曾|从未).{0,3}(?:在读|正在读|读过|看过|读[《这那]|看[《这那]|阅读过)/u.test(text);
}

function workContentTerms(text: string): Set<string> {
  return meaningfulBigrams(text
    .replace(/《[^》]{1,40}》/gu, ' ')
    .replace(/(?:这本书|书里|书中|里面|说|写(?:道|到)?|讲(?:到|的是)?|提到|认为|指出|描述|讨论|谈到)/gu, ' '));
}

function negatedPastClaim(text: string): boolean {
  return /没印象|不记得|记不(?:太)?清|想不起来|不清楚|不能确认|哪有|并非|不是|不对|从未|不曾|并未|并没有|没有|尚未|还没|取消|没办成|没成行/u.test(text)
    || /(?:不|没|未|无).{0,6}(?:去|到|参加|参与|看到|见到|送|收到|做|发生|画|读|看|喝|尝)/u.test(text);
}

function pastClaimSupported(claim: string, evidence: readonly string[]): boolean {
  const normalizedClaim = normalizeAnswerSemantics(claim);
  const claimTerms = meaningfulBigrams(normalizedClaim);
  return evidence.some((item) => {
    const normalizedEvidence = normalizeAnswerSemantics(item);
    const compactClaim = normalize(normalizedClaim);
    const compactEvidence = normalize(normalizedEvidence);
    if (compactClaim.length >= 4 && compactEvidence.includes(compactClaim)) return true;
    const evidenceTerms = meaningfulBigrams(normalizedEvidence);
    let overlap = 0;
    for (const term of claimTerms) if (evidenceTerms.has(term)) overlap += 1;
    return overlap >= 2 && (claimTerms.size <= 8 || overlap / claimTerms.size >= 0.34);
  });
}

function activityNameIn(text: string): string | null {
  if (/湖边派对|湖边聚会/u.test(text)) return '湖边派对';
  if (/书店读书会|读书会/u.test(text)) return '书店读书会';
  if (/广场集市|晚间集市/u.test(text)) return '广场集市';
  return text.match(/篝火晚会|音乐会|晚会|派对|聚会|市集|庆典|比赛|演出|展览|舞会|宴会|婚礼|会议|讲座|公益活动|节日活动/u)?.[0] ?? null;
}

function completedActivityClaim(text: string): boolean {
  return /参加(?:了|过)?|实际到场|一起(?:去|逛|参加)|共同(?:去|逛|参加)|去过|逛过|在.{0,8}(?:派对|聚会|读书会|集市)/u.test(text);
}

function completedFlowerClaim(text: string): boolean {
  return /(?:送给|送了|赠送|配送|托.{0,4}送).{0,12}(?:鲜花|花束|花)|(?:收到|收下|拿到).{0,12}(?:鲜花|花束|花)/u.test(text);
}

function completedSharedClaim(text: string): boolean {
  const shared = /我们|咱们|一起|共同|(?:我|你).{0,8}(?:和|跟)(?:你|我)/u.test(text);
  const completed = /昨天|昨晚|那天|上次|曾经|之前|(?:参加|去|逛|看|吃|喝|聊|玩|帮|送|收|合作|拜访|见|遇到|散步|完成)(?:了|过)/u.test(text);
  return shared && completed;
}

function completedSharedEvidence(claim: string, evidence: string): boolean {
  if (!/实际|已核验|已履约|完成|共同|一起|参加|对话|帮助|拜访|赠送|收到/u.test(evidence)) return false;
  const claimTerms = meaningfulBigrams(claim);
  const evidenceTerms = meaningfulBigrams(evidence);
  let overlap = 0;
  for (const term of claimTerms) if (evidenceTerms.has(term)) overlap += 1;
  return overlap >= 2;
}

function prospectiveClaim(text: string): boolean {
  return /想(?:要)?|打算|准备|计划|希望|邀请|要不要|可以(?:去|送|参加)|下次|将会|还没|尚未|没有/u.test(text);
}

function claimParticipants(text: string, speakerName: string, otherName: string): string[] {
  if (/我们|咱们|一起|共同/u.test(text)) return [speakerName, otherName];
  if (new RegExp(`(?:你|${escapeRegExp(otherName)}).{0,8}(?:参加|收到|收下|送)`, 'u').test(text)) return [otherName];
  return [speakerName];
}

function directlyAddresses(prompt: string, utterance: string, evidence: readonly string[]): boolean {
  if (isDialogueInvitation(prompt)) return INVITATION_RESPONSE.test(utterance) || INVITATION_CLARIFICATION.test(utterance);
  if (expressesUnknownDetail(utterance)) return true;
  if (asksRecipientIdentity(prompt)) return coversAnswerEvidence(utterance, evidence, prompt);
  const detail = requestedScalarDetail(prompt);
  if (detail) return evidence.some((fact) => scalarDetailSupported(detail, utterance, fact));
  if (asksReadingDetail(prompt) && answersRequestedDetail(prompt, utterance)
    && evidence.some((fact) => answersRequestedDetail(prompt, fact) && pastClaimSupported(utterance, [fact]))) return true;
  if (/过得(?:怎么样|怎样|如何)|(?:你|您)(?:今天|最近)?(?:好吗|还好吗)|心情(?:怎么样|如何)/u.test(prompt)
    && /很好|挺好|还好|不错|还行|不太好|有些累|有点累|开心|难过|心情/u.test(utterance)) return true;
  const obligations = falsePremiseObligations(prompt, evidence);
  if (obligations.length && obligations.every((item) => correctsFalsePremise(utterance, item.kind))) return true;
  if (/不(?:太)?清楚|想不起|记不清|不记得|说不准|还不确定|没有形成明确看法|判断还不成熟/u.test(utterance)) return true;
  if (SUBJECTIVE_QUESTION.test(prompt) && /我(?:想|认为|觉得|更|最)|因为/u.test(utterance)) return true;
  const promptBigrams = meaningfulBigrams(prompt);
  if (promptBigrams.size === 0) return utterance.trim().length >= 4;
  if (setsOverlap(promptBigrams, meaningfulBigrams(utterance))) return true;
  if (semanticBridge(prompt, utterance)) return true;
  for (const fact of evidence) {
    const factBigrams = meaningfulBigrams(fact);
    if (setsOverlap(promptBigrams, factBigrams)
      && evidenceSpecificOverlap(normalizeAnswerSemantics(prompt), normalizeAnswerSemantics(fact), normalizeAnswerSemantics(utterance)) >= 2) return true;
  }
  return false;
}

function pragmaticallyContinues(prompt: string, utterance: string, evidence: readonly string[]): boolean {
  if (isDialogueInvitation(prompt)) return directlyAddresses(prompt, utterance, evidence);
  if (/先聊到这里|改天.*聊|下次.*聊|再见|回头见/u.test(utterance)) return true;
  if (/不清楚|想不起|记不清|说不准|不确定/u.test(prompt) && /没关系|不用急|慢慢想/u.test(utterance)) return true;
  if (QUESTION.test(prompt)) return directlyAddresses(prompt, utterance, evidence);
  if (/在读|阅读|《[^》]+》/u.test(prompt) && /(?:这|那)本书/u.test(utterance) && QUESTION.test(utterance)) return true;
  if (/咖啡|手冲|无糖|不加糖/u.test(prompt) && /(?:这|那)(?:种|个)口味/u.test(utterance) && QUESTION.test(utterance)) return true;
  if (topicOverlap(prompt, utterance) || evidenceBridge(prompt, utterance, evidence)) return true;
  if (semanticBridge(prompt, utterance)) return true;

  const acknowledgement = utterance.trim().match(ACKNOWLEDGEMENT);
  if (acknowledgement) {
    const remainder = utterance.trim().slice(acknowledgement[0].length).replace(/^[，。！？!?\s]+/u, '').trim();
    if (normalize(remainder).length <= 8) return true;
    if (/你.{0,16}(?:为什么会留意|心里是什么感觉|愿意再说说|愿意说说).{0,8}[？?]/u.test(remainder)) return true;
    return topicOverlap(prompt, remainder) || semanticBridge(prompt, remainder);
  }

  if (INVITATION.test(utterance.trim())) {
    return CONVERSATION_INVITATION.test(utterance)
      || topicOverlap(prompt, utterance)
      || semanticBridge(prompt, utterance);
  }
  return false;
}

function questionFocus(prompt: string): string {
  if (!/[？?]\s*$/u.test(prompt)) return prompt;
  const last = prompt.split(/[。！？!?；]/u).map((part) => part.trim()).filter(Boolean).at(-1);
  return last ? `${last}？` : prompt;
}

function topicOverlap(left: string, right: string): boolean {
  return setsOverlap(topicBigrams(left), topicBigrams(right));
}

function topicBigrams(text: string): Set<string> {
  let normalized = normalize(text);
  for (const phrase of TOPIC_STOP_PHRASES) normalized = normalized.replaceAll(phrase, ' ');
  const terms = new Set<string>();
  for (const segment of normalized.split(/\s+/u).filter(Boolean)) {
    for (const gram of bigrams(segment)) if (!STOP_BIGRAMS.has(gram)) terms.add(gram);
  }
  return terms;
}

function evidenceBridge(prompt: string, utterance: string, evidence: readonly string[]): boolean {
  return evidence.some((fact) => topicOverlapCount(prompt, fact) >= 2 && topicOverlapCount(fact, utterance) >= 2);
}

function topicOverlapCount(left: string, right: string): number {
  const leftTerms = topicBigrams(left);
  const rightTerms = topicBigrams(right);
  let overlap = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) overlap += 1;
  return overlap;
}

function semanticBridge(prompt: string, utterance: string): boolean {
  const pairs: readonly [RegExp, RegExp][] = [
    [/累|疲惫|困|忙|辛苦/u, /休息|歇一歇|坐坐|缓一缓|帮忙|陪你/u],
    [/难过|担心|焦虑|害怕|生气|委屈/u, /听你说|陪你|别担心|慢慢说|理解/u],
    [/开心|高兴|顺利|完成|做好/u, /太好了|庆祝|替你高兴|真不错/u],
    [/饿|吃饭|饭菜|午饭|晚饭/u, /吃|饭|餐|做饭/u],
    [/读书|阅读|书|作品/u, /读|书|书店|推荐/u],
    [/画展|画画|速写|作品|构图/u, /画|展|颜色|光线|阴影|构图/u],
    [/咖啡|手冲|烘焙/u, /咖啡|杯|豆|配方|口感/u],
    [/年轻|匆匆|忙|赶路|脚步/u, /年轻|匆匆|忙|慢|急|赶|脚步|日子|时间/u],
  ];
  return pairs.some(([source, response]) => source.test(prompt) && response.test(utterance));
}

function advancesConversationArc(prompt: string, utterance: string, evidence: readonly string[]): boolean {
  if (QUESTION.test(utterance)) return true;
  if (QUESTION.test(prompt) && directlyAddresses(prompt, utterance, evidence)) return true;
  if (/要不要|不如|可以试试|我们可以|我可以|打算|准备|下次|愿不愿意|需不需要/u.test(utterance)) return true;
  if (/^(?:好|好啊|可以|行|当然|愿意|不了|不行|恐怕|抱歉|谢谢|没关系)[，。！？!?\s]/u.test(utterance.trim())) return true;
  if (/先聊到这里|下次再聊|改天再聊|回头见|再见|我得先|我要先/u.test(utterance)) return true;
  if (evidence.some((fact) => topicOverlap(fact, utterance))) return true;
  return /今天|刚才|刚刚|上午|下午|晚上|明天|昨天|第\s*\d+\s*天|\d{1,2}[：:]\d{2}/u.test(utterance)
    && /做|看|听|读|写|画|送|收到|完成|发现|遇到|处理|决定/u.test(utterance);
}

function nearRepeat(utterance: string, prior: string, isLatest: boolean): boolean {
  const normalized = normalize(utterance);
  const priorNormalized = normalize(prior);
  if (!normalized || !priorNormalized) return false;
  const similarity = diceSimilarity(normalized, priorNormalized);
  if (normalized === priorNormalized || similarity >= 0.86) return true;
  // 回答可以自然复用上一句问题的关键词，但不能复写陈述或更早的会话台词。
  if (isLatest && QUESTION.test(prior)) return false;
  if (similarity >= 0.66) return true;

  const currentTerms = meaningfulBigrams(utterance);
  const priorTerms = meaningfulBigrams(prior);
  let overlap = 0;
  for (const term of currentTerms) if (priorTerms.has(term)) overlap += 1;
  const smaller = Math.min(currentTerms.size, priorTerms.size);
  if (overlap >= 5 && smaller > 0 && overlap / smaller >= 0.54) return true;

  const currentTitles = new Set([...utterance.matchAll(/《[^》]{1,40}》/gu)].map((match) => match[0]));
  const repeatsTitle = [...prior.matchAll(/《[^》]{1,40}》/gu)].some((match) => currentTitles.has(match[0]));
  const repeatsPlacement = /书架|社会学区|小说区|放回|归位|放对/u.test(utterance)
    && /书架|社会学区|小说区|放回|归位|放对/u.test(prior);
  if (repeatsTitle && repeatsPlacement) return true;

  const sharedFacts = FACT_MOTIFS.filter((motif) => motif.test(utterance) && motif.test(prior)).length;
  if (sharedFacts >= 3) return true;

  const sharedMotifs = SEMANTIC_MOTIFS.filter((motif) => motif.test(utterance) && motif.test(prior)).length;
  return sharedMotifs >= 3 || (sharedMotifs >= 2 && METAPHOR.test(utterance) && METAPHOR.test(prior));
}

function setsOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function meaningfulBigrams(text: string): Set<string> {
  const grams = bigrams(normalize(text));
  for (const stop of STOP_BIGRAMS) grams.delete(stop);
  return grams;
}

function bigrams(text: string): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) result.add(text.slice(index, index + 2));
  return result;
}

function diceSimilarity(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size === 0 || b.size === 0) return left === right ? 1 : 0;
  let overlap = 0;
  for (const gram of a) if (b.has(gram)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}

function normalize(text: string): string {
  return text.toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]/gu, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
