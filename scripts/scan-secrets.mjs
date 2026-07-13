#!/usr/bin/env node
/**
 * scan-secrets.mjs
 *
 * Scans files and git history for accidentally committed secrets.
 * Used by the pre-commit hook and CI.
 *
 * Usage:
 *   node scripts/scan-secrets.mjs              # scan staged files (pre-commit)
 *   node scripts/scan-secrets.mjs --all         # scan entire working tree
 *   node scripts/scan-secrets.mjs --history     # scan git history for secrets
 *   node scripts/scan-secrets.mjs --github      # scan remote repo (GitHub secret scanning API)
 *
 * Exit code: 0 if clean, 1 if secrets found.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ── Patterns ──────────────────────────────────────────────────────────
// These match real secrets. Placeholders / examples are excluded.
const PATTERNS = [
  // Clerk
  { name: "Clerk secret key", pattern: /sk_test_[A-Za-z0-9_]{30,}/, exclude: /your_|placeholder|example|replace|xxx|unknown|fixture|clerk|_x$|_con|_cpr|_cpt|_pay|_pro|_rpc|_sha|_web|_cus|_cws|_bat|conflict|_readonly/ },
  { name: "Clerk live secret key", pattern: /sk_live_[A-Za-z0-9_]{30,}/, exclude: /your_|placeholder|example|replace|xxx/ },
  { name: "Clerk publishable key", pattern: /pk_test_[A-Za-z0-9_]{30,}/, exclude: /your_|placeholder|example|replace|xxx/ },
  { name: "Clerk live publishable key", pattern: /pk_live_[A-Za-z0-9_]{30,}/, exclude: /your_|placeholder|example|replace|xxx/ },
  { name: "Clerk webhook secret", pattern: /whsec_[A-Za-z0-9_/+=]{10,}/, exclude: /your_|placeholder|example|replace|xxx|test_secret/ },

  // GitHub
  { name: "GitHub PAT", pattern: /ghp_[A-Za-z0-9_]{30,}/, exclude: /your_|placeholder|example|replace/ },
  { name: "GitHub OAuth", pattern: /gho_[A-Za-z0-9_]{30,}/, exclude: /your_|placeholder|example|replace/ },
  { name: "GitHub App Token", pattern: /ghu_[A-Za-z0-9_]{30,}/, exclude: /your_|placeholder|example|replace/ },
  { name: "GitHub Refresh", pattern: /ghs_[A-Za-z0-9_]{30,}/, exclude: /your_|placeholder|example|replace/ },

  // Generic
  { name: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/, exclude: /your_|placeholder|example|replace/ },
  { name: "Private key (RSA/EC)", pattern: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH|PRIVATE)\s+KEY-----/, exclude: /your_|placeholder|example|replace/ },
  { name: "Databricks token", pattern: /dapi[A-Za-z0-9]{30,}/, exclude: /your_|placeholder|example|replace/ },
  { name: "Heroku API key", pattern: /[hH][eE][rR][oO][kK][uU].*[aA][pP][iI]_[kK][eE][yY].*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/, exclude: /your_|placeholder|example|replace/ },
  { name: "npm token", pattern: /npm_[A-Za-z0-9_]{30,}/, exclude: /your_|placeholder|example|replace/ },
  { name: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/, exclude: /your_|placeholder|example|replace/ },
  { name: "JWT (likely real)", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, exclude: /your_|placeholder|example|replace|your-token/ },
];

  // Files/directories to skip
const IGNORE_PATTERNS = [
  /node_modules/,
  /\.git/,
  /\.tmp/,
  /\.next/,
  /dist/,
  /\.cache/,
  /pnpm-lock\.yaml/,
  /package-lock\.json/,
  /\."env"$/,
  /\.env\./,
  /\.dev\.vars$/,
  /\.dev\.vars\.example/,
  /\.env\.example/,
  /coverage/,
  /\."log"$/,
];

// Skip private key checks in utility/example files
function isPrivateKeyFalsePositive(filePath, line, patternName) {
  if (patternName !== "Private key (RSA/EC)") return false;
  // PEM template/formatter functions
  if (line.includes("return `-----BEGIN") && line.includes("PRIVATE KEY-----`")) return true;
  if (line.includes("normalizePem") || line.includes("formatPem") || line.includes("buildPem")) return true;
  // Commented-out examples
  if (line.trimStart().startsWith("#") || line.trimStart().startsWith("//") || line.trimStart().startsWith("/*")) return true;
  // Test files with fake keys
  if (/\.(test|spec|fixture)\./.test(filePath)) return true;
  return false;
}

function shouldIgnore(filePath) {
  return IGNORE_PATTERNS.some((p) => p.test(filePath));
}

function isRealSecret(value, pattern, filePath, line) {
  // Must match the pattern
  if (!pattern.pattern.test(value)) return false;
  // Must not be excluded (test fixtures, placeholders, etc.)
  if (pattern.exclude && pattern.exclude.test(value)) return false;
  // Additional false positive checks
  if (isPrivateKeyFalsePositive(filePath, line, pattern.name)) return false;
  return true;
}

// ── Modes ──────────────────────────────────────────────────────────────

function scanFiles(fileList) {
  const findings = [];
  for (const file of fileList) {
    if (shouldIgnore(file)) continue;
    const absPath = path.resolve(ROOT, file);
    if (!existsSync(absPath)) continue;

    try {
      const content = readFileSync(absPath, "utf8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of PATTERNS) {
          const matches = line.match(pattern.pattern);
          if (matches) {
            for (const match of matches) {
              if (isRealSecret(match, pattern, file, line)) {
                const display = match.length > 20
                  ? match.slice(0, 12) + "..." + match.slice(-8)
                  : match;
                findings.push({
                  file,
                  line: i + 1,
                  type: pattern.name,
                  match: display,
                });
              }
            }
          }
        }
      }
    } catch {
      // binary or unreadable file - skip
    }
  }
  return findings;
}

// ── CLI ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

async function main() {
  const mode = args.includes("--history") ? "history"
    : args.includes("--all") ? "all"
    : args.includes("--github") ? "github"
    : "staged";

  let findings = [];

  if (mode === "staged") {
    // Pre-commit: scan staged files only
    const staged = execSync("git diff --cached --name-only --diff-filter=ACMR", {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);

    if (staged.length === 0) {
      console.log("[scan-secrets] Nothing staged — skipping");
      process.exit(0);
    }

    console.log(`[scan-secrets] Scanning ${staged.length} staged files...`);
    findings = scanFiles(staged);
  } else if (mode === "all") {
    // Scan entire working tree (git-tracked files)
    const allFiles = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    console.log(`[scan-secrets] Scanning ${allFiles.length} tracked files...`);
    findings = scanFiles(allFiles);
  } else if (mode === "history") {
    // Scan git history
    console.log("[scan-secrets] Scanning git history (this may take a moment)...");
    for (const pattern of PATTERNS) {
      try {
        const output = execSync(
          `git log --all --full-history -p --pickaxe-all -S "${pattern.pattern.source.replace(/\\/g, '\\\\')}" -- ":!node_modules" ":!.tmp" ":!.env" ":!.env.*" ":!.dev.vars"`,
          { cwd: ROOT, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
        );

        const lines = output.split("\n");
        for (const line of lines) {
          if (line.startsWith("+") && !line.startsWith("+++")) {
            const content = line.slice(1);
            const matches = content.match(pattern.pattern);
            if (matches && matches.some((m) => isRealSecret(m, pattern))) {
              // Find which commit introduced this
              const commitHash = execSync(
                `git log --all --oneline --pickaxe-all -S "${matches[0]}" --format="%h"`,
                { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
              ).trim();
              findings.push({
                file: "git history",
                line: 0,
                type: `${pattern.name} (in commit ${commitHash})`,
                match: matches[0].slice(0, 12) + "...",
              });
              break;
            }
          }
        }
      } catch {
        // Pattern not found in history - that's fine
      }
    }
  } else if (mode === "github") {
    // Check GitHub secret scanning alerts
    console.log("[scan-secrets] Checking GitHub secret scanning alerts...");
    try {
      const output = execSync(
        'gh api repos/johnnietse/solana-developer-platform/secret-scanning/alerts --jq ".[] | {secret_type, secret, created_at}" 2>/dev/null',
        { cwd: ROOT, encoding: "utf8", timeout: 15000 },
      );
      if (output.trim()) {
        console.log("  GitHub secret scanning alerts found:");
        console.log(output);
      } else {
        console.log("  No active GitHub secret scanning alerts");
      }
    } catch (e) {
      if (e.message.includes("not found") || e.message.includes("404")) {
        console.log("  GitHub secret scanning not available for this repo");
      } else {
        console.log("  Could not check GitHub alerts:", e.message);
      }
    }
    process.exit(0);
  }

  // Report
  if (findings.length > 0) {
    console.log(`\n❌ FOUND ${findings.length} POTENTIAL SECRET(S):\n`);
    for (const f of findings) {
      console.log(`  [${f.type}] ${f.file}:${f.line}`);
      console.log(`    ${f.match}`);
    }
    console.log(`\n⚠️  Remove these secrets and try again.`);
    if (mode === "staged") {
      console.log(`   Use: git restore --staged <file> && echo "fixed" > <file> && git add <file>`);
    }
    process.exit(1);
  } else {
    console.log(`\n✅ No secrets found (${mode} mode)`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("[scan-secrets] Error:", err.message);
  process.exit(1);
});
