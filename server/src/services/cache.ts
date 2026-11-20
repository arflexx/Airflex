/**
 * cache.ts — Minimal Redis-backed cache with an in-process fallback.
 *
 * Follows the same pattern as jobs/queue.ts: a tiny RESP client over a raw
 * TCP socket (Node's built-in `net` module — no extra npm packages), so the
 * analytics endpoints (issue #110) can cache dashboard responses in Redis
 * without introducing a new dependency.
 *
 * When REDIS_URL is absent or Redis is unreachable, values are cached in an
 * in-memory Map with the same TTL semantics, so behaviour is identical — the
 * cache just does not survive a restart or span multiple instances.
 *
 * Only the commands the cache needs are implemented: GET, SET (with EX in
 * seconds). Anything else resolves to null / is ignored.
 */

import { Socket } from "net";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// RESP client (GET / SET EX only)
// ---------------------------------------------------------------------------

class RedisCacheClient {
  private socket: Socket | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private queue: Array<{
    resolve: (v: string | null) => void;
    reject: (e: Error) => void;
  }> = [];
  private buffer = "";

  connect(url: string): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname;
        const port = parseInt(parsed.port || "6379", 10);
        const pass = parsed.password || null;

        this.socket = new Socket();
        this.socket.setEncoding("utf8");

        let settled = false;

        this.socket.connect(port, host, () => {
          this.connected = true;
          if (pass) {
            this.socket!.write(`*2\r\n$4\r\nAUTH\r\n$${pass.length}\r\n${pass}\r\n`);
          }
          logger.info({ host, port }, "[cache] Redis connected");
          if (!settled) {
            settled = true;
            resolve();
          }
        });

        this.socket.on("data", (chunk: string) => {
          this.buffer += chunk;
          this.flushBuffer();
        });

        this.socket.on("error", (err) => {
          this.connected = false;
          for (const p of this.queue) p.resolve(null);
          this.queue = [];
          if (!settled) {
            settled = true;
            reject(err);
          } else {
            logger.warn({ err: err.message }, "[cache] Redis socket error — using in-memory cache");
          }
        });

        this.socket.on("close", () => {
          this.connected = false;
          logger.warn("[cache] Redis connection closed");
        });
      } catch (err) {
        reject(err as Error);
      }
    });

    return this.connectPromise;
  }

  private flushBuffer(): void {
    while (this.buffer.length > 0 && this.queue.length > 0) {
      const first = this.buffer[0];

      if (first === "+") {
        const end = this.buffer.indexOf("\r\n");
        if (end === -1) break;
        const val = this.buffer.slice(1, end);
        this.buffer = this.buffer.slice(end + 2);
        this.queue.shift()!.resolve(val);

      } else if (first === ":") {
        const end = this.buffer.indexOf("\r\n");
        if (end === -1) break;
        const val = this.buffer.slice(1, end);
        this.buffer = this.buffer.slice(end + 2);
        this.queue.shift()!.resolve(val);

      } else if (first === "$") {
        const end = this.buffer.indexOf("\r\n");
        if (end === -1) break;
        const len = parseInt(this.buffer.slice(1, end), 10);
        if (len === -1) {
          // $-1 — nil bulk string (Redis GET miss)
          this.buffer = this.buffer.slice(end + 2);
          this.queue.shift()!.resolve(null);
          continue;
        }
        const dataStart = end + 2;
        if (this.buffer.length < dataStart + len + 2) break;
        const val = this.buffer.slice(dataStart, dataStart + len);
        this.buffer = this.buffer.slice(dataStart + len + 2);
        this.queue.shift()!.resolve(val);

      } else if (first === "-") {
        const end = this.buffer.indexOf("\r\n");
        if (end === -1) break;
        const msg = this.buffer.slice(1, end);
        this.buffer = this.buffer.slice(end + 2);
        this.queue.shift()!.reject(new Error(msg));

      } else {
        const end = this.buffer.indexOf("\r\n");
        if (end === -1) break;
        this.buffer = this.buffer.slice(end + 2);
      }
    }
  }

  private send(command: string): Promise<string | null> {
    if (!this.connected || !this.socket) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.socket!.write(command);
    });
  }

  /** PING — returns "PONG" or status from Redis */
  async ping(): Promise<string | null> {
    const cmd = "*1\r\n$4\r\nPING\r\n";
    return this.send(cmd);
  }

  /** GET key — returns the value or null on miss/error. */
  async get(key: string): Promise<string | null> {
    const cmd = `*2\r\n$3\r\nGET\r\n$${key.length}\r\n${key}\r\n`;
    return this.send(cmd);
  }

  /** SET key value EX seconds — resolves to "OK" or null on error. */
  async set(key: string, value: string, ttlSeconds: number): Promise<string | null> {
    const ttl = String(Math.max(1, Math.floor(ttlSeconds)));
    const cmd =
      `*5\r\n$3\r\nSET\r\n$${key.length}\r\n${key}\r\n$${value.length}\r\n${value}\r\n` +
      `$2\r\nEX\r\n$${ttl.length}\r\n${ttl}\r\n`;
    return this.send(cmd);
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.connectPromise = null;
    this.buffer = "";
    this.queue = [];
  }

  get isConnected(): boolean {
    return this.connected;
  }
}

