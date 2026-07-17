import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function writeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o755 });
}

function runPublishHelper({
  npmMode,
  npmVersionExists = false,
  distTag = "canary",
  callerPipefail = true,
  trustedPublishing = false,
}) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-release-lib-"));
  const binDir = join(fixtureDir, "bin");
  const stateDir = join(fixtureDir, "state");
  const callLog = join(fixtureDir, "calls.log");
  mkdirSync(binDir);
  mkdirSync(stateDir);

  writeExecutable(
    join(binDir, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "$FAKE_CALL_LOG"
if [ "$1" = "view" ] && [ "$NPM_VERSION_EXISTS" = "true" ]; then
  echo "1.2.3"
  exit 0
fi
if [ "$1" = "view" ]; then
  exit 1
fi
case "$NPM_MODE" in
  success)
    echo "published"
    exit 0
    ;;
  tlog-then-success)
    if [ ! -f "$FAKE_STATE_DIR/npm-called" ]; then
      touch "$FAKE_STATE_DIR/npm-called"
      echo "npm error code TLOG_CREATE_ENTRY_ERROR"
      echo "npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID abc"
      exit 1
    fi
    case " $* " in
      *" --provenance=false "*)
        echo "published without provenance"
        exit 0
        ;;
      *)
        echo "retry did not disable provenance"
        exit 1
        ;;
    esac
    ;;
  tlog-always-fails)
    echo "npm error code TLOG_CREATE_ENTRY_ERROR"
    echo "npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID abc"
    exit 1
    ;;
  non-tlog-failure)
    echo "npm error code E500"
    exit 1
    ;;
esac
exit 1
`,
  );

  const shellOptions = callerPipefail ? "set -euo pipefail" : "set -eu";
  const script = `
${shellOptions}
source "${repoRoot}/scripts/release-lib.sh"
publish_package_to_npm ${distTag} @paperclipai/example 1.2.3
`;

  let status = 0;
  let output = "";
  try {
    output = execFileSync("bash", ["-lc", script], {
      cwd: fixtureDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_CALL_LOG: callLog,
        FAKE_STATE_DIR: stateDir,
        NPM_VERSION_EXISTS: npmVersionExists ? "true" : "false",
        NPM_MODE: npmMode,
        REPO_ROOT: fixtureDir,
        GITHUB_ACTIONS: trustedPublishing ? "true" : "",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: trustedPublishing ? "token" : "",
        ACTIONS_ID_TOKEN_REQUEST_URL: trustedPublishing ? "https://example.invalid/oidc" : "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  return {
    calls: readFileSync(callLog, "utf8"),
    output,
    status,
  };
}

function runAuthHelper({ npmVersion }) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-release-auth-"));
  const binDir = join(fixtureDir, "bin");
  mkdirSync(binDir);

  writeExecutable(
    join(binDir, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  whoami)
    exit 1
    ;;
  --version)
    echo "$FAKE_NPM_VERSION"
    exit 0
    ;;
esac
exit 1
`,
  );

  const script = `
set -euo pipefail
source "${repoRoot}/scripts/release-lib.sh"
require_npm_publish_auth false
`;

  let status = 0;
  let output = "";
  try {
    output = execFileSync("bash", ["-lc", script], {
      cwd: fixtureDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_NPM_VERSION: npmVersion,
        GITHUB_ACTIONS: "true",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "token",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  return { output, status };
}

test("publish_package_to_npm returns after a successful npm publish", () => {
  const result = runPublishHelper({ npmMode: "success" });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^npm publish --tag canary --access public$/m);
  assert.doesNotMatch(result.calls, /npm view/);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm uses npm provenance when GitHub Actions OIDC is available", () => {
  const result = runPublishHelper({ npmMode: "success", trustedPublishing: true });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^npm publish --tag canary --access public --provenance$/m);
});

test("publish_package_to_npm retries duplicate tlog failures without provenance", () => {
  const result = runPublishHelper({ npmMode: "tlog-then-success" });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.match(
    result.calls,
    /^npm publish --tag canary --access public --provenance=false$/m,
  );
});

test("publish_package_to_npm treats a duplicate tlog failure as complete when npm exposes the version", () => {
  const result = runPublishHelper({ npmMode: "tlog-always-fails", npmVersionExists: true });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm does not retry unrelated publish failures", () => {
  const result = runPublishHelper({ npmMode: "non-tlog-failure" });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.calls, /npm view/);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm does not mask failures when caller has no pipefail", () => {
  const result = runPublishHelper({ npmMode: "non-tlog-failure", callerPipefail: false });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.calls, /npm view/);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm does not retry stable publishes without provenance", () => {
  const result = runPublishHelper({ npmMode: "tlog-then-success", distTag: "latest" });

  assert.notEqual(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("require_npm_publish_auth rejects trusted publishing with old npm", () => {
  const result = runAuthHelper({ npmVersion: "11.5.0" });

  assert.notEqual(result.status, 0);
  assert.match(result.output, /requires npm 11\.5\.1 or newer; found 11\.5\.0/);
});

test("require_npm_publish_auth accepts trusted publishing with supported npm", () => {
  const result = runAuthHelper({ npmVersion: "11.5.1" });

  assert.equal(result.status, 0);
  assert.match(result.output, /trusted publishing/);
});
