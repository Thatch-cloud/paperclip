import { describe, expect, it } from "vitest";
import { compactRunLogChunk } from "../services/heartbeat.js";

describe("compactRunLogChunk", () => {
  it("redacts inline base64 image data from structured log chunks", () => {
    const base64 = "A".repeat(4096);
    const chunk = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"${base64}"}}]}}\n`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(base64);
    expect(compacted).toContain("[omitted base64 image data: 4096 chars]");
  });

  it("truncates oversized chunks after sanitizing them", () => {
    const chunk = `${"x".repeat(90_000)}tail`;

    const compacted = compactRunLogChunk(chunk, 16_384);

    expect(compacted.length).toBeLessThan(chunk.length);
    expect(compacted).toContain("[paperclip truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts Paperclip credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });

  it("redacts secret-bearing env output before persisting run-log chunks", () => {
    const chunk = [
      "THATCH_PRIMARY_STORE=postgres://user:password@host/db",
      "THATCH_ADMIN_SEED_PASSWORD=fake-admin-seed-password",
      "THATCH_PUBLIC_ENDPOINT=https://host/healthz",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("THATCH_PRIMARY_STORE=postgres://***REDACTED***@host/db");
    expect(compacted).toContain("THATCH_ADMIN_SEED_PASSWORD=***REDACTED***");
    expect(compacted).toContain("THATCH_PUBLIC_ENDPOINT=https://host/healthz");
    expect(compacted).not.toContain("user:password");
    expect(compacted).not.toContain("fake-admin-seed-password");
  });

  it("collapses broad env-style dumps before persisting run-log chunks", () => {
    const chunk = [
      "HOME=/home/tester",
      "PATH=/usr/local/bin:/usr/bin",
      "SHELL=/bin/bash",
      "LANG=C.UTF-8",
      "TERM=xterm-256color",
      "PWD=/workspace/project",
      "USER=tester",
      "LOGNAME=tester",
      "TMPDIR=/tmp",
      "EDITOR=vim",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toBe("[paperclip redacted environment dump: 10 env-style lines]");
    expect(compacted).not.toContain("/home/tester");
    expect(compacted).not.toContain("/workspace/project");
  });

  it("redacts Paperclip runtime env dumps even below the broad env threshold", () => {
    const chunk = [
      "PAPERCLIP_AGENT_ID=agent-id-value",
      "export PAPERCLIP_RUN_ID=run-id-value",
      "PAPERCLIP_API_KEY=run-token-value",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toBe("[paperclip redacted environment dump: 3 env-style lines]");
    expect(compacted).not.toContain("agent-id-value");
    expect(compacted).not.toContain("run-id-value");
    expect(compacted).not.toContain("run-token-value");
  });

  it("redacts a narrow Paperclip env diagnostic without dropping nearby output", () => {
    const chunk = ["before", "PAPERCLIP_TASK_ID=task-id-value", "after"].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("before");
    expect(compacted).toContain("PAPERCLIP_TASK_ID=***REDACTED***");
    expect(compacted).toContain("after");
    expect(compacted).not.toContain("task-id-value");
  });
});
