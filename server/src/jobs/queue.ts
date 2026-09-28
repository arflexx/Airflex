/**
 * queue.ts — Lightweight background job queue backed by Redis via ioredis-compatible
 * raw TCP commands, or an in-process memory queue when Redis is unavailable.
 *
 * Architecture
 * ------------
 * This module provides a typed job-queue abstraction that mirrors the BullMQ
 * interface shape described in issue #77. It uses Node's built-in net/crypto
 * modules so no additional npm packages are required.
 *
 * When REDIS_URL is set, jobs are persisted to Redis as JSON values in a list
 * per queue. A polling loop dequeues and processes them. This gives durability,
 * retry tracking, and dead-letter storage across process restarts.
 *
 * When REDIS_URL is absent (local dev without Redis), an in-process Map-based
 * queue is used. Jobs are lost on restart but behaviour is identical otherwise.
 *
 * Retry policy
 * ------------
 * Each job is retried up to MAX_ATTEMPTS (3) times on failure with truncated
 * exponential back-off. After all attempts are exhausted the job is moved to
 * a dead-letter list (<name>:dead) and logged as a structured error.
 *
 * Queue names (exported as JOB_QUEUES)
 * -------------------------------------
 *   fund-stellar-account    — fund a new user wallet via Friendbot
 *   create-virtual-account  — create a Paystack virtual account for a user
 *   send-notification       — dispatch an SMS/email notification via Termii
 *   verify-trade-delivery   — async delivery verification with Soroban oracle
 *   process-paystack-webhook — async Paystack webhook processing (#118)
 *   refund-cancelled-trade  — async on-chain escrow refund for a buyer whose
 *                             Locked trade was cancelled (e.g. by account
 *                             deletion — see routes/profile.ts)
 */

import { randomBytes } from "crypto";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const JOB_QUEUES = [
  "fund-stellar-account",
  "create-virtual-account",
  "send-notification",
  "verify-trade-delivery",
  "process-paystack-webhook",
  "refund-cancelled-trade",
] as const;

export type QueueName = (typeof JOB_QUEUES)[number];

const MAX_ATTEMPTS    = 3;
const BASE_DELAY_MS   = 2_000;   // first retry delay
const POLL_INTERVAL   = 1_000;   // ms between dequeue polls
const MAX_DEAD_STORED = 100;      // recent failures kept in memory for /api/admin/queues

// ---------------------------------------------------------------------------
// Job shape
// ---------------------------------------------------------------------------

export interface Job<T = unknown> {
  id:          string;
  queue:       QueueName;
  data:        T;
  attempts:    number;       // attempts so far (0 = not yet tried)
  maxAttempts: number;
  createdAt:   string;       // ISO timestamp
  nextRunAt:   number;       // epoch ms — 0 means run immediately
  failedReason?: string;
}

export interface DeadJob<T = unknown> extends Job<T> {
  failedAt:    string;       // ISO timestamp of final failure
}

// ---------------------------------------------------------------------------
// Per-queue stats tracked in memory
// ---------------------------------------------------------------------------

interface QueueStats {
  name:       QueueName;
  waiting:    number;
  active:     number;
  completed:  number;
  failed:     number;
  delayed:    number;
  recentFailures: Array<{
    jobId:        string;
    data:         unknown;
    failedReason: string;
    timestamp:    string;
  }>;
}

// ---------------------------------------------------------------------------
// Processor registry
// ---------------------------------------------------------------------------

type Processor<T = unknown> = (job: Job<T>) => Promise<void>;

// ---------------------------------------------------------------------------
// Redis client — thin wrapper using Node's net.Socket
// ---------------------------------------------------------------------------

import { Socket } from "net";

/**
 * Minimal Redis client that speaks the RESP protocol over a raw TCP socket.
 * Supports only the commands we need: RPUSH, LPOP, LLEN, RPUSH (to dead queue).
 * If the connection drops, commands resolve with null and the in-process fallback
 * is used transparently.
 */
class MinimalRedisClient {
  private socket:   Socket | null    = null;
  private connected = false;
  private queue:    Array<{ resolve: (v: string | null) => void; reject: (e: Error) => void }> = [];
  private buffer    = "";

