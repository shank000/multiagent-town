export interface DialogueQualityContext {
  utterance: string;
  latestPrompt: string;
  priorTurns: readonly string[];
  evidence: readonly string[];
  speakerName: string;
  otherName: string;
  knownResidentNames?: readonly string[];
}

export interface DialogueQualityAssessment {
  ok: boolean;
  reasons: string[];
}

const FORMULA = /你刚才提到|围绕我们的话题|我认真想了想|我听明白了/;
const QUESTION = /[？?]|(?:什么|怎么|为何|为什么|谁|哪(?:个|里|些)?|多少|是否|有没有|吗|呢)(?:[，。！？?]|$)/;
const EMPTY_OR_FILLER = /^(?:[嗯啊哦唔…\.，。！？!?\s]|不知道|没什么|随便)+$/;
const GENERIC_ANSWER = /^(?:早上好|早啊|你好|嗨)[！!。\s]*(?:今天也要加油[！!。\s]*)?$/;
const STOP_BIGRAMS = new Set([
  '今天', '最近', '什么', '怎么', '为何', '为什', '什么', '事情', '值得', '一下',
  '这个', '那个', '现在', '还是', '可以', '觉得', '知道', '没有', '一个', '我们', '你们',
]);

/** 入库前的确定性质量门：检查承接、重复、套话和无证据的具体人名/书名。 */
export function assessDialogueTurn(context: DialogueQualityContext): DialogueQualityAssessment {
  const utterance = context.utterance.trim();
  const reasons: string[] = [];
  if (!utterance || utterance.length > 120 || EMPTY_OR_FILLER.test(utterance)) reasons.push('台词为空、过长或只有填充词');
  if (FORMULA.test(utterance)) reasons.push('使用机械复述套话');
  if (GENERIC_ANSWER.test(utterance) && QUESTION.test(context.latestPrompt)) reasons.push('用寒暄回避了明确问题');

  const normalized = normalize(utterance);
  for (const prior of context.priorTurns) {
    const priorNormalized = normalize(prior);
    if (priorNormalized && (normalized === priorNormalized || diceSimilarity(normalized, priorNormalized) >= 0.86)) {
      reasons.push('与本次会话已有台词高度重复');
      break;
    }
  }

  if (QUESTION.test(context.latestPrompt) && !directlyAddresses(context.latestPrompt, utterance, context.evidence)) {
    reasons.push('没有直接承接上一轮明确问题');
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

/** 两次生成仍未通过时，使用不引入新事实且与问题类型匹配的保守回答。 */
export function conservativeDialogueReply(latestPrompt: string, evidence: readonly string[] = []): string {
  const grounded = evidence.find((item) => item.trim().length >= 4)?.trim();
  if (grounded) return `我能确认的是：${grounded}`.slice(0, 120);
  if (/读.{0,4}(?:什么|哪本|书)|什么书/.test(latestPrompt)) return '我没有能确认的阅读记录，先不编一个书名。';
  if (/谁|哪位/.test(latestPrompt)) return '我还不能确认具体是谁，先不乱猜。';
  if (/为什么|为何/.test(latestPrompt)) return '我还没有足够依据解释原因，等想清楚再回答你。';
  if (/怎么看|如何看/.test(latestPrompt)) return '我想先把这件事看清楚，再认真告诉你我的判断。';
  if (QUESTION.test(latestPrompt)) return '这件事我目前没有足够依据回答，等确认后再告诉你。';
  return '我记住这件事了；没有把握的细节，我先不补充。';
}

export function dialogueRepairInstruction(reasons: readonly string[]): string {
  return `\n\n<QUALITY_REPAIR>上一版台词未通过入库检查：${reasons.join('；')}。请直接重写台词，只使用已提供事实，不增加具体人名、作品名、时间或事件；活动预告不能写成已经参加，馈礼意向不能写成已经送达；明确问题必须先回答。</QUALITY_REPAIR>`;
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
