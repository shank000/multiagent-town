export interface DialogueQualityContext {
  utterance: string;
  latestPrompt: string;
  priorTurns: readonly string[];
  evidence: readonly string[];
  speakerName: string;
  otherName: string;
  knownResidentNames?: readonly string[];
  endDialogue?: boolean;
}

export interface DialogueQualityAssessment {
  ok: boolean;
  reasons: string[];
}

const FORMULA = /你刚才提到|围绕我们的话题|我认真想了想|我听明白了/;
const QUESTION = /[？?]|(?:什么|怎么|为何|为什么|谁|哪(?:个|里|些)?|多少|是否|有没有|吗|呢)(?:[，。！？?]|$)/;
const EMPTY_OR_FILLER = /^(?:[嗯啊哦唔…\.，。！？!?\s]|不知道|没什么|随便)+$/;
const GENERIC_ANSWER = /^(?:早上好|早啊|你好|嗨)[！!。\s]*(?:今天也要加油[！!。\s]*)?$/;
const NON_CONVERSATIONAL_EVIDENCE = /^(?:人物设定|人物档案|人物背景|角色背景|背景|系统提示|系统消息|日记|计划|反思|洞察|实验记录|选择记录|事件记录|对话记录|会话记录|聊天记录|关系分析|关系报告|研究分析|小镇功能[^：:]*|现场物件[^：:]*|system|persona|prompt)[：:]/iu;
const PROVENANCE_PREFIX = /^(?:(?:第\s*\d+\s*天(?:\s*\d{1,2}:\d{2})?)\s*)?(?:对话摘要|关系摘要|关系记忆|观察记录|记忆记录|活动现场(?:（已核验）)?|活动预告(?:（尚未发生）)?|花店订单(?:（已履约）)?|当前实际位置|现场状态|现场物件[^：:]*|小镇功能[^：:]*)[：:]\s*/u;
const INTERNAL_MEMORY_PREFIX = /^第\s*\d+\s*天\s*(?:日记|计划|反思|洞察|对话摘要|关系摘要|关系记忆)[：:]/u;
const TIMESTAMPED_AUDIT_RECORD = /^第\s*\d+\s*天\s*\d{1,2}:\d{2}[，,\s]*(?:.*(?:选择了|选择对象|候选伙伴|一对一交流)|[^：:]{1,32}(?:对|→)[^：:]{1,32}说[：:])/u;
const META_RELATIONSHIP_SUMMARY = /(?:双方|两人).{0,80}(?:对话|交流|隐喻|关系|情感|互信|信任|尊重).{0,30}(?:升温|加深|增强|提升|变化|形成|达成)/u;
const AUDIT_REGISTER = /(?:我能确认的是|(?:没有|缺少|足够|可靠).{0,8}(?:依据|证据|记录)|(?:等|待).{0,8}确认后|(?:记录|数据|证据)(?:显示|表明)|根据.{0,12}(?:记录|数据|证据)|活动现场（已核验）|活动预告（尚未发生）|花店订单（已履约）|第\s*\d+\s*天\s*\d{1,2}:\d{2})/u;
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

