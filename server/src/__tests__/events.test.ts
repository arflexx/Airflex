import http from "http";
import type { AddressInfo } from "net";
import { app, seedUser } from "./helpers/testApp";
import { setupTestDatabase } from "./helpers/testDb";
import { setupMsw } from "./helpers/mockHttp";

/**
 * GET /api/events — the authenticated SSE stream. Not part of the issue's
 * required matrix but covered here because tradeVerification pushes events
 * through SseEmitter and the route shares the authenticate middleware.
 */
setupMsw();
setupTestDatabase();

/** Opens a real HTTP server so we can read the raw SSE stream. */
function connect(token?: string): Promise<{
  port: number;
  close: () => Promise<void>;
  chunks: Promise<string[]>;
}> {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;

      let resolveChunks: (chunks: string[]) => void;
      const chunks = new Promise<string[]>((res) => (resolveChunks = res));
      const collected: string[] = [];

      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/events",
          method: "GET",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
        (res) => {
          res.on("data", (d: Buffer) => collected.push(d.toString()));
          res.on("end", () => resolveChunks(collected));
        }
      );
      req.end();
      // Give the stream a moment to deliver the handshake, then disconnect.
      setTimeout(() => {
        req.destroy();
        resolveChunks(collected);
      }, 300);

      resolve({
        port,
        close: () =>
          new Promise((res) => {
            req.destroy();
            server.close(() => res());
          }),
        chunks,
      });
    });
  });
}

describe("GET /api/events", () => {
  it("200 — opens an SSE stream and sends the connected handshake", async () => {
    const user = await seedUser();
    const conn = await connect(user.token);

    try {
      const chunks = await conn.chunks;
      const raw = chunks.join("");
      expect(raw).toContain("event: connected");
      expect(raw).toContain(`"userId":"${user.id}"`);
      expect(raw).toMatch(/^event: connected\ndata: /m);
    } finally {
      await conn.close();
    }
  });

  it("401 — rejects connections without a valid token", async () => {
    const conn = await connect();

    try {
      const chunks = await conn.chunks;
      expect(chunks.join("")).toContain('"error":"Missing or invalid Authorization header"');
    } finally {
      await conn.close();
    }
  });

  it("401 — rejects an invalid token", async () => {
    const conn = await connect("forged.token.value");

    try {
      const chunks = await conn.chunks;
      expect(chunks.join("")).toContain("Token is invalid or expired");
    } finally {
      await conn.close();
    }
  });
});
