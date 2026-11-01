// Shared types. The decider (Jev or Laya) returns typed answers with
// probabilities. The policy turns those answers into a decision. The two
// never merge: a classifier never holds the authority to act.

export type BooleanQuestion = {
  type: "boolean";
  instructions: string;
  criteria?: { true: string; false: string };
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type Question = BooleanQuestion | ChoiceQuestion;
export type Questions = Record<string, Question>;

export type BooleanAnswer = { type: "boolean"; probability: number };
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  // Confidence = distribution concentration on the chosen option (the model's own
  // mass for it). The policy gates on this, not a re-derived probability.
  confidence: number;
};
export type Answer = BooleanAnswer | ChoiceAnswer;

export type Evaluation = {
  answers: Record<string, Answer>;
  latencyMs: number;
  backend: string;
  raw?: unknown;
};

export interface Decider {
  readonly name: string;
  evaluate(state: string, questions: Questions): Promise<Evaluation>;
}

export type ActionKind = "click" | "fill" | "goto" | "press";

// What the agent wants to do, described from the DOM rather than from the
// agent's own explanation of itself.
export type ProposedAction = {
  kind: ActionKind;
  // Human-readable target, e.g. `button "Post reply"` or `input[name=q]`.
  target: string;
  // Value for fill, URL for goto.
  value?: string;
  // DOM facts the hard rules use. The model never sees these as authority.
  element?: {
    tag?: string;
    inputType?: string;
    autocomplete?: string;
    // Resolved absolute URL for links, when the element has one.
    href?: string;
    // Resolved absolute form action, when the element has one.
    formAction?: string;
    formMethod?: string;
    // Name, id, and visible label help policy and masking identify sensitive
    // fields even when inputType/autocomplete are missing.
    name?: string;
    label?: string;
    id?: string;
  };
};

export type PageContext = {
  url: string;
  title: string;
  text: string;
};

export type Verdict = "allow" | "ask" | "block";

export type Decision = {
  verdict: Verdict;
  reasons: string[];
  // Which layer produced the strictest verdict. "policy-error" means the
  // gate failed closed because the policy call itself threw.
  source: "hard-rule" | "model" | "policy-default" | "policy-error";
};
