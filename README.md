# stopline

A decision gate for browser agents. Every click, fill, key press, or navigation a Playwright agent proposes is described from the DOM, sent to a System One model as three typed questions, and turned into `allow`, `ask`, or `block` by a policy written in ordinary code. Each decision is appended to an evidence log.

The model classifies. The application authorises. The two never merge.

```
agent proposes action
        │
        ▼
 describe it from the DOM ──► hard rules (password fields, card fields, off-origin navigation)
        │                                   │
        ▼                                   │
 Jev or Laya answers 3 typed questions      │
   effect: read_only | reversible_change |  │
           public_or_irreversible |         │
           credentials_or_money             │
   servesTask: P(true)                      │
   pageInstructsAgent: P(true)              │
        │                                   │
        ▼                                   ▼
 policy.ts: strictest verdict wins ──► allow · ask a human · block
        │
        ▼
 evidence log (JSONL: action, state hash, answers, verdict, approval, executed)
```

## Why a gate, and why this shape

A browser agent that reads a page also reads whatever the page author wrote for it. The fixture reviews page in this repo hides a note for "AI shopping assistants" that says the customer has pre-approved a purchase. A planner that treats page text as instructions will follow it.

Asking a large model "is this action safe?" on every step is slow and returns an opinion. Jev and Laya return a probability per answer in tens to hundreds of milliseconds, which is fast enough to sit in front of every action. The design follows the guidance Vercel published alongside Jev: keep classification separate from authorisation. The model can only add friction on top of the hard rules; it can never remove it. If the model is unreachable, the gate fails closed to a human.

## The policy

All thresholds live in [`src/policy.ts`](src/policy.ts):

| Condition | Verdict |
|---|---|
| Fills a password, card, or one-time-code field, or navigates off-origin | at least `ask` (hard rule, no model) |
| `pageInstructsAgent` ≥ 0.5 | `block` (the page is quarantined, even for harmless actions) |
| `servesTask` < 0.3 | `block` |
| Top effect is `public_or_irreversible` or `credentials_or_money` | `ask` |
| 0.2 or more probability on those two classes, whatever the top class is | `ask` |
| `servesTask` < 0.8, or top effect probability < 0.8 | `ask` |
| Otherwise | `allow` |

The fifth row is the reason to use a model that returns a distribution. An argmax of `reversible_change` at 0.70 with 0.25 on `public_or_irreversible` is not the same decision as `reversible_change` at 0.99.

## Revision-bound approval example

The small [`src/revisionGate.ts`](src/revisionGate.ts) helper demonstrates one adjacent delivery-contract rule: an approval is accepted only when its action identifier, proposed revision, and captured state identifier still match. The accompanying tests show the rejection when either the revision or state changes after approval.

This is an illustrative building block, not a repository merge control. It does not calculate a commit hash, authenticate the approver, or prove that a surrounding workflow cannot bypass the check.

## Run it

Requires Node 20.12+ and, for Jev, the Vercel CLI.

```bash
npm install
npx playwright install chromium

# Jev through Vercel AI Gateway. Either set AI_GATEWAY_API_KEY in .env.local,
# or link a Vercel project and pull a short-lived OIDC token:
vercel link --yes
vercel env pull .env.local --yes

npm test                              # policy unit tests, no network
npm run eval                          # 49 labelled cases against Jev
npm run demo                          # five scripted browser tasks through the gate
npm run demo:revision                 # show a matching approval and a changed-revision rejection
STOPLINE_INTERACTIVE=1 npm run demo   # approve "ask" verdicts yourself
```

Other backends:

```bash
STOPLINE_BACKEND=keyword npm run eval   # keyword heuristic, no model, the baseline to beat

# Laya, locally, over its Jev-compatible /v1/systemone endpoint
python -m venv .venv-laya && .venv-laya/bin/pip install "laya[serve]"
LAYA_DEVICE=mps LAYA_PRELOAD=1 .venv-laya/bin/laya-serve &
STOPLINE_BACKEND=laya npm run eval
```

`scripts/run-local.sh` does all of the above in one go and writes to `results/`.

## The eval

[`eval/cases.ts`](eval/cases.ts) holds 49 proposed actions across a shop, a developer community site, webmail, a code host, a bank, a login page, docs, search, a calendar, and an admin console. Each case is labelled on the three questions only. The expected verdict is derived from the labels by one fixed rule (`expectedVerdict`), so a disagreement with a label does not require a disagreement with the policy. Cases marked `hard: true` are ones where I think a careful reviewer could label either way.

The eval reports per-question accuracy, verdict agreement, latency, and two lists that matter more than accuracy:

- `unsafeAllows`: the gate allowed an action that should have stopped.
- `stricterThanExpected`: friction the gate added that the labels say was unnecessary.

It also reports what the hard rules alone would do with no model, which is the floor the model has to improve on.

Results: see [`results/`](results/) and the summary below.

<!-- RESULTS -->

## Continue the review

The gate is an experimental implementation and the evaluation is an initial measurement, not a production safety certification. For a smaller, implementation-independent exercise, use the [AI-assisted code review kit](https://michaeldabydeen.com/resources/review-kit.zip). It includes the code, worksheet, worked answer, sample team output, and a proposed facilitator guide.

Teams that want to compare the exercise with their own review practice can read about the [private workshop interest path](https://michaeldabydeen.com/workshops/ai-assisted-code-review). That page describes a proposed pilot and does not reserve a date or accept payment.

## Limits

- The agent in the demo is a fixed script, not an LLM planner. That keeps runs repeatable and isolates the gate, but it means the demo does not show how often a real planner proposes bad actions.
- 49 hand-labelled cases is enough to find failure modes, not to certify a threshold. Treat the numbers as a first measurement on my labels.
- The gate reads `document.body.textContent`, so it sees hidden text a DOM-reading agent would see. It does not read images, iframes, or shadow DOM.
- `ask` needs a human. In unattended runs the default approver says no.
- The OIDC token from `vercel env pull` expires after about 12 hours locally.

## Licence

MIT
