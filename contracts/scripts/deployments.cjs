#!/usr/bin/env node
"use strict";

/**
 * deployments.cjs — reads and writes contracts/deployments.json for deploy.sh
 * (issue #645).
 *
 * Commands:
 *   get <file> <network> <contract> <field>
 *       Print one field of an entry ("" when unset).
 *   rollback-target <file> <network> <contract>
 *       Print the WASM hash `--rollback` would redeploy; exit 1 if there is none.
 *   record <file> <network> <contract>
 *       Replace the entry from the environment variables CONTRACT_ID, WASM_HASH,
 *       DEPLOYED_AT, DEPLOYER and IS_ROLLBACK ("yes" | "no"). The replaced entry
 *       moves to `history`.
 *   summary <file> <network>
 *       Print the network's contract IDs.
 *   sha256 <path>
 *       Print a file's SHA-256, which for a WASM file is its on-chain hash.
 */

const { createHash } = require("crypto");
const fs = require("fs");

const FIELDS = ["contract_id", "wasm_hash", "deployed_at", "deployer"];

/**
 * Parses the registry. A missing file is an empty registry, but an unreadable
 * or malformed one is an error: overwriting it would destroy rollback history.
 */
function load(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Writes via a temp file + rename so a crash cannot leave partial JSON. */
function save(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Returns an entry in object form; accepts the legacy bare-string form. */
function readEntry(data, network, contract) {
  const raw = (data[network] || {})[contract];
  const source = typeof raw === "string" ? { contract_id: raw } : raw || {};
  const entry = {};
  for (const field of FIELDS) entry[field] = source[field] || null;
  entry.history = Array.isArray(source.history) ? source.history : [];
  return entry;
}

/**
 * The newest superseded deployment whose WASM differs from what is live.
 * Deployments that were themselves rolled back are skipped, so rolling back
 * twice moves further back instead of returning to the faulty build.
 */
function rollbackTarget(entry) {
  for (let i = entry.history.length - 1; i >= 0; i -= 1) {
    const past = entry.history[i];
    if (past.wasm_hash && past.wasm_hash !== entry.wasm_hash && !past.rolled_back_at) {
      return past.wasm_hash;
    }
  }
  return null;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function record(file, network, contract) {
  const data = load(file);
  const previous = readEntry(data, network, contract);
  const { history, ...superseded } = previous;
  const deployedAt = requireEnv("DEPLOYED_AT");

  if (superseded.contract_id) {
    if (process.env.IS_ROLLBACK === "yes") superseded.rolled_back_at = deployedAt;
    history.push(superseded);
  }

  data[network] = data[network] || {};
  data[network][contract] = {
    contract_id: requireEnv("CONTRACT_ID"),
    wasm_hash: requireEnv("WASM_HASH"),
    deployed_at: deployedAt,
    deployer: requireEnv("DEPLOYER"),
    history,
  };
  save(file, data);
}

function main([command, file, network, contract, field]) {
  switch (command) {
    case "get":
      if (!FIELDS.includes(field)) throw new Error(`unknown field: ${field}`);
      process.stdout.write(readEntry(load(file), network, contract)[field] || "");
      return;
    case "rollback-target": {
      const hash = rollbackTarget(readEntry(load(file), network, contract));
      if (!hash) throw new Error(`no earlier WASM hash recorded for ${contract} on ${network}`);
      process.stdout.write(hash);
      return;
    }
    case "record":
      record(file, network, contract);
      return;
    case "summary": {
      const data = load(file);
      for (const name of Object.keys(data[network] || {})) {
        const entry = readEntry(data, network, name);
        console.log(`  ${name}: ${entry.contract_id || "(not deployed)"}`);
      }
      return;
    }
    case "sha256":
      process.stdout.write(createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
      return;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`deployments.cjs: ${err.message}`);
  process.exit(1);
}