// ---------------------------------------------------------------------------
// Cache facade
// ---------------------------------------------------------------------------

const redis = new RedisCacheClient();
const redisUrl = process.env["REDIS_URL"];
if (redisUrl) {
  redis.connect(redisUrl);
} else {
  logger.warn("[cache] REDIS_URL not set — using in-memory cache (not shared across instances)");
}

/** In-memory fallback — same TTL semantics. */
const mem = new Map<string, { value: string; expiresAt: number }>();

function memGet(key: string): string | null {
  const entry = mem.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    mem.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key: string, value: string, ttlSeconds: number): void {
  mem.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export const cache = {
  async get(key: string): Promise<string | null> {
    try {
      if (redis.isConnected) {
        const value = await redis.get(key);
        if (value !== null) return value;
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "[cache] Redis GET failed — falling back to memory");
    }
    return memGet(key);
  },

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      if (redis.isConnected) {
        await redis.set(key, value, ttlSeconds);
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "[cache] Redis SET failed — falling back to memory");
    }
    memSet(key, value, ttlSeconds);
  },

  /**
   * Cache-aside helper: returns the cached value for `key`, or computes it
   * with `producer`, stores it for `ttlSeconds`, and returns it.
   */
  async remember<T>(key: string, ttlSeconds: number, producer: () => Promise<T>): Promise<T> {
    const cached = await this.get(key);
    if (cached !== null) {
      try {
        return JSON.parse(cached) as T;
      } catch {
        // Corrupt entry — ignore and recompute.
      }
    }
    const value = await producer();
    const serialised = JSON.stringify(value);
    // Fire-and-forget; a failed write should never fail the request.
    void this.set(key, serialised, ttlSeconds).catch(() => undefined);
    return value;
  },

  /**
   * Verifies that Redis is reachable and responsive.
   * If REDIS_URL is set (or required in production), performs connect and PING.
   * Throws an Error if Redis cannot be reached.
   */
  async checkReady(timeoutMs = 5000): Promise<void> {
    const url = process.env["REDIS_URL"];
    if (!url) {
      if (process.env["NODE_ENV"] === "production") {
        throw new Error("REDIS_URL is required in production");
      }
      return;
    }

    const connectP = redis.connect(url);
    const timeoutP = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Redis connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    });

    await Promise.race([connectP, timeoutP]);

    const pong = await redis.ping();
    if (!pong) {
      throw new Error("Redis ping returned empty response");
    }
  },

  /**
   * Returns the current generation number for a logical cache namespace
   * (e.g. "trades:list"). Defaults to 0 when nothing has been stored yet.
   *
   * Used together with `bumpVersion` to invalidate a whole family of keys
   * (every filter/pagination combination of a listing endpoint) without the
   * RESP client needing to support KEYS/SCAN/DEL with pattern matching —
   * callers fold the version into the cache key, so once it changes every
   * previously cached entry simply stops being read (issue #76).
   */
  async getVersion(namespace: string): Promise<number> {
    const raw = await this.get(`version:${namespace}`);
    const parsed = raw !== null ? parseInt(raw, 10) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  },

  /**
   * Increments and persists the generation number for `namespace`, so the
   * next `getVersion` call (and therefore every key computed from it) is new.
   * Call this whenever the underlying data a cached listing depends on
   * changes (a trade is created, or an existing trade's status changes).
   */
  async bumpVersion(namespace: string): Promise<number> {
    const current = await this.getVersion(namespace);
    const next = current + 1;
    // 30 days — effectively "until next bump"; only used as a key fragment.
    await this.set(`version:${namespace}`, String(next), 60 * 60 * 24 * 30);
    return next;
  },

  disconnect(): void {
    redis.disconnect();
  },

  getClient(): RedisCacheClient {
    return redis;
  },
};
