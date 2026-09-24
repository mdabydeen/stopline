import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright";
import { decide, DEFAULT_POLICY, type Policy } from "./policy.ts";
import { GATE_QUESTIONS, describeAction, renderState } from "./questions.ts";
import type {
  Decider,
  Decision,
  Evaluation,
  PageContext,
  ProposedAction,
} from "./types.ts";

export type Approver = (req: {
  task: string;
  action: ProposedAction;
  decision: Decision;
}) => Promise<boolean>;

// Default approver for unattended runs: nobody is there, so the answer is no.
export const denyAll: Approver = async () => false;

export class StoppedByGate extends Error {
  constructor(
    readonly action: ProposedAction,
    readonly decision: Decision,
  ) {
    super(`stopline ${decision.verdict}: ${describeAction(action)} (${decision.reasons.join("; ")})`);
  }
}

export type EvidenceRecord = {
  at: string;
  task: string;
  action: string;
  page: { url: string; title: string };
  stateSha256: string;
  backend: string | null;
  latencyMs: number | null;
  answers: Evaluation["answers"] | null;
  decision: Decision;
  humanApproved: boolean | null;
  executed: boolean;
  error?: string;
};

// Wraps a Playwright page. The agent (LLM planner or script) calls these
// methods instead of page.click/fill/goto, so every side effect crosses the line.
export class Gate {
  constructor(
    private readonly page: Page,
    private readonly opts: {
      task: string;
      decider: Decider;
      approver?: Approver;
      evidencePath?: string;
      policy?: Policy;
      onDecision?: (r: EvidenceRecord) => void;
    },
  ) {
    if (opts.evidencePath) mkdirSync(dirname(opts.evidencePath), { recursive: true });
  }

  async goto(url: string): Promise<void> {
    const current = this.page.url();
    // First navigation of a session has no page to judge; allow the entry URL.
    if (current === "about:blank") {
      await this.page.goto(url);
      return;
    }
    await this.guard({ kind: "goto", target: "address bar", value: url }, () =>
      this.page.goto(new URL(url, current).toString()).then(() => undefined),
    );
  }

  async click(locator: Locator): Promise<void> {
    const action = await this.describe(locator, "click");
    await this.guard(action, () => locator.click());
  }

  async fill(locator: Locator, value: string): Promise<void> {
    const action = await this.describe(locator, "fill", value);
    await this.guard(action, () => locator.fill(value));
  }

  async press(locator: Locator, key: string): Promise<void> {
    const action = await this.describe(locator, "press", key);
    await this.guard(action, () => locator.press(key));
  }

  private async describe(
    locator: Locator,
    kind: ProposedAction["kind"],
    value?: string,
  ): Promise<ProposedAction> {
    const facts = await locator.evaluate((el: Element) => {
      const input = el as HTMLInputElement;
      const form = (el as HTMLInputElement).form ?? el.closest("form");
      const label =
        el.getAttribute("aria-label") ||
        (input.labels && input.labels[0]?.textContent) ||
        (el as HTMLElement).innerText ||
        input.value ||
        input.placeholder ||
        input.name ||
        "";
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") ?? "",
        label: label.replace(/\s+/g, " ").trim().slice(0, 120),
        inputType: input.type ?? "",
        autocomplete: el.getAttribute("autocomplete") ?? "",
        formAction: form?.getAttribute("action") ?? "",
        formMethod: form?.getAttribute("method") ?? "",
        href: el.getAttribute("href") ?? "",
      };
    });
    const noun =
      facts.role ||
      (facts.tag === "a"
        ? "link"
        : facts.tag === "input"
          ? ["checkbox", "radio", "submit"].includes(facts.inputType)
            ? facts.inputType
            : "field"
          : facts.tag);
    const extra = facts.href ? ` -> ${facts.href}` : "";
    return {
      kind,
      target: `${noun} "${facts.label}"${extra}`,
      value,
      element: {
        tag: facts.tag,
        inputType: facts.inputType || undefined,
        autocomplete: facts.autocomplete || undefined,
        formAction: facts.formAction || undefined,
        formMethod: facts.formMethod || undefined,
      },
    };
  }

  private async context(): Promise<PageContext> {
    // textContent, not innerText: DOM-reading agents ingest hidden text too,
    // so the gate reads what the agent reads.
    const text = await this.page.evaluate(() => document.body?.textContent ?? "");
    return { url: this.page.url(), title: await this.page.title(), text };
  }

  private async guard(action: ProposedAction, run: () => Promise<void>): Promise<void> {
    const page = await this.context();
    const state = renderState(this.opts.task, action, page);
    let evaluation: Evaluation | null = null;
    let error: string | undefined;
    try {
      evaluation = await this.opts.decider.evaluate(state, GATE_QUESTIONS);
    } catch (e) {
      error = (e as Error).message;
    }
    const decision = decide(action, page, evaluation?.answers ?? null, this.opts.policy ?? DEFAULT_POLICY);

    let humanApproved: boolean | null = null;
    let executed = false;
    if (decision.verdict === "ask") {
      humanApproved = await (this.opts.approver ?? denyAll)({ task: this.opts.task, action, decision });
    }
    const proceed = decision.verdict === "allow" || humanApproved === true;

    const record: EvidenceRecord = {
      at: new Date().toISOString(),
      task: this.opts.task,
      action: describeAction(action),
      page: { url: page.url, title: page.title },
      stateSha256: createHash("sha256").update(state).digest("hex"),
      backend: evaluation?.backend ?? null,
      latencyMs: evaluation ? Math.round(evaluation.latencyMs) : null,
      answers: evaluation?.answers ?? null,
      decision,
      humanApproved,
      executed: proceed,
      ...(error ? { error } : {}),
    };

    if (proceed) {
      await run();
      executed = true;
    }
    record.executed = executed;
    if (this.opts.evidencePath) appendFileSync(this.opts.evidencePath, JSON.stringify(record) + "\n");
    this.opts.onDecision?.(record);
    if (!proceed) throw new StoppedByGate(action, decision);
  }
}
