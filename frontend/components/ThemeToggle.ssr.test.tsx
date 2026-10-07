/**
 * @jest-environment node
 *
 * SSR safety for ThemeToggle (Issue #337).
 *
 * The rest of the suite runs under jsdom, where `localStorage` and `window`
 * both exist — so a component that touches them during render passes there and
 * still crashes in production. This file deliberately runs under the `node`
 * environment, which is what Next.js server rendering actually looks like:
 * no `window`, no `localStorage`, no `document`. Reaching for any of them
 * throws a ReferenceError and fails the test.
 */
import { renderToString } from "react-dom/server";

import ThemeToggle from "./ThemeToggle";

describe("ThemeToggle under SSR", () => {
  it("has no browser globals available (guards the test itself)", () => {
    expect(typeof window).toBe("undefined");
    expect(() => localStorage).toThrow(ReferenceError);
  });

  it("renders without touching localStorage or window", () => {
    expect(() => renderToString(<ThemeToggle />)).not.toThrow();
  });

  it("renders a placeholder rather than the button on the server", () => {
    // `useEffect` never runs during SSR, so the `mounted` guard must still be
    // false and the markup must be the layout-reserving placeholder. If a
    // future refactor renders the real button here, the theme it picks would
    // be a guess and would hydrate-mismatch.
    const html = renderToString(<ThemeToggle />);

    expect(html).toContain("aria-hidden");
    expect(html).not.toContain("<button");
  });
});
