import type { Response } from "express";
import { SseEmitter } from "./sseEmitter";

describe("SseEmitter", () => {
  let write: jest.Mock;
  let flush: jest.Mock;
  let on: jest.Mock;
  let mockRes: Partial<Response> & { write: jest.Mock; on: jest.Mock };
  let activeMocks: Array<{ on: jest.Mock }>;

  beforeEach(() => {
    jest.useFakeTimers();
    activeMocks = [];
    write = jest.fn();
    flush = jest.fn();
    on = jest.fn();
    mockRes = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write,
      flush,
      on,
    } as unknown as typeof mockRes;
    activeMocks.push(mockRes);
  });

  afterEach(() => {
    // Disconnect every client registered during the test so the module-level
    // registry does not leak connections into the next test.
    for (const mock of activeMocks) {
      const call = mock.on.mock.calls.find(([name]) => name === "close");
      if (call) (call[1] as () => void)();
    }
    expect(SseEmitter.connectionCount()).toBe(0);
    jest.useRealTimers();
  });

  /** Invokes the handler registered for the given event name on the mock res. */
  function trigger(event: string): void {
    const call = on.mock.calls.find(([name]) => name === event);
    expect(call).toBeDefined();
    (call[1] as () => void)();
  }

  it("opens a stream with SSE headers and an initial connected event", () => {
    SseEmitter.addClient("user-1", mockRes as Response);

    expect(mockRes.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
    expect(mockRes.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache, no-transform");
    expect(mockRes.setHeader).toHaveBeenCalledWith("Connection", "keep-alive");
    expect(mockRes.flushHeaders).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('event: connected\n');
    expect(write).toHaveBeenCalledWith('data: {"type":"connected","userId":"user-1"}\n\n');
    expect(SseEmitter.connectionCount()).toBe(1);
  });

  it("writes a heartbeat comment line every 30 seconds", () => {
    SseEmitter.addClient("user-1", mockRes as Response);
    write.mockClear();

    jest.advanceTimersByTime(30_000);
    expect(write).toHaveBeenCalledWith(": heartbeat\n\n");
    expect(flush).toHaveBeenCalled();

    write.mockClear();
    jest.advanceTimersByTime(30_000);
    expect(write).toHaveBeenCalledWith(": heartbeat\n\n");
  });

  it("stops heartbeating and unregisters the client on close", () => {
    SseEmitter.addClient("user-1", mockRes as Response);
    write.mockClear();

    trigger("close");

    expect(SseEmitter.connectionCount()).toBe(0);

    jest.advanceTimersByTime(120_000);
    expect(write).not.toHaveBeenCalled();
  });

  it("emits events only to the targeted user and drops events for offline users", () => {
    SseEmitter.addClient("user-1", mockRes as Response);

    const otherWrite = jest.fn();
    const otherRes = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: otherWrite,
      on: jest.fn(),
    } as unknown as Response;
    activeMocks.push(otherRes as unknown as { on: jest.Mock });
    SseEmitter.addClient("user-2", otherRes);

    write.mockClear();
    otherWrite.mockClear();

    SseEmitter.emit(["user-1"], { type: "trade_completed", tradeId: "t1", status: "Completed" });

    expect(write).toHaveBeenCalledWith("event: trade_completed\n");
    expect(write).toHaveBeenCalledWith(
      'data: {"type":"trade_completed","tradeId":"t1","status":"Completed"}\n\n'
    );
    expect(otherWrite).not.toHaveBeenCalled();

    // Offline user: event is dropped, no throw
    expect(() => SseEmitter.emit(["ghost"], { type: "trade_completed" })).not.toThrow();
  });
});
