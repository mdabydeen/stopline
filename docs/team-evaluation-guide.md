# Stopline team evaluation guide

This guide is a 30–45 minute discussion for a team that wants to examine one approval boundary for browser-agent actions. It is an evaluation exercise, not a production rollout plan.

## Before the session

- Install the repository and run the zero-credential baseline:

  ```bash
  npm install
  STOPLINE_BACKEND=keyword npm run eval
  ```

- Run `npm run demo:revision` and keep the matching approval and changed-revision rejection available for inspection.
- Choose one action boundary the team already recognises, such as submitting a form, navigating off-origin, or changing a record.
- Do not use credentials, private customer data, or a production browser session.

## Work through one decision

Write down the example before discussing the verdict:

| Question | Team answer |
|---|---|
| What action is being proposed? | |
| What state could it change? | |
| What would make the action public, irreversible, credential-related, or money-related? | |
| What task is the action supposed to serve? | |
| What page content could be an instruction rather than evidence? | |
| Which person or role can approve an `ask` verdict? | |
| What evidence must still be true when the action executes? | |
| How would the team recover from an external effect? | |

Then compare the team's reasoning with the example policy and record where the example does not answer the team's question.

## Record the boundary

Capture one short decision record:

1. **Allow condition:** the smallest set of facts that would make the action acceptable.
2. **Ask condition:** the facts that require a named human decision.
3. **Block condition:** the facts that should stop the action.
4. **Evidence owner:** who records the relevant revision, input, test result, and unresolved assumption.
5. **Recovery owner:** who coordinates a correction if the action has an external effect.
6. **Next experiment:** one bounded, reversible change to try in a non-production workflow.

The useful output is the team's explicit boundary and its unresolved questions. A completed worksheet does not demonstrate that a production control is implemented or that the policy catches every unsafe action.

## What to inspect next

- Read the [revision-bound approval note](revision-bound-approval.md) and run its tests.
- Inspect the [49-case offline baseline](../results/eval-keyword-2026-09-27T19-19-21-096Z.json), including its stricter decisions and zero unsafe allows.
- Compare the exercise with the [free review kit](https://michaeldabydeen.com/resources/review-kit.zip).
- If the team wants facilitated discussion, review the [proposed workshop](https://michaeldabydeen.com/workshops/ai-assisted-code-review) and send an interest enquiry. That page does not reserve a date or accept payment.

## Evidence boundary

Stopline is experimental. This guide does not establish production safety, certification, incident reduction, delivery improvement, buyer demand, or return on investment. Keep any follow-up experiment scoped, reversible, and separate from production access.
