import { Router } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/authenticate";
import { SseEmitter } from "../services/sseEmitter";

const router: Router = Router();

// ---------------------------------------------------------------------------
// GET /api/events  (authenticated)
// ---------------------------------------------------------------------------

/**
 * Persistent Server-Sent Events stream for the authenticated user.
 *
 * Clients connect once and receive real-time trade status updates:
 *   - trade_completed  — payment released to seller
 *   - trade_disputed   — escalated after failed release attempts
 *   - admin_alert      — broadcast to all clients (ops tooling)
 *   - connected        — sent immediately on connect as a handshake
 *
 * The connection stays open indefinitely. Browsers automatically reconnect
 * using the built-in EventSource retry mechanism.
 *
 * Example (browser):
 *   const es = new EventSource("/api/events", { headers: { Authorization: "Bearer ..." } });
 *   es.addEventListener("trade_completed", (e) => console.log(JSON.parse(e.data)));
 *
 * Note: Authorization header is not directly supported by the browser
 * EventSource API. In practice, pass the token as a query param and
 * validate it here, or use a cookie-based session. For the MVP we accept
 * the token via the Authorization header (works from mobile clients and
 * server-side fetch).
 */
router.get("/", authenticate, (req, res) => {
  const { sub: userId } = (req as AuthenticatedRequest).user;

  // Hand the response over to the SSE hub — it sets headers and keeps
  // the connection alive until the client disconnects.
  SseEmitter.addClient(userId, res);
});

export default router;
