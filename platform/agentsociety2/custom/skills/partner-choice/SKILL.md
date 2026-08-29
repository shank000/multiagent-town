---
name: partner-choice
description: Complete the daily equal-candidate partner-choice task using only the condition-controlled observation.
---

# Partner Choice

## When to use

Use once per simulation step when the partner-choice environment reports an open round.

## Causal-isolation rule

Make this decision only from the JSON returned by `observe_partner_round` and your stable self profile. Do not read `AGENT_MEMORY.md`, episode files, relationship files, earlier tool logs, or other workspace history for this choice. Do not infer hidden relationship state from candidate ordering: ordering is paired across treatment arms.

## Execution

1. Call the environment observation tool `observe_partner_round` for your own agent ID.
2. If `roundOpen` is false or `alreadySubmitted` is true, finish the step without another submission.
3. Read every candidate in the returned order. Choose exactly one candidate ID. Use the same judgment procedure in every condition; history content may differ, but the procedure and output shape do not.
4. Call `submit_partner_choice` once with your own ID, the selected candidate ID, a concise rationale grounded only in visible fields, and the exact JSON choice object as `raw_response`.
5. If the environment returns `invalid_candidate`, correct the ID using the returned candidate list and retry once. For any other structured error, finish and let the environment's seeded fallback handle the deadline.

## Choice object

```json
{
  "chosenId": "candidate ID from the observation",
  "rationale": "one concise reason using only visible observation content"
}
```

Never mention affection scores, interaction counts, gifts, or prior encounters unless those facts occur in the returned candidate history.
