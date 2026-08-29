import logger from "./logger";

describe("logger", () => {
  const originalNodeEnv = process.env["NODE_ENV"];

  afterEach(() => {
    process.env["NODE_ENV"] = originalNodeEnv;
    jest.restoreAllMocks();
  });

  it("writes production errors as single-line JSON", () => {
    process.env["NODE_ENV"] = "production";
    const write = jest.spyOn(process.stdout, "write").mockImplementation(() => true);

    logger.error("msg");

    expect(write).toHaveBeenCalledTimes(1);
    const output = String(write.mock.calls[0][0]);
    const entry = JSON.parse(output);
    expect(entry).toMatchObject({ level: "error", message: "msg" });
    expect(typeof entry.timestamp).toBe("string");
    expect(output.trim()).not.toContain("\n");
  });

  it("writes readable colourised development lines", () => {
    process.env["NODE_ENV"] = "development";
    const write = jest.spyOn(process.stdout, "write").mockImplementation(() => true);

    logger.info("started");

    expect(String(write.mock.calls[0][0])).toMatch(/\[INFO\] \d{2}:\d{2}:\d{2} — started/);
  });
});
