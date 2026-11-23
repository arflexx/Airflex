import { normalizePhone, maskPhone } from "./phone";

describe("normalizePhone — Nigerian local format (0XXXXXXXXXX)", () => {
  it("converts 0XXXXXXXXXX to E.164", () => {
    expect(normalizePhone("08012345678")).toBe("+2348012345678");
  });

  it("converts a different Nigerian local number", () => {
    expect(normalizePhone("07099999999")).toBe("+2347099999999");
  });

  it("handles leading/trailing whitespace", () => {
    expect(normalizePhone("  08012345678  ")).toBe("+2348012345678");
  });
});

describe("normalizePhone — already-normalized E.164 numbers", () => {
  it("returns an E.164 number unchanged", () => {
    expect(normalizePhone("+2348012345678")).toBe("+2348012345678");
  });

  it("returns a non-Nigerian E.164 number unchanged", () => {
    expect(normalizePhone("+14155552671")).toBe("+14155552671");
  });
});

describe("normalizePhone — bare international digits without +", () => {
  it("prepends + to a 13-digit international number", () => {
    expect(normalizePhone("2348012345678")).toBe("+2348012345678");
  });
});

describe("normalizePhone — non-numeric / invalid input", () => {
  it("returns non-numeric input trimmed but unchanged", () => {
    expect(normalizePhone("not-a-phone")).toBe("not-a-phone");
  });

  it("returns an empty string unchanged", () => {
    expect(normalizePhone("")).toBe("");
  });

  it("returns a too-short digit string unchanged", () => {
    // Only 5 digits — doesn't match any pattern
    expect(normalizePhone("12345")).toBe("12345");
  });
});

describe("maskPhone", () => {
  it("masks a full E.164 number", () => {
    expect(maskPhone("+2348012345678")).toBe("+234 *** *** 5678");
  });

  it("returns *** for very short input", () => {
    expect(maskPhone("123")).toBe("***");
  });
});
