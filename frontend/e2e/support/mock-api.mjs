/**
 * Stub API server for the e2e suite (Issue #30).
 *
 * Browser-level `page.route` intercepts cannot see fetches made by Next.js
 * Server Components — those run in the Node process and never touch the
 * browser. `/` and `/trades/[id]` render server-side, so they need a real
 * endpoint to talk to. This is it: a few fixtures over plain http, no
 * database and no blockchain.
 *
 * Client-side calls are still intercepted in-test, which keeps per-test
 * control (a cancelled payment, a changed balance) where it belongs.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_API_PORT ?? 3001);

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

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    return res.end();
  }

  if (url.pathname === `/api/v1/trades/${TEST_TRADE.id}`) {
    return send(res, 200, { data: TEST_TRADE });
  }

  if (url.pathname.startsWith("/api/v1/trades/") && url.pathname.endsWith("/buy")) {
    return send(res, 200, {
      data: { ...TEST_TRADE, status: "Locked", escrow_tx_hash: "abc123txhash" },
    });
  }

  // An unknown trade id must 404, so the not-found path stays testable.
  if (url.pathname.startsWith("/api/v1/trades/")) {
    return send(res, 404, { error: "not found" });
  }

  if (url.pathname === "/api/v1/trades") {
    if (req.method === "POST") return send(res, 201, { data: TEST_TRADE });
    return send(res, 200, { data: [TEST_TRADE] });
  }

  if (url.pathname === "/api/v1/wallet") {
    return send(res, 200, {
      publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      balance: "1000",
      asset: "XLM",
      network: "testnet",
    });
  }

  if (url.pathname.startsWith("/api/v1/auth")) {
    return send(res, 200, { success: true, token: "e2e-test-token", userId: "user_e2e" });
  }

  if (url.pathname === "/api/wallet/deposit/initialize") {
    return send(res, 200, { access_code: "ACCESS_CODE_E2E", reference: "ref_e2e_001" });
  }

  if (url.pathname === "/health") return send(res, 200, { ok: true });

  return send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`mock api listening on ${PORT}`);
});
