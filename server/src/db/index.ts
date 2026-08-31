/**
 * db/index.ts — database layer barrel export.
 *
 * Route and service modules historically import the connection pool with a
 * default import: `import pool from "../db"`. The pool now lives in ./pool.ts;
 * this barrel keeps that import style working while also exposing the named
 * `query` helper.
 */
export { pool as default, query } from "./pool";