  connect(url: string): void {
    try {
      const parsed = new URL(url);
      const host   = parsed.hostname;
      const port   = parseInt(parsed.port || "6379", 10);
      const pass   = parsed.password || null;

      this.socket = new Socket();
      this.socket.setEncoding("utf8");

      this.socket.connect(port, host, () => {
        this.connected = true;
        if (pass) {
          // AUTH command — fire and forget before we start queueing user commands
          this.socket!.write(`*2\r\n$4\r\nAUTH\r\n$${pass.length}\r\n${pass}\r\n`);
        }
        logger.info({ host, port }, "[queue] Redis connected");
      });

      this.socket.on("data", (chunk: string) => {
        this.buffer += chunk;
        this.flushBuffer();
      });

      this.socket.on("error", (err) => {
        logger.warn({ err: err.message }, "[queue] Redis socket error — using in-process fallback");
        this.connected = false;
        // Drain waiting promises with null
        for (const p of this.queue) p.resolve(null);
        this.queue = [];
      });

      this.socket.on("close", () => {
        this.connected = false;
        logger.warn("[queue] Redis connection closed");
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "[queue] Redis connect failed — using in-process fallback");
    }
  }

  private flushBuffer(): void {
    // Parse simple RESP replies: +OK, :integer, $bulk, *array (we only need these)
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
        // Skip AUTH response or unexpected data
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

  /** RPUSH key value — returns new list length or null on error */
  async rpush(key: string, value: string): Promise<number | null> {
    const encoded = `:${value.length}\r\n`;
    const cmd = `*3\r\n$5\r\nRPUSH\r\n$${key.length}\r\n${key}\r\n$${value.length}\r\n${value}\r\n`;
    const res = await this.send(cmd);
    return res !== null ? parseInt(res, 10) : null;
  }

  /** LPOP key — returns the leftmost element or null */
  async lpop(key: string): Promise<string | null> {
    const cmd = `*2\r\n$4\r\nLPOP\r\n$${key.length}\r\n${key}\r\n`;
    return this.send(cmd);
  }

  /** LLEN key — returns list length or null */
  async llen(key: string): Promise<number | null> {
    const cmd = `*2\r\n$4\r\nLLEN\r\n$${key.length}\r\n${key}\r\n`;
    const res = await this.send(cmd);
    return res !== null ? parseInt(res, 10) : null;
  }

  get isConnected(): boolean { return this.connected; }
}

// ---------------------------------------------------------------------------
// QueueService singleton
// ---------------------------------------------------------------------------

/**
 * QueueService — manages all job queues, processors, and stats.
 *
 * Usage:
 *   QueueService.register("fund-stellar-account", fundStellarAccountProcessor);
 *   QueueService.enqueue("fund-stellar-account", { userId: "..." });
 *   const stats = QueueService.getStats();
 */
class QueueServiceClass {
  private redis       = new MinimalRedisClient();
  private processors  = new Map<QueueName, Processor>();
  private memQueues   = new Map<QueueName, Job[]>();          // in-process fallback
  private memDead     = new Map<QueueName, DeadJob[]>();      // dead-letter (in-process)
  private stats       = new Map<QueueName, QueueStats>();
  private activeJobs  = new Map<QueueName, number>();         // count of running processors
  private polling     = false;

  constructor() {
    for (const name of JOB_QUEUES) {
      this.memQueues.set(name, []);
      this.memDead.set(name, []);
      this.stats.set(name, {
        name,
        waiting:        0,
        active:         0,
        completed:      0,
        failed:         0,
        delayed:        0,
        recentFailures: [],
      });
      this.activeJobs.set(name, 0);
    }
  }

  /** Connect to Redis (call once at startup). */
  init(): void {
    const redisUrl = process.env["REDIS_URL"];
    if (redisUrl) {
      this.redis.connect(redisUrl);
    } else {
      logger.warn("[queue] REDIS_URL not set — using in-process job queue (jobs lost on restart)");
    }
    this.startPolling();
  }

  /** Register a processor function for a queue. */
  register<T>(name: QueueName, processor: Processor<T>): void {
    this.processors.set(name, processor as Processor);
    logger.info({ queue: name }, "[queue] Processor registered");
  }

  /** Add a job to a queue. */
  async enqueue<T>(name: QueueName, data: T, delayMs = 0): Promise<string> {
    const job: Job<T> = {
      id:          randomBytes(8).toString("hex"),
      queue:       name,
      data,
      attempts:    0,
      maxAttempts: MAX_ATTEMPTS,
      createdAt:   new Date().toISOString(),
      nextRunAt:   delayMs > 0 ? Date.now() + delayMs : 0,
    };

    const serialised = JSON.stringify(job);

    if (this.redis.isConnected) {
      await this.redis.rpush(`queue:${name}`, serialised);
    } else {
      this.memQueues.get(name)!.push(job as Job);
    }

    this.getStat(name).waiting++;
    if (delayMs > 0) this.getStat(name).delayed++;

    logger.debug({ queue: name, jobId: job.id }, "[queue] Job enqueued");
    return job.id;
  }

  /** Returns a snapshot of all queue stats for the admin endpoint. */
  getStats(): QueueStats[] {
    return JOB_QUEUES.map((name) => ({ ...this.getStat(name) }));
  }

  // -------------------------------------------------------------------------
  // Internal — polling loop
  // -------------------------------------------------------------------------

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      for (const name of JOB_QUEUES) {
        const processor = this.processors.get(name);
        if (!processor) continue;

        const raw = await this.dequeue(name);
        if (!raw) continue;

        let job: Job;
        try {
          job = JSON.parse(raw) as Job;
        } catch {
          logger.error({ raw }, "[queue] Failed to parse job — discarding");
          continue;
        }

        // Skip delayed jobs not yet due
        if (job.nextRunAt > 0 && job.nextRunAt > Date.now()) {
          // Re-enqueue for later
          await this.requeue(name, job);
          continue;
        }

        // Run processor
        void this.runJob(name, job, processor);
      }
      await sleep(POLL_INTERVAL);
    }
  }

