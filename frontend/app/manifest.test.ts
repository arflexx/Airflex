/**
 * PWA manifest screenshots (issue #293).
 *
 * Chrome's Android install sheet only shows previews when the manifest has a
 * `screenshots` array whose entries are tagged with a `form_factor`, so the
 * assertions below pin both the metadata and the actual files on disk — a
 * manifest pointing at a missing or wrong-sized image silently degrades to
 * the minimal install banner.
 */

import fs from "fs";
import path from "path";

import manifest from "./manifest";

const PUBLIC_DIR = path.join(process.cwd(), "public");

/** Reads the width/height out of a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(file);
  // 8-byte signature, then a length (4) + "IHDR" (4), then width/height.
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("manifest screenshots", () => {
  const screenshots = manifest().screenshots ?? [];

  it("declares at least two screenshots", () => {
    expect(screenshots.length).toBeGreaterThanOrEqual(2);
  });

  it("tags every screenshot as a narrow (mobile) viewport", () => {
    for (const shot of screenshots) {
      expect(shot).toMatchObject({ form_factor: "narrow" });
    }
  });

  it("describes each screenshot as a portrait mobile image", () => {
    for (const shot of screenshots) {
      expect(shot.type).toBe("image/png");
      expect(shot.sizes).toBe("1080x1920");
      expect(shot.src).toMatch(/^\/screenshots\/.+\.png$/);
    }
  });

  it.each((manifest().screenshots ?? []).map((s) => [s.src, s] as const))(
    "%s exists on disk at the declared size",
    (src, shot) => {
      const file = path.join(PUBLIC_DIR, src.replace(/^\//, ""));
      expect(fs.existsSync(file)).toBe(true);

      const { width, height } = pngSize(file);
      const [w, h] = (shot.sizes ?? "").split("x").map(Number);
      expect({ width, height }).toEqual({ width: w, height: h });
    }
  );
});
