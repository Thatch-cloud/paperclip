import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const deployScript = join(repoRoot, "scripts", "deploy-control-plane.sh");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

test("deploy-control-plane can roll back to a reused linked worktree release", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "paperclip-deploy-test-"));
  try {
    const sourceRepo = join(tempRoot, "source");
    const deployRoot = join(tempRoot, "deploy");
    run("git", ["init", sourceRepo]);
    run("git", [
      "-C",
      sourceRepo,
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    run("git", ["-C", sourceRepo, "config", "user.name", "Deploy Test"]);

    writeFileSync(join(sourceRepo, "marker.txt"), "a\n");
    run("git", ["-C", sourceRepo, "add", "marker.txt"]);
    run("git", ["-C", sourceRepo, "commit", "-m", "a"]);
    const firstSha = run("git", ["-C", sourceRepo, "rev-parse", "HEAD"]).trim();

    writeFileSync(join(sourceRepo, "marker.txt"), "b\n");
    run("git", ["-C", sourceRepo, "commit", "-am", "b"]);
    const secondSha = run("git", [
      "-C",
      sourceRepo,
      "rev-parse",
      "HEAD",
    ]).trim();

    const env = {
      ...process.env,
      PAPERCLIP_CONTROL_PLANE_SOURCE_REPO: sourceRepo,
      PAPERCLIP_CONTROL_PLANE_ROOT: deployRoot,
      PAPERCLIP_CONTROL_PLANE_SKIP_INSTALL: "1",
    };

    run(deployScript, [firstSha], { env });
    run(deployScript, [secondSha], { env });
    run(deployScript, [firstSha], { env });

    const deployedEnv = run("env", [
      "-i",
      "bash",
      "-c",
      `source '${join(deployRoot, "deploy.env")}' && printf '%s' "$PAPERCLIP_CONTROL_PLANE_REF"`,
    ]);
    assert.equal(deployedEnv, firstSha);
    assert.equal(
      run("git", [
        "-C",
        join(deployRoot, "current"),
        "rev-parse",
        "HEAD",
      ]).trim(),
      firstSha,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
