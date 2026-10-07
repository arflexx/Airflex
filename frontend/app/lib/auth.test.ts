import { readRole } from "./auth";

/** Build an unsigned JWT (base64url) the way `readRole` decodes it. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

describe("readRole", () => {
  it("returns 'admin' for a valid admin JWT", () => {
    expect(
      readRole(jwt({ sub: "u1", role: "admin", exp: 9999999999 })),
    ).toBe("admin");
  });

  it("returns 'user' for a valid user JWT", () => {
    expect(readRole(jwt({ sub: "u1", role: "user" }))).toBe("user");
  });

  it("returns null for a token with no role claim", () => {
    expect(readRole(jwt({ sub: "u1" }))).toBeNull();
  });

  it("returns null for an unrecognised role", () => {
    expect(readRole(jwt({ role: "superadmin" }))).toBeNull();
    expect(readRole(jwt({ role: 42 }))).toBeNull();
  });

  it("returns null for a malformed token", () => {
    expect(readRole("not-a-jwt")).toBeNull();
    expect(readRole("only.two")).toBeNull();
    expect(readRole("header.!!!not-base64!!!.sig")).toBeNull();
    expect(readRole("")).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(readRole(null)).toBeNull();
    expect(readRole(undefined)).toBeNull();
  });
});