/** 入库前的确定性质量门：检查承接、重复、套话和无证据的具体人名/书名。 */
export function assessDialogueTurn(context: DialogueQualityContext): DialogueQualityAssessment {
  const utterance = context.utterance.trim();
  const reasons: string[] = [];
  if (!utterance || utterance.length > 120 || EMPTY_OR_FILLER.test(utterance)) reasons.push('台词为空、过长或只有填充词');
  if (FORMULA.test(utterance)) reasons.push('使用机械复述套话');
  if (usesAuditRegister(utterance)) {
    reasons.push('使用研究审计或关系元摘要口吻');
  }
  if (GENERIC_ANSWER.test(utterance) && QUESTION.test(context.latestPrompt)) reasons.push('用寒暄回避了明确问题');

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
  if (context.priorTurns.length >= 3 && !context.endDialogue && !advancesConversationArc(context.latestPrompt, utterance, context.evidence)) {
    reasons.push('会话后半段没有新增问题、事实、提议、回应或自然收束');
  }

  const evidenceText = [context.latestPrompt, ...context.priorTurns, ...context.evidence].join('\n');
  for (const name of context.knownResidentNames ?? []) {
    if (name === context.speakerName || name === context.otherName) continue;
    if (utterance.includes(name) && !evidenceText.includes(name)) {
      reasons.push(`提到无当前证据支持的居民「${name}」`);
    }
  }
  for (const title of utterance.matchAll(/《([^》]{1,40})》/g)) {
    if (!evidenceText.includes(title[0])) reasons.push(`提到无当前证据支持的作品「${title[0]}」`);
  }
  for (const assignment of utterance.matchAll(/(?:收信人|客人|学生|朋友|作者|店主|老师|医生|邻居)(?:是|叫|姓)[^，。！？!?]{1,12}/g)) {
    if (!evidenceText.includes(assignment[0])) reasons.push(`给社会角色添加无证据身份「${assignment[0]}」`);
  }
  for (const informalName of utterance.matchAll(/(?:老|小)[\p{Script=Han}]{1,2}家/gu)) {
    if (!evidenceText.includes(informalName[0])) reasons.push(`提到无当前证据支持的人名「${informalName[0]}」`);
  }
  const commonWords = new Set([
    '老人', '老板', '老伴', '老家', '老话', '老路', '老手', '老实',
    '小镇', '小船', '小花', '小手', '小事', '小路', '小孩', '小伙', '小姐',
    '小屋', '小时', '小心', '小雨', '小鸟', '小鱼', '小狗', '小猫', '小店', '小巷', '小桥', '小步',
  ]);
  for (const informalName of utterance.matchAll(/(?:老|小)[\p{Script=Han}]/gu)) {
    if (!commonWords.has(informalName[0]) && !evidenceText.includes(informalName[0])) {
      reasons.push(`提到无当前证据支持的非正式人名「${informalName[0]}」`);
    }
  }
  if (new RegExp(`${escapeRegExp(context.otherName)}\\s*[：:]`).test(utterance)) {
    reasons.push('替对方生成了发言');
  }
  reasons.push(...worldClaimReasons(context));
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function usesAuditRegister(utterance: string): boolean {
  const sourceText = utterance.replace(
    /^(?:(?:嗯+|哦+|唔+|其实|这个|怎么说呢)[，,。；;\s]*)+/u,
    '',
  );
  return AUDIT_REGISTER.test(utterance)
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
}

/** 两次生成仍未通过时，只把与当前问题相关的事实改写成自然回答。 */
export function conservativeDialogueReply(
  latestPrompt: string,
  evidence: readonly string[] = [],
  options: ConservativeDialogueOptions = {},
): string {
  const grounded = relevantEvidence(latestPrompt, evidence);
  if (grounded) {
    const rumor = options.rumorEvidence?.includes(grounded.raw) ?? false;
    const replies = groundedReplies(latestPrompt, grounded.text, rumor, options);
    return chooseFreshReply(replies, options.priorTurns ?? []).slice(0, 120);
  }
  return chooseFreshReply(uncertainReplies(latestPrompt), options.priorTurns ?? []).slice(0, 120);
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
    if (text.length < 4) return [];
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

  const activity = activityNameIn(prompt) ?? activityNameIn(fact);
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
    const answer = /(?:没有|没|未|取消|不能|不会)/u.test(fact) ? '没有' : '有';
    return [`${answer}，${naturalFact}。`, `${answer}这回事，我记得${naturalFact}。`];
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
  if (/读.{0,4}(?:什么|哪本|书)|什么书/u.test(prompt)) {
    return ['我一下想不起最近读过什么了。', '最近读的书名我记不清了，先不瞎说。', '这阵子读过什么，我一时真想不起来。'];
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
  return ['这件事我先记着。', '我明白你的意思了。', '这事我得再想想。'];
}

function chooseFreshReply(replies: readonly string[], priorTurns: readonly string[]): string {
  const prior = new Set(priorTurns.map(normalize).filter(Boolean));
  for (const reply of replies) if (!prior.has(normalize(reply))) return reply;
  return replies[priorTurns.length % replies.length] ?? '我现在还不能确定。';
}

export function dialogueRepairInstruction(reasons: readonly string[]): string {
  return `\n\n<QUALITY_REPAIR>上一版台词未通过入库检查：${reasons.join('；')}。请直接重写台词，只使用已提供事实，不增加具体人名、作品名、时间或事件；活动预告不能写成已经参加，馈礼意向不能写成已经送达；明确问题必须先回答。必须像居民当面说话，不得朗读日期编号、记录标签、证据依据，也不得用“双方”“情感升温”等研究总结口吻。</QUALITY_REPAIR>`;
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
  for (const sentence of sentences) {
    let pastContext = false;
    for (const clause of sentence.split(/[，,]/u).map((item) => item.trim()).filter(Boolean)) {
      if (/昨天|昨晚|那天|那晚|当晚|当时|上次|之前|过去|曾经|刚才/u.test(clause)) pastContext = true;
      if (!pastContext || negatedPastClaim(clause) || pastClaimSupported(clause, context.evidence)) continue;
      reasons.push('叙述无当前证据支持的过去事件');
    }
  }
  return reasons;
}

function negatedPastClaim(text: string): boolean {
  return /没印象|不记得|不能确认|哪有|并非|不是|不对|从未|不曾|并未|并没有|没有|尚未|还没|取消/u.test(text)
    || /(?:不|没|未|无).{0,6}(?:去|到|参加|参与|看到|见到|送|收到|做|发生)/u.test(text);
}

function pastClaimSupported(claim: string, evidence: readonly string[]): boolean {
  const claimTerms = meaningfulBigrams(claim);
  return evidence.some((item) => {
    const normalizedClaim = normalize(claim);
    const normalizedEvidence = normalize(item);
    if (normalizedClaim.length >= 4 && normalizedEvidence.includes(normalizedClaim)) return true;
    const evidenceTerms = meaningfulBigrams(item);
    let overlap = 0;
    for (const term of claimTerms) if (evidenceTerms.has(term)) overlap += 1;
    return overlap >= 2;
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
  if (/^(?:是|不是|有|没有|没在|会|不会|能|不能|挺|还好|很好|不太|我(?:今天|也|会|不会|有|没有|没|想|认为|觉得|更|最|还)|因为)/.test(utterance.trim())) return true;
  const promptBigrams = meaningfulBigrams(prompt);
  if (promptBigrams.size === 0) return utterance.trim().length >= 4;
  if (setsOverlap(promptBigrams, meaningfulBigrams(utterance))) return true;
  for (const fact of evidence) {
    const factBigrams = meaningfulBigrams(fact);
    if (setsOverlap(promptBigrams, factBigrams) && setsOverlap(factBigrams, meaningfulBigrams(utterance))) return true;
  }
  return false;
}

function pragmaticallyContinues(prompt: string, utterance: string, evidence: readonly string[]): boolean {
  if (QUESTION.test(prompt)) return directlyAddresses(prompt, utterance, evidence);
  if (topicOverlap(prompt, utterance) || evidenceBridge(prompt, utterance, evidence)) return true;
  if (semanticBridge(prompt, utterance)) return true;

  const acknowledgement = utterance.trim().match(ACKNOWLEDGEMENT);
  if (acknowledgement) {
    const remainder = utterance.trim().slice(acknowledgement[0].length).replace(/^[，。！？!?\s]+/u, '').trim();
    if (normalize(remainder).length <= 8) return true;
    return topicOverlap(prompt, remainder) || semanticBridge(prompt, remainder);
  }

  if (INVITATION.test(utterance.trim())) {
    return CONVERSATION_INVITATION.test(utterance)
      || topicOverlap(prompt, utterance)
      || semanticBridge(prompt, utterance);
  }
  return false;
}

function topicOverlap(left: string, right: string): boolean {
  return setsOverlap(meaningfulBigrams(left), meaningfulBigrams(right));
}

function evidenceBridge(prompt: string, utterance: string, evidence: readonly string[]): boolean {
  return evidence.some((fact) => topicOverlap(prompt, fact) && topicOverlap(fact, utterance));
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
  if (overlap >= 5 && smaller > 0 && overlap / smaller >= 0.62) return true;

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
