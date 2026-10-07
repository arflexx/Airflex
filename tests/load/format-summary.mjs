#!/usr/bin/env node
/**
 * Build a Markdown summary and comparison table from k6 --summary-export JSON files.
 */
import { runComparison } from "./compare-baseline.mjs";

const comparison = runComparison();
console.log(comparison.report);
