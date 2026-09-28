import { generateDisplayHandle } from "./displayHandle";

describe("generateDisplayHandle", () => {
  const userId = "0b6f0b0e-1234-4a5b-8c9d-1234567890ab";

  it("is deterministic for the same user id", () => {
    expect(generateDisplayHandle(userId)).toBe(generateDisplayHandle(userId));
  });

  it("formats the handle as @airflex_ followed by four hex characters", () => {
    expect(generateDisplayHandle(userId)).toMatch(/^@airflex_[0-9a-f]{4}$/);
  });

  it("does not embed the raw user id", () => {
    const handle = generateDisplayHandle(userId);
    expect(handle).not.toContain(userId);
    expect(handle).not.toContain(userId.slice(-8));
  });

  it("differs across user ids", () => {
    const a = generateDisplayHandle("11111111-1111-4111-8111-111111111111");
    const b = generateDisplayHandle("22222222-2222-4222-8222-222222222222");
    expect(a).not.toBe(b);
  });
});
