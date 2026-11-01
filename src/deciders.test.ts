import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  JevGatewayDecider,
  KeywordDecider,
  LayaDecider,
  deciderFromEnv,
  normaliseAnswers,
} from "./deciders.ts";
import { GATE_QUESTIONS, renderState } from "./questions.ts";
import type { ChoiceAnswer } from "./types.ts";
import { CASES } from "../eval/cases.ts";

test("keyword task fit ignores a navigation path unrelated to the visible action", async () => {
  const c = CASES.find((it) => it.id === "repo-05")!;
  const ev = await new KeywordDecider().evaluate(renderState(c.task, c.action, c.page), GATE_QUESTIONS);
  assert.equal(ev.answers.servesTask.type, "boolean");
  assert.equal(ev.answers.servesTask.probability, 0.5);
});

test("keyword task fit does not use a product-name substring as task evidence", async () => {
  const c = CASES.find((it) => it.id === "srch-02")!;
  const ev = await new KeywordDecider().evaluate(renderState(c.task, c.action, c.page), GATE_QUESTIONS);
  assert.equal(ev.answers.servesTask.type, "boolean");
  assert.equal(ev.answers.servesTask.probability, 0.5);
});

test("a choice answer carries the distribution confidence on its option", async () => {
  const c = CASES.find((it) => it.id === "repo-05")!;
  const ev = await new KeywordDecider().evaluate(renderState(c.task, c.action, c.page), GATE_QUESTIONS);
  const effect = ev.answers.effect;
  assert.equal(effect.type, "choice");
  const conf = (effect as { confidence?: number }).confidence;
  assert.equal(typeof conf, "number");
  assert.ok(conf! > 0, "confident effect has positive confidence");
});

// normaliseAnswers is the single total parse path over the backends' wire shapes.
test("normaliseAnswers resolves Jev {choice,probabilities} and Laya bool-as-number", () => {
  const out = normaliseAnswers(
    { effect: { choice: "read_only", probabilities: { read_only: 0.9, reversible_change: 0.1 } }, n: 0.7 },
    {
      effect: { type: "choice", instructions: "", criteria: { read_only: "r", reversible_change: "c" } },
      n: { type: "boolean", instructions: "" },
    },
  );
  assert.deepEqual(out,
    { effect: { type: "choice", choice: "read_only", probabilities: { read_only: 0.9, reversible_change: 0.1 }, confidence: 0.9 }, n: { type: "boolean", probability: 0.7 } });
});

test("normaliseAnswers falls back to argmax when the chosen option is missing", () => {
  const out = normaliseAnswers(
    { effect: { probabilities: { reversible_change: 0.6, read_only: 0.4 } } },
    { effect: { type: "choice", instructions: "", criteria: { reversible_change: "c", read_only: "r" } } },
  );
  assert.equal(out.effect.type, "choice");
  assert.equal((out.effect as { choice: string }).choice, "reversible_change");
  assert.equal((out.effect as { confidence: number }).confidence, 0.6);
});

const choiceQuestion = {
  effect: {
    type: "choice" as const,
    instructions: "",
    criteria: { read_only: "r", reversible_change: "c" },
  },
};

test("normaliseAnswers rejects non-finite and out-of-range probabilities", () => {
  for (const bad of [Number.NaN, Infinity, -0.1, 1.1]) {
    assert.throws(
      () =>
        normaliseAnswers(
          { effect: { choice: "read_only", probabilities: { read_only: bad } } },
          choiceQuestion,
        ),
      /finite number in \[0,1\]/,
    );
  }
  assert.throws(
    () => normaliseAnswers({ n: Number.NaN }, { n: { type: "boolean", instructions: "" } }),
    /finite number in \[0,1\]/,
  );
  assert.throws(
    () => normaliseAnswers({ n: 1.5 }, { n: { type: "boolean", instructions: "" } }),
    /finite number in \[0,1\]/,
  );
});

test("normaliseAnswers rejects unknown options and probability keys", () => {
  assert.throws(
    () =>
      normaliseAnswers(
        { effect: { choice: "harmless", probabilities: { read_only: 0.9 } } },
        choiceQuestion,
      ),
    /not one of the question's options/,
  );
  assert.throws(
    () =>
      normaliseAnswers(
        { effect: { choice: "read_only", probabilities: { read_only: 0.9, harmless: 0.1 } } },
        choiceQuestion,
      ),
    /unknown option "harmless"/,
  );
  assert.throws(
    () => normaliseAnswers({ effect: { choice: "read_only", probabilities: {} } }, choiceQuestion),
    /missing a probability for "read_only"/,
  );
  assert.throws(
    () => normaliseAnswers({ effect: 0.9 }, choiceQuestion),
    /Choice answer must be an object/,
  );
});

