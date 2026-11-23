import { randomUUID } from "crypto";
import { generateDisplayHandle } from "./displayHandle";

describe("generateDisplayHandle", () => {
  it("returns a string starting with @airflex_", () => {
    const handle = generateDisplayHandle(randomUUID());
    expect(handle.startsWith("@airflex_")).toBe(true);
  });

  it("has a total length of 13 characters (@airflex_ = 9, 4 hex chars)", () => {
    const handle = generateDisplayHandle(randomUUID());
    expect(handle).toHaveLength(13);
  });

  it("suffix contains only lowercase hex characters [0-9a-f]", () => {
    const handle = generateDisplayHandle(randomUUID());
    const suffix = handle.slice("@airflex_".length);
    expect(suffix).toMatch(/^[0-9a-f]{4}$/);
  });

  it("is deterministic — same userId always produces the same handle", () => {
    const id = randomUUID();
    expect(generateDisplayHandle(id)).toBe(generateDisplayHandle(id));
  });

  it("produces unique handles across 1000 random UUIDs (collision rate < 10%)", () => {
    const handles = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      handles.add(generateDisplayHandle(randomUUID()));
    }
    // With 4 hex chars (65 536 possibilities) collisions among 1000 inputs
    // should be rare — expect at least 900 distinct values.
    expect(handles.size).toBeGreaterThan(900);
  });

  it("handles an empty string input without throwing", () => {
    expect(() => generateDisplayHandle("")).not.toThrow();
  });
});
