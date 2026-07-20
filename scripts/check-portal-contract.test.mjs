import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("contract checker fails when generated Portal OpenAPI output is stale", () => {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@paperclipai/server",
      "exec",
      "tsx",
      "../scripts/check-portal-contract.ts",
      "--fixture",
      "scripts/fixtures/stale-portal-openapi-client.d.ts",
    ],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Portal OpenAPI contract client is stale/);
});
