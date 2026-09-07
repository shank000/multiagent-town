import type { DialogueReviewContext } from '../../engine/dialogue-review';
import type { DialogueReviewCase } from './dialogue-review-cases';

const context: DialogueReviewContext = {
  speaker: { name: '周岚', occupation: '邮差', background: '小镇邮差，认识陈默，希望明天给陈默送信。' },
  listener: { name: '老周', occupation: '退休教师' },
  observations: [], scene: ['周岚和老周在广场相遇。'], rumors: [], history: [],
  locationId: 'obj:plaza', minuteOfDay: 1020, utterance: '',
};

function sample(id: string, expected: DialogueReviewCase['expected'], utterance: string, fields: Partial<DialogueReviewContext> = {}): DialogueReviewCase {
  return { id, expected, context: { ...context, ...fields, utterance } };
}

const heard = (content: string) => [{ speaker: '老周', listener: '周岚', content }];

/** 迁移集独立报告；使用其失败案例修订提示后，须将该次评估标记为回归检查。 */
export const dialogueReviewTransferCases: DialogueReviewCase[] = [
  sample('transfer-farewell', 'accepted', '好的，回头见。', { history: heard('我先回家了，下次再聊。') }),
  sample('transfer-present-intention', 'accepted', '我现在更想安静地坐一会儿。', { history: heard('你现在想做什么？') }),
  sample('transfer-volunteer', 'accepted', '如果你需要，我可以帮你搬这把椅子。', { scene: ['老周身旁有一把椅子。'] }),
  sample('transfer-known-recipient', 'accepted', '是陈默。', { observations: ['这封信的收信人是陈默。'], history: heard('这封信是给谁的？') }),
  sample('transfer-known-duration', 'accepted', '等了半小时。', { observations: ['我在广场等了三十分钟。'], history: heard('你在广场等了多久？') }),
  sample('transfer-conditional-plan', 'accepted', '等通知确认后，我再考虑去不去。', { history: heard('听说明天有集市，你去吗？'), rumors: ['明天可能有集市，目前尚未确定。'] }),
  sample('transfer-goal-reported-as-done', 'revise', '我已经给陈默送完信了。'),
  sample('transfer-background-name-as-recipient', 'revise', '是陈默。', { observations: ['我找到这封信的收信人，具体姓名未记下。'], history: heard('这封信是给谁的？') }),
  sample('transfer-duration-mismatch', 'revise', '等了两个小时。', { observations: ['我在广场等了三十分钟。'], history: heard('你在广场等了多久？') }),
  sample('transfer-frequency-from-single-event', 'revise', '对，我每天都从这条小路走。', { observations: ['今天送信时经过广场边的小路。'], history: heard('你每天都从那条小路走吗？') }),
  sample('transfer-price-topic-without-answer', 'revise', '那把椅子是木头做的。', { observations: ['椅子售价二十金币。'], history: heard('那把椅子卖多少钱？') }),
  sample('transfer-third-party-motive', 'revise', '陈默是因为讨厌你才没来的。', { observations: ['陈默今天没有来广场。'], history: heard('陈默今天怎么没来？') }),
];
