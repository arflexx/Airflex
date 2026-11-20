/**
 * sseEmitter.reconnect.test.ts
 *
 * Integration tests verifying that a reconnecting SSE client receives exactly the
 * missed events per user using Last-Event-ID, backed by Redis / buffer with TTL (issue #619).
 */

import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import { SseEmitter } from "../services/sseEmitter";

describe("SSE connection state and replay on reconnect (issue #619)", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    app.get("/events", (req, res) => {
      // Mirrors routes/events.ts: sets retry field and delegates to SseEmitter
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      res.write("retry: 3000\n\n");

      SseEmitter.addClient(String(req.query["user"]), res, req.header("last-event-id"));
    });

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    SseEmitter.reset();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    SseEmitter.reset();
  });

  function connectClient(userId: string, lastEventId?: string) {
    const events: Array<{ id?: string; event: string; data: Record<string, unknown> }> = [];
    let buffer = "";

    const headers: Record<string, string> = {};
    if (lastEventId !== undefined) {
      headers["Last-Event-ID"] = lastEventId;
    }

    let req: http.ClientRequest;

    const connectedPromise = new Promise<{
      events: typeof events;
      close: () => void;
      waitFor: (predicate: (e: (typeof events)[0]) => boolean) => Promise<(typeof events)[0]>;
    }>((resolve, reject) => {
      req = http.get(
        {
          host: "127.0.0.1",
          port,
          path: `/events?user=${encodeURIComponent(userId)}`,
          headers,
          agent: false,
        },
        (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buffer += chunk;
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";

            for (const part of parts) {
              if (part.startsWith(":") || part.startsWith("retry:")) continue;
              let id: string | undefined;
              let event = "message";
              let data = {};

              for (const line of part.split("\n")) {
                if (line.startsWith("id: ")) id = line.slice(4).trim();
                else if (line.startsWith("event: ")) event = line.slice(7).trim();
                else if (line.startsWith("data: ")) {
                  try {
                    data = JSON.parse(line.slice(6));
                  } catch {}
                }
              }
              events.push({ id, event, data });
            }
          });

          const interval = setInterval(() => {
            if (events.some((e) => e.event === "connected")) {
              clearInterval(interval);
              resolve({
                events,
                close: () => req.destroy(),
                waitFor: (predicate) => {
                  return new Promise((resWait, rejWait) => {
                    const timer = setTimeout(
                      () => rejWait(new Error(`Timed out waiting for event; got: ${JSON.stringify(events)}`)),
                      2000
                    );
                    const check = setInterval(() => {
                      const match = events.find(predicate);
                      if (match) {
                        clearTimeout(timer);
                        clearInterval(check);
                        resWait(match);
                      }
                    }, 50);
                  });
                },
              });
            }
          }, 20);
        }
      );
      req.on("error", reject);
    });

    return connectedPromise;
  }

  it("replays exactly missed events since Last-Event-ID with per-user incremented IDs", async () => {
    // 1. Initial connection
    const client1 = await connectClient("alice");
    SseEmitter.emit(["alice"], { type: "trade_created", tradeId: "1" });
    const ev1 = await client1.waitFor((e) => e.event === "trade_created");
    expect(ev1.id).toBe("1");

    // 2. Client disconnects
    client1.close();
    await new Promise((r) => setTimeout(r, 100));

    // 3. Events fired while disconnected
    SseEmitter.emit(["alice"], { type: "trade_updated", tradeId: "1", status: "locked" });
    SseEmitter.emit(["bob"], { type: "bob_event", note: "not for alice" });
    SseEmitter.emit(["alice"], { type: "trade_completed", tradeId: "1" });

    // 4. Client reconnects with Last-Event-ID: 1
    const client2 = await connectClient("alice", "1");
    await client2.waitFor((e) => e.event === "trade_completed");

    // Filter out handshake 'connected' event
    const identified = client2.events.filter((e) => e.id !== undefined);
    expect(identified.map((e) => [e.id, e.event])).toEqual([
      ["2", "trade_updated"],
      ["3", "trade_completed"],
    ]);

    // Live delivery resumes after replay
    SseEmitter.emit(["alice"], { type: "trade_rated", rating: 5 });
    await client2.waitFor((e) => e.event === "trade_rated");

    const allIdentified = client2.events.filter((e) => e.id !== undefined);
    expect(allIdentified.map((e) => [e.id, e.event])).toEqual([
      ["2", "trade_updated"],
      ["3", "trade_completed"],
      ["4", "trade_rated"],
    ]);

    client2.close();
  });
});
