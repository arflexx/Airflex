import type { Page, Route } from "@playwright/test";

/**
 * Shared API mocking for the e2e suite (Issue #30).
 *
 * Intercepts are used rather than MSW: the requests worth controlling here all
 * cross the network boundary to the API origin, which `page.route` catches
 * without adding a service worker to the app bundle.
 */

export const API_URL = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

export type TradeStatus = "Active" | "Locked";

export const TEST_TRADE = {
  id: "trade_e2e_001",
  seller_id: "seller_1",
  buyer_id: null,
  asset_type: "MTN",
  amount: 5000,
  fee_amount: 50,
  seller_net_amount: 4950,
  status: "Active",
  contract_listing_id: "listing_1",
  escrow_tx_hash: null,
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * Build a JWT the middleware will accept.
 *
 * `middleware.ts` decodes the payload and checks `exp`; it does not verify a
 * signature, so a well-formed unsigned token is enough for a test and no secret
 * has to be shared with the suite.
 */
export function testJwt(payload: Record<string, unknown> = {}): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const body = {
    sub: "user_e2e",
    role: "user",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payload,
  };

  return `${encode({ alg: "none", typ: "JWT" })}.${encode(body)}.sig`;
}

/**
 * Sign the browser in.
 *
 * Two things are needed, and missing either sends every guarded page to
 * /auth/signup: the middleware reads an `Authorization` cookie, while the
 * client reads a namespaced `airflex:token` from localStorage (app/lib/auth.ts).
 */
export async function signIn(page: Page, payload: Record<string, unknown> = {}) {
  const token = testJwt(payload);

  await page.context().addCookies([
    { name: "Authorization", value: token, url: "http://localhost:3000" },
  ]);

  await page.addInitScript((value) => {
    window.localStorage.setItem("airflex:token", value as string);
  }, token);
}

/** Stub the wallet endpoints. */
export async function mockWallet(page: Page, state: { balance: string }) {
  await page.route(`${API_URL}/api/v1/wallet`, (route) =>
    json(route, {
      publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      balance: state.balance,
      asset: "XLM",
      network: "testnet",
    }),
  );
}

/** Stub deposit initialisation, returning a Paystack access code. */
export async function mockDepositInitialize(page: Page, accessCode = "ACCESS_CODE_E2E") {
  await page.route(`${API_URL}/api/wallet/deposit/initialize`, (route) =>
    json(route, { access_code: accessCode, reference: "ref_e2e_001" }),
  );
}

/**
 * Replace Paystack's inline script with a stub.
 *
 * The real script is blocked and a fake `PaystackPop` installed, so the test
 * drives the success and cancel callbacks itself. Loading Paystack for real
 * would make the suite depend on a third party being up.
 */
export async function mockPaystack(
  page: Page,
  outcome: "success" | "cancel" | "error" = "success",
) {
  await page.route("https://js.paystack.co/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
  );

  await page.addInitScript((result) => {
    class FakePaystackPop {
      resumeTransaction(
        _accessCode: string,
        callbacks?: {
          onSuccess?: (t: { reference?: string }) => void;
          onCancel?: () => void;
          onError?: (e: { message?: string }) => void;
        },
      ) {
        // Defer so the modal finishes its state transition first, exactly as
        // the real popup would.
        setTimeout(() => {
          if (result === "success") callbacks?.onSuccess?.({ reference: "ref_e2e_001" });
          else if (result === "cancel") callbacks?.onCancel?.();
          else callbacks?.onError?.({ message: "Card declined" });
        }, 50);
      }
    }
    (window as unknown as { PaystackPop: unknown }).PaystackPop = FakePaystackPop;
  }, outcome);
}

/** Stub the marketplace listing feed. */
export async function mockTradeList(page: Page, trades = [TEST_TRADE]) {
  await page.route(`${API_URL}/api/v1/trades**`, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return json(route, { data: trades });
  });
}

/** Stub a single trade, and the buy call that locks it into escrow. */
export async function mockTradeDetail(page: Page, trade = TEST_TRADE) {
  await page.route(`${API_URL}/api/v1/trades/${trade.id}`, (route) => {
    if (route.request().method() === "GET") return json(route, { data: trade });
    return route.fallback();
  });

  await page.route(`${API_URL}/api/v1/trades/${trade.id}/buy`, (route) =>
    json(route, { data: { ...trade, status: "Locked", escrow_tx_hash: "abc123txhash" } }),
  );
}

/** Stub signup and OTP verification. */
export async function mockAuth(page: Page) {
  await page.route(`${API_URL}/api/v1/auth/**`, (route) =>
    json(route, { success: true, token: "e2e-test-token", userId: "user_e2e" }),
  );
}

/** Stub the signed-in user's profile. */
export async function mockProfile(page: Page, profile: { kycStatus?: string } = {}) {
  await page.route(`${API_URL}/api/v1/profile`, (route) =>
    json(route, {
      data: {
        id: "user_e2e",
        kycStatus: "verified",
        ...profile,
      },
    }),
  );
}

/** Stub listing creation, returning the trade id the confirmation shows. */
export async function mockCreateListing(page: Page, tradeId = TEST_TRADE.id) {
  await page.route(`${API_URL}/api/v1/trades`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return json(route, { data: { ...TEST_TRADE, id: tradeId } }, 201);
  });
}
