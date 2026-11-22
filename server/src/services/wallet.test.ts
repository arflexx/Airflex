import type { PoolClient } from "pg";
import { WalletService } from "./wallet";

/**
 * In-memory stand-in for the two tables WalletService touches. Every query
 * yields to the event loop first so concurrently started operations genuinely
 * interleave. `UPDATE users SET balance = balance + $1` is applied as a single
 * step, mirroring the row lock Postgres takes for a relative update.
 */
class FakeLedgerDb {
  balances = new Map<string, number>();
  ledger: Array<{ user_id: string; amount: number; direction: string; type: string; external_reference: string | null }> = [];
  statements: string[] = [];
  /** external references that the fake treats as already-present (conflict). */
  conflictRefs = new Set<string>();

  client(): PoolClient {
    return { query: (sql: string, params?: unknown[]) => this.query(sql, params ?? []) } as unknown as PoolClient;
  }

  ledgerNet(userId: string): number {
    return this.ledger
      .filter((r) => r.user_id === userId)
      .reduce((sum, r) => sum + (r.direction === "credit" ? r.amount : -r.amount), 0);
  }

  private async query(sql: string, p: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)));
    const stmt = sql.replace(/\s+/g, " ").trim();
    this.statements.push(stmt);

    if (stmt.startsWith("INSERT INTO transactions")) {
      const ref = (p[5] as string | null) ?? null;
      if (ref && this.conflictRefs.has(ref)) return { rows: [], rowCount: 0 };
      this.ledger.push({
        user_id: p[0] as string,
        amount: p[2] as number,
        direction: p[3] as string,
        type: p[4] as string,
        external_reference: ref,
      });
      return { rows: [], rowCount: 1 };
    }
    if (stmt.startsWith("UPDATE users SET balance = balance + $1 WHERE id = $2")) {
      const id = p[1] as string;
      this.balances.set(id, round2((this.balances.get(id) ?? 0) + Number(p[0])));
      return { rows: [], rowCount: 1 };
    }
    if (stmt.startsWith("UPDATE wallets SET fiat_balance")) {
      return { rows: [], rowCount: 1 };
    }
    if (stmt.startsWith("SELECT balance FROM users WHERE id = $1")) {
      const id = p[0] as string;
      return this.balances.has(id)
        ? { rows: [{ balance: String(this.balances.get(id)) }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    throw new Error(`FakeLedgerDb: unsupported SQL: ${stmt}`);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const USER = "11111111-1111-4111-8111-111111111111";
const TRADE = "22222222-2222-4222-8222-222222222222";

describe("WalletService denormalised balance", () => {
  let db: FakeLedgerDb;

  beforeEach(() => {
    db = new FakeLedgerDb();
    db.balances.set(USER, 0);
  });

  it("increments users.balance on credit and decrements it on debit", async () => {
    const wallet = new WalletService(db.client());
    await wallet.credit({ userId: USER, amount: 500, type: "deposit", externalReference: "ref-1" });
    await wallet.debit(USER, 120.5, TRADE);

    expect(await wallet.getBalance(USER)).toBe(379.5);
    expect(db.ledgerNet(USER)).toBe(379.5);
  });

  it("keeps the balance equal to the ledger sum under 200 concurrent credits and debits", async () => {
    const ops: Array<Promise<unknown>> = [];
    let expected = 0;

    for (let i = 0; i < 200; i++) {
      // Each operation gets its own WalletService, as separate requests would.
      const wallet = new WalletService(db.client());
      const amount = ((i % 7) + 1) * 10.25;
      if (i % 3 === 0) {
        expected -= amount;
        ops.push(wallet.debit(USER, amount, TRADE));
      } else {
        expected += amount;
        ops.push(
          wallet.credit({ userId: USER, amount, type: "trade_settlement", tradeId: TRADE })
        );
      }
    }

    await Promise.all(ops);

    expect(db.ledger).toHaveLength(200);
    expect(db.balances.get(USER)).toBe(round2(expected));
    expect(db.balances.get(USER)).toBe(round2(db.ledgerNet(USER)));
  });

  it("isolates concurrent operations across different users", async () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    db.balances.set(OTHER, 0);

    await Promise.all([
      ...Array.from({ length: 50 }, () =>
        new WalletService(db.client()).credit({ userId: USER, amount: 2, type: "referral_reward", tradeId: TRADE })
      ),
      ...Array.from({ length: 50 }, () =>
        new WalletService(db.client()).debitEntry({ userId: OTHER, amount: 3, type: "withdrawal", externalReference: null })
      ),
    ]);

    expect(db.balances.get(USER)).toBe(100);
    expect(db.balances.get(OTHER)).toBe(-150);
  });

  it("leaves the balance untouched when the ledger insert is skipped by a conflict", async () => {
    db.conflictRefs.add("dup-ref");
    const wallet = new WalletService(db.client());

    const applied = await wallet.debitEntry({
      userId: USER,
      amount: 75,
      type: "withdrawal",
      externalReference: "dup-ref",
    });

    expect(applied).toBe(false);
    expect(db.balances.get(USER)).toBe(0);
    expect(db.statements.some((s) => s.startsWith("UPDATE users SET balance"))).toBe(false);
  });

  it("does not bump wallets.fiat_balance for a duplicate deposit", async () => {
    db.conflictRefs.add("dup-deposit");
    const wallet = new WalletService(db.client());

    await wallet.credit({ userId: USER, amount: 500, type: "deposit", externalReference: "dup-deposit" });

    expect(db.balances.get(USER)).toBe(0);
    expect(db.statements.some((s) => s.startsWith("UPDATE wallets SET fiat_balance"))).toBe(false);
  });

  it("reads the balance from the denormalised column without aggregating transactions", async () => {
    db.balances.set(USER, 42.1);
    const wallet = new WalletService(db.client());

    expect(await wallet.getBalance(USER)).toBe(42.1);
    expect(db.statements).toEqual(["SELECT balance FROM users WHERE id = $1 LIMIT 1"]);
  });

  it("issues the ledger insert and balance update on the caller's client (same transaction)", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const wallet = new WalletService({ query } as unknown as PoolClient);

    await wallet.credit({ userId: USER, amount: 10, type: "platform_fee", tradeId: TRADE });

    const sql = query.mock.calls.map(([s]) => (s as string).replace(/\s+/g, " ").trim());
    expect(sql[0]).toMatch(/^INSERT INTO transactions/);
    expect(sql[1]).toBe("UPDATE users SET balance = balance + $1 WHERE id = $2");
    expect(query.mock.calls[1]![1]).toEqual([10, USER]);
  });
});
