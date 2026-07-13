#!/usr/bin/env node
/**
 * install-secret-scan.mjs
 *
 * Installs the secret-scanning pre-commit hook and verifies the scan script works.
 *
 * Usage:
 *   node scripts/install-secret-scan.mjs
 */

import { execSync } from "node:child_process";
import { existsSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

console.log("=== Installing secret scanning ===");

// 1. Verify scan-secrets.mjs exists
const scanner = path.join(ROOT, "scripts", "scan-secrets.mjs");
if (!existsSync(scanner)) {
  console.error("❌ scripts/scan-secrets.mjs not found — aborting");
  process.exit(1);
}
console.log("✅ scan-secrets.mjs found");

// 2. Configure git to use .githooks directory
try {
  execSync("git config core.hooksPath .githooks", { cwd: ROOT, stdio: "pipe" });
  console.log('✅ git hooks path set to .githooks/');
} catch (e) {
  console.error("❌ Failed to set hooks path:", e.message);
  process.exit(1);
}

// 3. Test the scanner on the working tree (should pass with no secrets now)
console.log("\n=== Testing secret scanner (all tracked files) ===");
try {
  execSync(`node "${scanner}" --all`, { cwd: ROOT, stdio: "inherit", timeout: 60000 });
  console.log("✅ Working tree is clean");
} catch {
  console.error("❌ Found secrets in working tree — fix them first");
  process.exit(1);
}

console.log("\n=== Secret scanning is active ===");
console.log("  Pre-commit hook: .githooks/pre-commit");
console.log("  Scanner script:  scripts/scan-secrets.mjs");
console.log("  Test manually:   node scripts/scan-secrets.mjs --all");
console.log("  Check history:   node scripts/scan-secrets.mjs --history");