test("normaliseAnswers never treats prototype keys as a choice", () => {
  for (const choice of ["__proto__", "constructor"]) {
    assert.throws(
      () =>
        normaliseAnswers(
          { effect: { choice, probabilities: { read_only: 0.9 } } },
          choiceQuestion,
        ),
      /not one of the question's options/,
    );
  }
  assert.throws(
    () =>
      normaliseAnswers(
        {
          effect: {
            probabilities: JSON.parse('{"read_only":0.9,"__proto__":0.99}'),
          },
        },
        choiceQuestion,
      ),
    /unknown option "__proto__"/,
  );
});

type LocalServer = { url: string; close: () => Promise<void> };

async function localServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LocalServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const VALID_ANSWERS = {
  effect: {
    choice: "read_only",
    probabilities: { read_only: 0.99, reversible_change: 0.01 },
    confidence: 0.99,
  },
  servesTask: { probability: 0.95 },
  pageInstructsAgent: { probability: 0.01 },
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test("Laya retries a transient 503 and then succeeds", async () => {
  let calls = 0;
  const srv = await localServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("temporarily unavailable");
    } else {
      sendJson(res, 200, { answers: VALID_ANSWERS });
    }
  });
  try {
    const decider = new LayaDecider({ baseUrl: srv.url, timeoutMs: 2_000, maxAttempts: 3 });
    const ev = await decider.evaluate("state", GATE_QUESTIONS);
    assert.equal(calls, 2);
    assert.equal((ev.answers.effect as ChoiceAnswer).choice, "read_only");
  } finally {
    await srv.close();
  }
});

test("a never-responding backend rejects within the configured timeout", async () => {
  const srv = await localServer(() => {
    // Deliberately never respond.
  });
  try {
    const decider = new LayaDecider({ baseUrl: srv.url, timeoutMs: 150, maxAttempts: 3 });
    const started = performance.now();
    await assert.rejects(() => decider.evaluate("state", GATE_QUESTIONS), /failed/);
    assert.ok(performance.now() - started < 2_000, "timeout fires promptly");
  } finally {
    await srv.close();
  }
});

test("an oversized response body is rejected", async () => {
  const oversized = "x".repeat(2 * 1024 * 1024 + 10);
  const srv = await localServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(oversized);
  });
  try {
    const decider = new LayaDecider({ baseUrl: srv.url, timeoutMs: 2_000, maxAttempts: 1 });
    await assert.rejects(() => decider.evaluate("state", GATE_QUESTIONS), /exceeded 2097152 bytes/);
  } finally {
    await srv.close();
  }
});

test("an error response body is not copied into the error message", async () => {
  const srv = await localServer((_req, res) => {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("SECRET page text and token abc123");
  });
  try {
    const decider = new LayaDecider({ baseUrl: srv.url, timeoutMs: 2_000, maxAttempts: 1 });
    await assert.rejects(
      () => decider.evaluate("state", GATE_QUESTIONS),
      (err: Error) => {
        assert.match(err.message, /400/);
        assert.equal(err.message.includes("SECRET"), false);
        assert.equal(err.message.includes("abc123"), false);
        return true;
      },
    );
  } finally {
    await srv.close();
  }
});

test("Jev rejects a remote plain-http base URL but allows local hosts", () => {
  assert.throws(
    () => new JevGatewayDecider({ baseUrl: "http://ai-gateway.example" }),
    /must use https/,
  );
  assert.throws(
    () => new JevGatewayDecider({ baseUrl: "ftp://ai-gateway.example" }),
    /must use https/,
  );
  assert.doesNotThrow(() => new JevGatewayDecider({ baseUrl: "http://127.0.0.1:9999" }));
  assert.doesNotThrow(() => new JevGatewayDecider({ baseUrl: "http://localhost:9999/" }));
  assert.doesNotThrow(() => new JevGatewayDecider({ baseUrl: "https://ai-gateway.vercel.sh/" }));
});

test("deciderFromEnv trims and lowercases the backend name", () => {
  const previous = process.env.STOPLINE_BACKEND;
  try {
    process.env.STOPLINE_BACKEND = "  LAYA  ";
    assert.ok(deciderFromEnv() instanceof LayaDecider);
    process.env.STOPLINE_BACKEND = "nonsense";
    assert.throws(() => deciderFromEnv(), /Unknown STOPLINE_BACKEND "nonsense"/);
  } finally {
    if (previous === undefined) delete process.env.STOPLINE_BACKEND;
    else process.env.STOPLINE_BACKEND = previous;
  }
});
