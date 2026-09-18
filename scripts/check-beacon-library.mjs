#!/usr/bin/env node
// Verify the vendored beacon-library tarball and the pins around it. Runs in
// CI and in the deploy workflow's test job. No network request: every input is
// on disk.
//
// The check fails when the tarball's SHA-256 does not match the pinned hash
// beside it, when package.json does not depend on exactly that file, or when
// BEACON_LIBRARY_SHA is not a 40 character commit id.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const tarballPath = resolve(repoRoot, "vendor/beacon-library-1.0.0.tgz");
const shaFile = resolve(repoRoot, "vendor/beacon-library-1.0.0.tgz.sha256");
const pkgPath = resolve(repoRoot, "package.json");
const libSha = resolve(repoRoot, "BEACON_LIBRARY_SHA");

function die(msg) {
  process.stderr.write(`check-beacon-library: ${msg}\n`);
  process.exit(1);
}

function readSha256(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    die(`missing ${path}`);
  }
  const first = raw.trim().split(/\s+/, 1)[0] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(first)) die(`malformed sha256 in ${path}`);
  return first.toLowerCase();
}

function computeSha256(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    die(`missing ${path}`);
  }
  return createHash("sha256").update(buf).digest("hex");
}

function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    die(`missing ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    die(`invalid JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readCommit(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    die(`missing ${path}`);
  }
  const sha = raw.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) die(`BEACON_LIBRARY_SHA is not a 40 character commit id`);
  return sha;
}

const expected = readSha256(shaFile);
const actual = computeSha256(tarballPath);
if (expected !== actual) {
  die(`beacon-library-1.0.0.tgz sha256 mismatch: expected ${expected}, got ${actual}`);
}

const pkg = readJson(pkgPath);
const dep = pkg && pkg.dependencies ? pkg.dependencies["beacon-library"] : undefined;
if (dep !== "file:vendor/beacon-library-1.0.0.tgz") {
  die(`package.json dependency for beacon-library must be "file:vendor/beacon-library-1.0.0.tgz" (got ${JSON.stringify(dep)})`);
}

readCommit(libSha);

process.stdout.write("check-beacon-library: ok\n");
