import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();

describe("scripts/start-control-plane.sh", () => {
  it("does not change working directory before invoking node", () => {
    const releaseDir = mkdtempSync(join(tmpdir(), "cp-release-"));
    const invocationDir = mkdtempSync(join(tmpdir(), "cp-invoke-"));

    // Create a minimal git checkout in the release dir.
    execFileSync("git", ["init"], { cwd: releaseDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: releaseDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: releaseDir });
    writeFileSync(join(releaseDir, "marker.txt"), "ok");
    execFileSync("git", ["add", "."], { cwd: releaseDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: releaseDir });

    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: releaseDir })
      .toString()
      .trim();

    // Create the release marker expected by the script.
    writeFileSync(join(releaseDir, ".paperclip-control-plane-ref"), `${head}\n`);

    // Create a fake node binary that prints the current working directory.
    const fakeNodeDir = mkdtempSync(join(tmpdir(), "cp-node-"));
    const fakeNode = join(fakeNodeDir, "node");
    writeFileSync(fakeNode, "#!/usr/bin/env bash\npwd\n");
    execFileSync("chmod", ["+x", fakeNode]);

    // Invoke the script from a directory other than the release dir.
    const output = execFileSync(
      join(repoRoot, "scripts/start-control-plane.sh"),
      [],
      {
        cwd: invocationDir,
        env: {
          ...process.env,
          PAPERCLIP_CONTROL_PLANE_REF: head,
          PAPERCLIP_CONTROL_PLANE_RELEASE_DIR: releaseDir,
          PAPERCLIP_NODE_BIN: fakeNode,
        },
      }
    )
      .toString()
      .trim();

    // After removing the script-side cd, the fake node must run from the
    // invocation directory, not the release directory.
    expect(output).toBe(invocationDir);
  });
});
