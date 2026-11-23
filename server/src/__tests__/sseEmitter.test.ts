/**
 * Integration tests for real-time SSE delivery (issue #537).
 *
 * Unlike services/sseEmitter.test.ts (which drives a mocked Response), these
 * tests mount the emitter behind a real HTTP server on an ephemeral port and
 * read the text/event-stream over a socket, the way a browser would.
 */
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import { Writable } from "stream";
import type { Response } from "express";

import {
  SseEmitter,
  MAX_BUFFERED_BYTES,
  REPLAY_BUFFER_SIZE,
} from "../services/sseEmitter";

const HEARTBEAT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Test server
// ---------------------------------------------------------------------------

let server: http.Server;
let port: number;
/** Every server-side Response handed to the emitter, for cleanup assertions. */
let serverResponses: Response[] = [];
/** Responses that have emitted "close". */
const closedResponses = new WeakSet<Response>();

beforeAll(async () => {
  const app = express();
  // Mirrors routes/events.ts, minus authentication: the user comes from the query.
  app.get("/events", (req, res) => {
    serverResponses.push(res);
    res.on("close", () => closedResponses.add(res));
    SseEmitter.addClient(String(req.query["user"]), res, req.header("last-event-id"));
  });

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// SSE client
// ---------------------------------------------------------------------------

interface ReceivedEvent {
  id?: string;
  event: string;
  data: Record<string, unknown>;
  receivedAt: number;
}

const openClients: SseTestClient[] = [];

/** Minimal EventSource-like reader over a raw HTTP response. */
class SseTestClient {
  readonly events: ReceivedEvent[] = [];
  ended = false;

  private buffer = "";
  private listeners: Array<() => void> = [];
  private req!: http.ClientRequest;

  static connect(userId: string, lastEventId?: string): Promise<SseTestClient> {
    const client = new SseTestClient();
    openClients.push(client);

    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;

    client.req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: `/events?user=${encodeURIComponent(userId)}`,
        headers,
        agent: false,
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => client.ingest(chunk));
        res.on("end", () => client.markEnded());
        res.on("close", () => client.markEnded());
      }
    );
    client.req.on("error", () => client.markEnded());

    return client.waitFor((e) => e.event === "connected").then(() => client);
  }

  /** Resolves with the first event matching `predicate`, or rejects on timeout. */
  waitFor(
    predicate: (event: ReceivedEvent) => boolean,
    timeoutMs = 1_000
  ): Promise<ReceivedEvent> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const match = this.events.find(predicate);
        if (match) {
          clearTimeout(timer);
          this.listeners = this.listeners.filter((l) => l !== listener);
          resolve(match);
          return true;
        }
        return false;
      };
      const listener = (): void => {
        check();
      };
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== listener);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms; received: ${JSON.stringify(
              this.events.map((e) => [e.id, e.event])
            )}`
          )
        );
      }, timeoutMs);
      if (!check()) this.listeners.push(listener);
    });
  }

  /** Resolves once the server ends the stream. */
  waitForEnd(timeoutMs = 1_000): Promise<void> {
    return waitUntil(() => this.ended, timeoutMs);
  }

  /** Events that carry an id (i.e. everything except the connected handshake). */
  identified(): Array<[string, string]> {
    return this.events.filter((e) => e.id !== undefined).map((e) => [e.id!, e.event]);
  }

  close(): void {
    this.req.destroy();
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.parseBlock(block);
    }
  }

  private parseBlock(block: string): void {
    let id: string | undefined;
    let event = "message";
    const data: string[] = [];

    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // comment / heartbeat
      const sep = line.indexOf(":");
      const field = sep === -1 ? line : line.slice(0, sep);
      const value = sep === -1 ? "" : line.slice(sep + 1).replace(/^ /, "");
      if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }

    if (data.length === 0) return;
    this.events.push({
      id,
      event,
      data: JSON.parse(data.join("\n")) as Record<string, unknown>,
      receivedAt: Date.now(),
    });
    for (const listener of [...this.listeners]) listener();
  }

  private markEnded(): void {
    this.ended = true;
  }
}

/** Polls `condition` until it holds, rejecting after `timeoutMs`. */
function waitUntil(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (condition()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitUntil timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

/**
 * A Response stand-in whose consumer never reads: `_write` never calls back,
 * so every subsequent write piles up in `writableLength`, exactly like a
 * ServerResponse whose TCP peer has stopped acknowledging data.
 */
class StalledResponse extends Writable {
  constructor() {
    super({ highWaterMark: 1024 });
  }
  override _write(): void {
    // Intentionally never invokes the callback.
  }
  setHeader(): void {}
  flushHeaders(): void {}
}

afterEach(async () => {
  SseEmitter.reset();
  for (const client of openClients.splice(0)) client.close();
  await waitUntil(() => SseEmitter.connectionCount() === 0);
  serverResponses = [];
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSE event delivery (integration)", () => {
  describe("real-time delivery", () => {
    it("serves a text/event-stream and sends the connected handshake", async () => {
      const client = await SseTestClient.connect("alice");

      expect(client.events[0]).toMatchObject({
        event: "connected",
        data: { type: "connected", userId: "alice" },
      });
      expect(client.events[0]!.id).toBeUndefined();
      expect(SseEmitter.connectionCount()).toBe(1);
      expect(serverResponses[0]!.getHeader("content-type")).toBe("text/event-stream");
    });

    it("delivers an emitted event to the connected client within 1 second", async () => {
      const client = await SseTestClient.connect("alice");

      const sentAt = Date.now();
      SseEmitter.emit(["alice"], { type: "trade_completed", tradeId: "t1", status: "Completed" });

      const received = await client.waitFor((e) => e.event === "trade_completed", 1_000);
      expect(received.receivedAt - sentAt).toBeLessThan(1_000);
      expect(received.id).toBe("1");
      expect(received.data).toEqual({ type: "trade_completed", tradeId: "t1", status: "Completed" });
    });

    it("delivers only to targeted users, and broadcasts to everyone", async () => {
      const alice = await SseTestClient.connect("alice");
      const bob = await SseTestClient.connect("bob");

      SseEmitter.emit(["alice"], { type: "trade_locked", tradeId: "t1" });
      SseEmitter.emitAll({ type: "admin_alert", message: "maintenance" });

      await alice.waitFor((e) => e.event === "admin_alert");
      await bob.waitFor((e) => e.event === "admin_alert");

      expect(alice.identified()).toEqual([["1", "trade_locked"], ["2", "admin_alert"]]);
      // Event IDs are per user (issue #619), so bob's first event is 1.
      expect(bob.identified()).toEqual([["1", "admin_alert"]]);
    });

    it("fans out to every open connection of the same user", async () => {
      const tab1 = await SseTestClient.connect("alice");
      const tab2 = await SseTestClient.connect("alice");

      SseEmitter.emit(["alice"], { type: "trade_completed", tradeId: "t1" });

      await tab1.waitFor((e) => e.event === "trade_completed");
      await tab2.waitFor((e) => e.event === "trade_completed");
    });

    it("assigns strictly increasing ids in emission order", async () => {
      const client = await SseTestClient.connect("alice");

      for (let i = 0; i < 5; i++) {
        SseEmitter.emit(["alice"], { type: "tick", n: i });
      }
      await client.waitFor((e) => e.id === "5");

      expect(client.identified().map(([id]) => Number(id))).toEqual([1, 2, 3, 4, 5]);
      expect(client.events.slice(1).map((e) => e.data["n"])).toEqual([0, 1, 2, 3, 4]);
    });
  });

  describe("Last-Event-ID replay", () => {
    it("replays events missed while disconnected, then resumes live delivery", async () => {
      const first = await SseTestClient.connect("alice");
      SseEmitter.emit(["alice"], { type: "trade_locked", tradeId: "t1" });
      const seen = await first.waitFor((e) => e.event === "trade_locked");

      first.close();
      await waitUntil(() => SseEmitter.connectionCount() === 0);

      // Missed while offline: one for alice, one for bob, one broadcast.
      SseEmitter.emit(["alice"], { type: "trade_completed", tradeId: "t1" });
      SseEmitter.emit(["bob"], { type: "trade_completed", tradeId: "t2" });
      SseEmitter.emitAll({ type: "admin_alert", message: "maintenance" });

      const second = await SseTestClient.connect("alice", seen.id);
      await second.waitFor((e) => e.event === "admin_alert");

      expect(second.identified()).toEqual([["2", "trade_completed"], ["3", "admin_alert"]]);
      expect(second.events[1]!.data).toEqual({ type: "trade_completed", tradeId: "t1" });

      SseEmitter.emit(["alice"], { type: "trade_disputed", tradeId: "t1" });
      await second.waitFor((e) => e.id === "4");
      expect(second.identified().map(([id]) => id)).toEqual(["2", "3", "4"]);
    });

    it("replays nothing when the client is already up to date", async () => {
      SseEmitter.emit(["alice"], { type: "trade_locked", tradeId: "t1" });

      const client = await SseTestClient.connect("alice", "1");
      SseEmitter.emit(["alice"], { type: "trade_completed", tradeId: "t1" });
      await client.waitFor((e) => e.id === "2");

      expect(client.identified()).toEqual([["2", "trade_completed"]]);
    });

    it("does not replay anything to a fresh connection without Last-Event-ID", async () => {
      SseEmitter.emit(["alice"], { type: "trade_locked", tradeId: "t1" });

      const client = await SseTestClient.connect("alice");
      SseEmitter.emit(["alice"], { type: "trade_completed", tradeId: "t1" });
      await client.waitFor((e) => e.id === "2");

      expect(client.identified()).toEqual([["2", "trade_completed"]]);
    });

    it.each(["not-a-number", "-1", "1.5", ""])(
      "ignores a malformed Last-Event-ID (%p) without failing the connection",
      async (header) => {
        SseEmitter.emit(["alice"], { type: "trade_locked", tradeId: "t1" });

        const client = await SseTestClient.connect("alice", header);
        SseEmitter.emit(["alice"], { type: "trade_completed", tradeId: "t1" });
        await client.waitFor((e) => e.id === "2");

        expect(client.identified()).toEqual([["2", "trade_completed"]]);
      }
    );

    it("bounds the replay buffer to the most recent REPLAY_BUFFER_SIZE events", async () => {
      const total = REPLAY_BUFFER_SIZE + 25;
      for (let i = 1; i <= total; i++) {
        SseEmitter.emit(["alice"], { type: "tick", n: i });
      }

      const client = await SseTestClient.connect("alice", "0");
      await client.waitFor((e) => e.id === String(total), 2_000);

      const ids = client.identified().map(([id]) => Number(id));
      expect(ids).toHaveLength(REPLAY_BUFFER_SIZE);
      expect(ids[0]).toBe(total - REPLAY_BUFFER_SIZE + 1);
      expect(ids[ids.length - 1]).toBe(total);
    });
  });

  describe("slow and disconnected consumers", () => {
    it("drops a stalled consumer without delaying delivery to active clients", async () => {
      const active = await SseTestClient.connect("alice");
      const stalled = new StalledResponse();
      SseEmitter.addClient("alice", stalled as unknown as Response);
      expect(SseEmitter.connectionCount()).toBe(2);

      // Enough data to push the stalled consumer past MAX_BUFFERED_BYTES. The
      // active client reads each event before the next is sent, so only the
      // stalled one accumulates a backlog.
      const chunk = "x".repeat(256 * 1024);
      const count = Math.ceil(MAX_BUFFERED_BYTES / chunk.length) + 2;

      for (let i = 1; i <= count; i++) {
        const sentAt = Date.now();
        SseEmitter.emit(["alice"], { type: "bulk", n: i, chunk });
        const received = await active.waitFor((e) => e.id === String(i), 1_000);
        expect(received.receivedAt - sentAt).toBeLessThan(1_000);
      }
      expect(active.identified()).toHaveLength(count);

      expect(stalled.destroyed).toBe(true);
      expect(SseEmitter.connectionCount()).toBe(1);
    });

    it("keeps delivering after a consumer's socket dies before its close event fires", async () => {
      const active = await SseTestClient.connect("alice");
      const dead = new StalledResponse();
      SseEmitter.addClient("alice", dead as unknown as Response);

      dead.destroy();
      // Emitted synchronously, before the "close" handler has unregistered it.
      expect(() => SseEmitter.emit(["alice"], { type: "trade_completed" })).not.toThrow();

      await active.waitFor((e) => e.event === "trade_completed");
      await waitUntil(() => SseEmitter.connectionCount() === 1);
    });

    it("isolates a consumer whose writes throw", async () => {
      const active = await SseTestClient.connect("alice");
      const broken = Object.assign(new StalledResponse(), {
        write: () => {
          throw new Error("EPIPE");
        },
      });
      SseEmitter.addClient("alice", broken as unknown as Response);

      expect(() => SseEmitter.emitAll({ type: "admin_alert", message: "hi" })).not.toThrow();
      await active.waitFor((e) => e.event === "admin_alert");
    });

    it("removes a client whose TCP connection drops abruptly", async () => {
      const alice = await SseTestClient.connect("alice");
      const bob = await SseTestClient.connect("bob");

      alice.close();
      await waitUntil(() => SseEmitter.connectionCount() === 1);

      SseEmitter.emitAll({ type: "admin_alert", message: "still here" });
      await bob.waitFor((e) => e.event === "admin_alert");
    });
  });

  describe("resource cleanup", () => {
    /** Heartbeat timers created by addClient since the spy was installed. */
    function heartbeatTimers(spy: jest.SpyInstance): unknown[] {
      return spy.mock.calls
        .map((call, i) => [call[1], spy.mock.results[i]!.value] as const)
        .filter(([delay]) => delay === HEARTBEAT_INTERVAL_MS)
        .map(([, timer]) => timer);
    }

    it("clears the heartbeat timer and unregisters when a client disconnects", async () => {
      const setSpy = jest.spyOn(global, "setInterval");
      const clearSpy = jest.spyOn(global, "clearInterval");

      const clients = await Promise.all(
        ["alice", "bob", "carol"].map((user) => SseTestClient.connect(user))
      );
      const timers = heartbeatTimers(setSpy);
      expect(timers).toHaveLength(3);

      for (const client of clients) client.close();
      await waitUntil(() => SseEmitter.connectionCount() === 0);

      for (const timer of timers) {
        expect(clearSpy).toHaveBeenCalledWith(timer);
      }
    });

    it("closeAll() ends every stream server-side and releases all timers", async () => {
      const setSpy = jest.spyOn(global, "setInterval");
      const clearSpy = jest.spyOn(global, "clearInterval");

      const clients = await Promise.all(
        ["alice", "bob", "carol"].map((user) => SseTestClient.connect(user))
      );
      const timers = heartbeatTimers(setSpy);

      SseEmitter.closeAll();

      expect(SseEmitter.connectionCount()).toBe(0);
      await Promise.all(clients.map((client) => client.waitForEnd()));
      for (const timer of timers) {
        expect(clearSpy).toHaveBeenCalledWith(timer);
      }
      for (const res of serverResponses) {
        expect(res.writableEnded).toBe(true);
      }

      // Emitting after shutdown is a harmless no-op for the closed streams.
      const before = clients.map((c) => c.events.length);
      expect(() => SseEmitter.emitAll({ type: "admin_alert", message: "late" })).not.toThrow();
      expect(clients.map((c) => c.events.length)).toEqual(before);
    });

    it("does not leak connections or timers across repeated connect/disconnect cycles", async () => {
      const setSpy = jest.spyOn(global, "setInterval");
      const clearSpy = jest.spyOn(global, "clearInterval");
      const cycles = 25;

      for (let i = 0; i < cycles; i++) {
        const client = await SseTestClient.connect(`user-${i % 3}`);
        SseEmitter.emit([`user-${i % 3}`], { type: "tick", n: i });
        await client.waitFor((e) => e.event === "tick");
        client.close();
        await waitUntil(() => SseEmitter.connectionCount() === 0);
      }

      const timers = heartbeatTimers(setSpy);
      expect(timers).toHaveLength(cycles);
      for (const timer of timers) {
        expect(clearSpy).toHaveBeenCalledWith(timer);
      }
      expect(serverResponses).toHaveLength(cycles);
      await waitUntil(() => serverResponses.every((res) => closedResponses.has(res)));
    });

    it("reset() forgets buffered events so ids restart", async () => {
      SseEmitter.emit(["alice"], { type: "trade_locked" });
      SseEmitter.reset();

      const client = await SseTestClient.connect("alice", "0");
      SseEmitter.emit(["alice"], { type: "trade_completed" });
      await client.waitFor((e) => e.event === "trade_completed");

      expect(client.identified()).toEqual([["1", "trade_completed"]]);
    });
  });
});
