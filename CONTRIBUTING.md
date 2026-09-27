# Contributing to Stopline

Stopline is an experimental decision gate for browser agents. Contributions that make the boundary between model classification and application authorisation clearer are welcome.

## Before opening an issue

- Reproduce the behaviour with Node 20 or newer.
- Include the command you ran and the smallest relevant input or action description.
- Separate an observed result from a proposed policy change.
- Do not include credentials, private browser content, tokens, or production data.

## Before opening a pull request

Run the checks that cover your change:

```sh
npm test
npm run typecheck
```

If the change affects the revision-bound example, also run:

```sh
npm run demo:revision
```

Keep examples labelled as illustrative unless the repository contains evidence for a stronger claim. Stopline does not certify production safety, authenticate approvers, or guarantee that a surrounding workflow cannot bypass a gate.

## Scope

The project is intentionally small. A proposed feature should explain which decision it helps a reviewer make, what evidence supports it, and what remains outside the claim.
