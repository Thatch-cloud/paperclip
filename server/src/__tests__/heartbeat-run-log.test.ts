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
});
