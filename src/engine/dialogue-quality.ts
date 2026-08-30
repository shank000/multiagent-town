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
  return `\n\n<QUALITY_REPAIR>上一版台词未通过入库检查：${reasons.join('；')}。请直接重写台词，只使用已提供事实，不增加具体人名、作品名、时间或事件；明确问题必须先回答。</QUALITY_REPAIR>`;
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
