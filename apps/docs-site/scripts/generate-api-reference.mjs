#!/usr/bin/env node
// -----------------------------------------------------------------------------
// generate-api-reference.mjs
//
// Reads openapi/openapi.json (the canonical spec for the server API) and
// writes one MDX page per OpenAPI tag under pages/api-reference/, plus a
// _meta.json so Nextra orders the sidebar correctly. It also copies the raw
// spec to public/openapi.json so it can be downloaded / fed into tools like
// Postman or Redoc directly.
//
// Source of truth: openapi/openapi.json. Keep it in sync with
// server/src/routes/*.ts and server/src/schemas/*.ts, then re-run
// `npm run generate:api` (this also runs automatically before `dev`/`build`).
// -----------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, "..");
const SPEC_PATH = path.join(SITE_ROOT, "openapi", "openapi.json");
const OUT_DIR = path.join(SITE_ROOT, "pages", "api-reference");
const PUBLIC_COPY_PATH = path.join(SITE_ROOT, "public", "openapi.json");

function slugify(tag) {
  return tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function schemaToText(schema, spec, depth = 0) {
  if (!schema) return "unknown";
  if (schema.$ref) {
    const refName = schema.$ref.split("/").pop();
    return refName;
  }
  if (schema.type === "array") {
    return `${schemaToText(schema.items, spec, depth)}[]`;
  }
  if (schema.type === "object" && schema.properties) {
    return "object";
  }
  return schema.type || "unknown";
}

function renderParams(params) {
  if (!params || params.length === 0) return "";
  const rows = params
    .map((p) => {
      const required = p.required ? "**required**" : "optional";
      const type = p.schema?.type ?? "string";
      const constraints = [
        p.schema?.minimum !== undefined ? `min ${p.schema.minimum}` : null,
        p.schema?.maximum !== undefined ? `max ${p.schema.maximum}` : null,
        p.schema?.default !== undefined ? `default \`${p.schema.default}\`` : null,
        p.schema?.enum ? `one of ${p.schema.enum.map((e) => `\`${e}\``).join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `| \`${p.name}\` | ${p.in} | ${type} | ${required}${constraints ? ` (${constraints})` : ""} |`;
    })
    .join("\n");

  return `| Name | In | Type | Notes |\n|------|----|------|-------|\n${rows}\n`;
}

function renderRequestBody(requestBody, spec) {
  if (!requestBody) return "";
  const resolved = resolveSchema(requestBody, spec);
  const jsonContent = resolved?.content?.["application/json"];
  if (!jsonContent) return "";
  const example =
    jsonContent.example !== undefined
      ? jsonContent.example
      : buildExample(jsonContent.schema, spec);
  return [
    "**Request body**",
    "",
    "```json",
    JSON.stringify(example, null, 2),
    "```",
    "",
  ].join("\n");
}

function resolveSchema(schema, spec) {
  if (schema?.$ref) {
    const refPath = schema.$ref.replace("#/", "").split("/");
    let node = spec;
    for (const part of refPath) node = node?.[part];
    return node;
  }
  return schema;
}

function buildExample(schema, spec, depth = 0) {
  if (!schema || depth > 4) return null;
  const resolved = resolveSchema(schema, spec);
  if (!resolved) return null;

  if (resolved.example !== undefined) return resolved.example;

  if (resolved.type === "array") {
    return [buildExample(resolved.items, spec, depth + 1)];
  }
  if (resolved.type === "object" || resolved.properties) {
    const out = {};
    for (const [key, propSchema] of Object.entries(resolved.properties ?? {})) {
      out[key] = buildExample(propSchema, spec, depth + 1);
    }
    return out;
  }
  if (resolved.enum) return resolved.enum[0];
  if (resolved.type === "integer") return 1;
  if (resolved.type === "number") return 1.5;
  if (resolved.type === "boolean") return true;
  if (resolved.type === "string") {
    if (resolved.format === "date-time") return "2026-08-24T10:00:00.000Z";
    if (resolved.format === "uuid") return "550e8400-e29b-41d4-a716-446655440000";
    return "string";
  }
  return null;
}

function renderResponses(responses, spec) {
  return Object.entries(responses)
    .map(([code, resp]) => {
      const resolvedResp = resolveSchema(resp, spec);
      const jsonContent = resolvedResp?.content?.["application/json"];
      const example =
        jsonContent?.example !== undefined
          ? jsonContent.example
          : jsonContent
          ? buildExample(jsonContent.schema, spec)
          : null;
      const block = example
        ? ["```json", JSON.stringify(example, null, 2), "```"].join("\n")
        : resolvedResp?.content?.["text/event-stream"]
        ? "`text/event-stream` connection — see description above."
        : "_No body._";
      return `**\`${code}\`** — ${resolvedResp?.description ?? ""}\n\n${block}`;
    })
    .join("\n\n");
}

function renderOperation(method, opPath, op, spec) {
  const security = op.security ? " 🔒" : "";
  const parts = [
    `## \`${method.toUpperCase()} ${opPath}\`${security}`,
    "",
    op.summary ? `**${op.summary}**` : "",
    "",
    op.description ?? "",
    "",
  ];

  const paramsTable = renderParams(op.parameters);
  if (paramsTable) {
    parts.push("**Parameters**", "", paramsTable, "");
  }

  const body = renderRequestBody(op.requestBody, spec);
  if (body) parts.push(body);

  parts.push("**Responses**", "", renderResponses(op.responses, spec), "");
  parts.push("---", "");

  return parts.join("\n");
}

function renderTagPage(tag, description, operations, spec) {
  const body = operations
    .map(({ method, opPath, op }) => renderOperation(method, opPath, op, spec))
    .join("\n");

  return `---
title: ${tag}
---

import { Callout } from "nextra/components";

# ${tag}

<Callout type="info">
  Generated from [\`openapi/openapi.json\`](https://github.com/arflexx/Airflex/blob/main/apps/docs-site/openapi/openapi.json).
  Run \`npm run generate:api\` in \`apps/docs-site\` after changing the spec to
  refresh this page. The raw spec is also served at
  [\`/openapi.json\`](/openapi.json).
</Callout>

${description ?? ""}

${body}
`;
}

function main() {
  if (!fs.existsSync(SPEC_PATH)) {
    console.warn(`[generate-api-reference] No spec found at ${SPEC_PATH}, skipping.`);
    return;
  }

  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PUBLIC_COPY_PATH), { recursive: true });
  fs.copyFileSync(SPEC_PATH, PUBLIC_COPY_PATH);

  const tagDescriptions = Object.fromEntries(
    (spec.tags ?? []).map((t) => [t.name, t.description])
  );

  // Group every operation by its first tag.
  const byTag = new Map();
  for (const [opPath, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      const tag = (op.tags && op.tags[0]) || "Other";
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({ method, opPath, op });
    }
  }

  const meta = { index: "Overview" };

  for (const [tag, operations] of byTag.entries()) {
    const slug = slugify(tag);
    const mdx = renderTagPage(tag, tagDescriptions[tag], operations, spec);
    fs.writeFileSync(path.join(OUT_DIR, `${slug}.mdx`), mdx, "utf8");
    meta[slug] = tag;
    console.log(`[generate-api-reference] Wrote pages/api-reference/${slug}.mdx (${operations.length} operation(s))`);
  }

  fs.writeFileSync(path.join(OUT_DIR, "_meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

main();