  private async dequeue(name: QueueName): Promise<string | null> {
    if (this.redis.isConnected) {
      return this.redis.lpop(`queue:${name}`);
    }
    const queue = this.memQueues.get(name)!;
    if (queue.length === 0) return null;
    return JSON.stringify(queue.shift()!);
  }

  private async requeue(name: QueueName, job: Job): Promise<void> {
    const serialised = JSON.stringify(job);
    if (this.redis.isConnected) {
      await this.redis.rpush(`queue:${name}`, serialised);
    } else {
      this.memQueues.get(name)!.push(job);
    }
  }

  private async runJob(name: QueueName, job: Job, processor: Processor): Promise<void> {
    const stat = this.getStat(name);
    stat.waiting  = Math.max(0, stat.waiting - 1);
    stat.active++;
    job.attempts++;

    logger.debug({ queue: name, jobId: job.id, attempt: job.attempts }, "[queue] Job started");

    try {
      await processor(job);
      stat.active--;
      stat.completed++;
      logger.debug({ queue: name, jobId: job.id }, "[queue] Job completed");
    } catch (err) {
      stat.active--;
      stat.failed++;

      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ queue: name, jobId: job.id, attempt: job.attempts, reason }, "[queue] Job failed");

      if (job.attempts < job.maxAttempts) {
        // Exponential back-off with ±20% jitter
        const delay = backoffDelay(job.attempts);
        job.nextRunAt    = Date.now() + delay;
        job.failedReason = reason;

        logger.info({ queue: name, jobId: job.id, retryIn: delay }, "[queue] Scheduling retry");
        await this.requeue(name, job);
        stat.delayed++;
      } else {
        // Dead-letter
        const deadJob: DeadJob = {
          ...job,
          failedReason: reason,
          failedAt:     new Date().toISOString(),
        };

        await this.moveToDead(name, deadJob);

        // Keep only the most recent MAX_DEAD_STORED failures in memory
        const recent = stat.recentFailures;
        recent.unshift({
          jobId:        job.id,
          data:         job.data,
          failedReason: reason,
          timestamp:    deadJob.failedAt,
        });
        if (recent.length > MAX_DEAD_STORED) recent.length = MAX_DEAD_STORED;

        logger.error(
          { queue: name, jobId: job.id, reason },
          "[queue] Job permanently failed — moved to dead-letter queue"
        );
      }
    }
  }

  private async moveToDead(name: QueueName, deadJob: DeadJob): Promise<void> {
    const serialised = JSON.stringify(deadJob);
    if (this.redis.isConnected) {
      await this.redis.rpush(`queue:${name}:dead`, serialised);
    } else {
      const dead = this.memDead.get(name)!;
      dead.push(deadJob);
      if (dead.length > MAX_DEAD_STORED) dead.shift();
    }
  }

  private getStat(name: QueueName): QueueStats {
    return this.stats.get(name)!;
  }
}

// Singleton export
export const QueueService = new QueueServiceClass();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function backoffDelay(attempt: number): number {
  const base   = BASE_DELAY_MS * Math.pow(2, attempt - 1);
  const capped = Math.min(base, 30_000);
  const jitter = capped * 0.2 * (Math.random() * 2 - 1);
  return Math.round(capped + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
