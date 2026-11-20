import { Router } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/authenticate";
import { SseEmitter } from "../services/sseEmitter";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/v1/events  (authenticated)
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
 * using the built-in EventSource retry mechanism. A `: heartbeat` comment
 * line is sent every 30 seconds to keep the stream alive through proxies.
 *
 * Example (browser):
 *   const es = new EventSource("/api/v1/events", { headers: { Authorization: "Bearer ..." } });
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

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Set retry field in SSE response to guide client reconnect timing (issue #619)
  res.write("retry: 3000\n\n");

  // Hand the response over to the SSE hub — it replays events
  // missed since Last-Event-ID (sent automatically by EventSource on
  // reconnect), and keeps the connection alive until the client disconnects.
  SseEmitter.addClient(userId, res, req.header("last-event-id"));
});

export default router;
