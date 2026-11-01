import type { CDPSession, Page } from "playwright";
import { PAGE_TEXT_LIMIT } from "./questions.ts";

// Best effort: read body text in a Chromium isolated world, so page scripts
// cannot observe or shim the read. Isolated worlds are Chromium-only; other
// engines, and any CDP failure, fall back to a normal page.evaluate. The limit
// is applied inside the page so a large document does not cross CDP first.
export async function readBodyText(page: Page): Promise<string> {
  const limit = PAGE_TEXT_LIMIT * 4;
  if (page.context().browser()?.browserType().name() === "chromium") {
    let session: CDPSession | null = null;
    try {
      session = await page.context().newCDPSession(page);
      await session.send("Page.enable");
      const { frameTree } = await session.send("Page.getFrameTree");
      const world = await session.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
      });
      const result = await session.send("Runtime.evaluate", {
        expression: `(document.body ? document.body.textContent : "").slice(0, ${limit})`,
        contextId: world.executionContextId,
        returnByValue: true,
      });
      if (typeof result.result.value === "string") return result.result.value;
    } catch {
      // Fall through to the plain read.
    } finally {
      await session?.detach().catch(() => {});
    }
  }
  return page.evaluate(
    (max) => (document.body?.textContent ?? "").slice(0, max),
    limit,
  );
}
