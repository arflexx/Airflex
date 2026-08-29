import type { Request, Response, NextFunction } from "express";
import { asyncHandler } from "./asyncHandler";

describe("asyncHandler", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    mockReq = {};
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  it("calls next with the error when an async handler throws an error synchronously", async () => {
    const error = new Error("Sync explosion inside async fn");
    const handler = asyncHandler(async () => {
      throw error;
    });

    handler(mockReq as Request, mockRes as Response, next);

    // Wait microtask queue
    await Promise.resolve();

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(error);
  });

  it("calls next with the error when an async handler rejects with an error", async () => {
    const error = new Error("Async promise rejection");
    const handler = asyncHandler(async () => {
      await Promise.reject(error);
    });

    handler(mockReq as Request, mockRes as Response, next);

    await Promise.resolve();
    await Promise.resolve();

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(error);
  });

  it("does not call next when an async handler resolves normally", async () => {
    const handler = asyncHandler(async (req, res) => {
      await Promise.resolve();
      res.status(200).json({ ok: true });
    });

    handler(mockReq as Request, mockRes as Response, next);

    await Promise.resolve();
    await Promise.resolve();

    expect(next).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith({ ok: true });
  });

  it("forwards req, res, and next arguments to the wrapped function", async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    const handler = asyncHandler(fn);

    handler(mockReq as Request, mockRes as Response, next);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(mockReq, mockRes, next);
  });
});
