// Stage an npm-publishable directory at <repo>/npm-package.
//
// Assumes `next build` and `pnpm build:ingest` have already produced
// `.next/standalone`, `.next/static`, and `ingest/dist`.
//
// The staged package omits node_modules: dependencies are listed in the
// generated package.json so that npm install on the user's machine fetches
// platform/Node-ABI matching binaries (notably better-sqlite3 prebuilds).
//
// Usage:
//   node scripts/prepare-npm-package.mjs             # uses version from package.json
//   node scripts/prepare-npm-package.mjs 1.2.3       # override version

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, cpSync, copyFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, basename } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const stageDir = resolve(repoRoot, "npm-package");

const PACKAGE_NAME = "@camtrik/agent-trail";

function log(msg) {
  console.log(`[prepare-npm] ${msg}`);
}

function die(msg) {
  console.error(`[prepare-npm] ${msg}`);
  process.exit(1);
}

function requireFile(path, hint) {
  if (!existsSync(path)) {
    die(`missing ${path} — ${hint}`);
  }
}

function requireDir(path, hint) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    die(`missing directory ${path} — ${hint}`);
  }
}

const sourcePkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const versionOverride = process.argv[2];
const version = versionOverride || sourcePkg.version;

if (typeof sourcePkg.license !== "string" || !sourcePkg.license.trim()) {
  die("source package.json must explicitly declare a license before packaging");
}
requireFile(join(repoRoot, "LICENSE"), "repository license text is required for packaging");

if (!/^\d+\.\d+\.\d+(?:-[\w.+-]+)?$/.test(version)) {
  die(`invalid version "${version}" — expected semver`);
}

requireDir(join(repoRoot, ".next", "standalone"), "run `pnpm build` first");
requireDir(join(repoRoot, ".next", "static"), "run `pnpm build` first");
requireFile(join(repoRoot, "ingest", "dist", "index.js"), "run `pnpm build:ingest` first");
requireFile(join(repoRoot, "ingest", "dist", "schema.sql"), "run `pnpm build:ingest` first");
requireFile(join(repoRoot, "bin", "agent-trail.js"), "bin entry missing — check repo state");

if (existsSync(stageDir)) {
  log(`clearing existing ${stageDir}`);
  rmSync(stageDir, { recursive: true, force: true });
}
mkdirSync(stageDir, { recursive: true });

// .next/standalone (skip node_modules — npm will install them at runtime)
log("copying .next/standalone (without node_modules)");
mkdirSync(join(stageDir, ".next"), { recursive: true });
cpSync(join(repoRoot, ".next", "standalone"), join(stageDir, ".next", "standalone"), {
  recursive: true,
  filter: (src) => basename(src) !== "node_modules",
});

// Drop the standalone package.json — it duplicates the source pkg with devDeps
// and confuses npm consumers. Our generated package.json sits at the root.
const standalonePkg = join(stageDir, ".next", "standalone", "package.json");
if (existsSync(standalonePkg)) {
  rmSync(standalonePkg);
}

// .next/static must live INSIDE the standalone dir so server.js (which runs
// with cwd=standalone) can serve /_next/static/* from <cwd>/.next/static.
log("copying .next/static → standalone/.next/static");
cpSync(
  join(repoRoot, ".next", "static"),
  join(stageDir, ".next", "standalone", ".next", "static"),
  { recursive: true },
);

// public/ likewise must be at standalone/public so Next.js can serve it.
if (existsSync(join(repoRoot, "public"))) {
  log("copying public/ → standalone/public/");
  cpSync(
    join(repoRoot, "public"),
    join(stageDir, ".next", "standalone", "public"),
    { recursive: true },
  );
}

// ingest/dist (only the two files the runtime needs)
log("copying ingest/dist");
mkdirSync(join(stageDir, "ingest", "dist"), { recursive: true });
copyFileSync(
  join(repoRoot, "ingest", "dist", "index.js"),
  join(stageDir, "ingest", "dist", "index.js"),
);
copyFileSync(
  join(repoRoot, "ingest", "dist", "schema.sql"),
  join(stageDir, "ingest", "dist", "schema.sql"),
);

// bin entry
log("copying bin/agent-trail.js");
mkdirSync(join(stageDir, "bin"), { recursive: true });
copyFileSync(
  join(repoRoot, "bin", "agent-trail.js"),
  join(stageDir, "bin", "agent-trail.js"),
);

// README + LICENSE
for (const name of ["README.md", "LICENSE", "LICENSE.md", "LICENSE.txt"]) {
  const src = join(repoRoot, name);
  if (existsSync(src)) {
    log(`copying ${name}`);
    copyFileSync(src, join(stageDir, name));
  }
}

// Generated package.json — runtime deps only, no devDeps, public scope.
const publishedPkg = {
  name: PACKAGE_NAME,
  version,
  description:
    "Local AI coding agent observability dashboard for Claude Code, Codex, OpenCode, OpenClaw, and Qoder. Track token usage, estimated cost, tool calls, subagent trees, and replay full sessions from local JSONL/SQLite files — no cloud, no telemetry.",
  keywords: [
    "ai-agents",
    "coding-agents",
    "claude-code",
    "codex",
    "opencode",
    "openclaw",
    "qoder",
    "llm",
    "llmops",
    "dashboard",
    "observability",
    "agent-observability",
    "token-usage",
    "cost-tracking",
    "session-replay",
    "developer-tools",
    "tracing",
  ],
  homepage: "https://github.com/camtrik/agent-trail#readme",
  bugs: {
    url: "https://github.com/camtrik/agent-trail/issues",
  },
  repository: {
    type: "git",
    url: "git+https://github.com/camtrik/agent-trail.git",
  },
  license: sourcePkg.license,
  author: sourcePkg.author || "camtrik",
  bin: {
    "agent-trail": "./bin/agent-trail.js",
    "agents-tracing": "./bin/agent-trail.js",
  },
  engines: {
    node: ">=22.0.0",
  },
  // No `files` field needed: we publish from this staged dir directly, and
  // every path on disk here is intentional. Default npm rules will exclude
  // dotfiles like .DS_Store; .next/ is included because it's not in npm's
  // default ignore list (only `node_modules` is).
  dependencies: sourcePkg.dependencies,
  publishConfig: {
    access: "public",
  },
};

writeFileSync(
  join(stageDir, "package.json"),
  JSON.stringify(publishedPkg, null, 2) + "\n",
);
log(`wrote package.json (name=${PACKAGE_NAME}, version=${version})`);

log(`staged at ${stageDir}`);
log("next: cd npm-package && npm publish");
