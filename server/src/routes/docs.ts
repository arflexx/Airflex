/**
 * docs.ts — Serves the OpenAPI 3.1 specification and Swagger UI.
 *
 * GET /api/docs.json  — Raw OpenAPI document (always available)
 * GET /api/docs       — Swagger UI HTML (disabled in production unless
 *                       ENABLE_API_DOCS=true)
 *
 * Swagger UI is loaded from the official CDN so no npm package is required.
 * The UI is intentionally disabled in production to avoid leaking internal
 * API surface to the public internet. Set ENABLE_API_DOCS=true on staging
 * or review environments to re-enable it.
 */

import { Router, Request, Response } from "express";
import { openApiDocument } from "../openapi";

const router = Router();

// ---------------------------------------------------------------------------
// Helper — should docs UI be served?
// ---------------------------------------------------------------------------

function isDocsEnabled(): boolean {
  if (process.env["NODE_ENV"] !== "production") return true;
  return process.env["ENABLE_API_DOCS"] === "true";
}

// ---------------------------------------------------------------------------
// GET /api/docs.json
// ---------------------------------------------------------------------------

/**
 * Always-available raw OpenAPI 3.1 document as JSON.
 * Used by CI diff checks, code generators, and Postman imports.
 */
router.get("/docs.json", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json(openApiDocument);
});

// ---------------------------------------------------------------------------
// GET /api/docs
// ---------------------------------------------------------------------------

/**
 * Swagger UI — served as an inline HTML page that loads assets from the
 * official Swagger UI CDN. No npm package required.
 *
 * Disabled in production unless ENABLE_API_DOCS=true.
 */
router.get("/docs", (req: Request, res: Response) => {
  if (!isDocsEnabled()) {
    res.status(404).json({
      error:
        "API documentation is disabled in production. " +
        "Set ENABLE_API_DOCS=true to enable it.",
    });
    return;
  }

  // Build the absolute URL for the spec JSON so the UI can fetch it
  const protocol = req.headers["x-forwarded-proto"] ?? req.protocol;
  const host = req.headers["x-forwarded-host"] ?? req.get("host") ?? "localhost";
  const specUrl = `${protocol}://${host}/api/docs.json`;

  const html = buildSwaggerHtml(specUrl);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.status(200).send(html);
});

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

function buildSwaggerHtml(specUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AirFlex API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; padding: 0; }
    .topbar { display: none; }
    .swagger-ui .info .title { color: #7D00FF; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function () {
      SwaggerUIBundle({
        url: ${JSON.stringify(specUrl)},
        dom_id: "#swagger-ui",
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset,
        ],
        layout: "StandaloneLayout",
        deepLinking: true,
        displayRequestDuration: true,
        persistAuthorization: true,
        tryItOutEnabled: true,
        filter: true,
      });
    };
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// DEV/TEST only — verify async error handling
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/test-async-error
 *
 * Dev/test route that throws an async error to verify express-async-errors
 * properly forwards it to the global error handler.
 *
 * Gated behind NODE_ENV !== "production".
 */
if (process.env["NODE_ENV"] !== "production") {
  router.get(["/test-async-error", "/v1/test-async-error"], (_req: Request, res: Response) => {
    throw new Error("async test");
  });
}

export default router;
