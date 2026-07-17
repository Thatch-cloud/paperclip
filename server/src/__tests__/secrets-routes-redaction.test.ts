import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const tempRoots: string[] = [];

afterEach(() => {
  vi.resetModules();
  delete process.env.PAPERCLIP_LOG_DIR;
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("secret route error logging", () => {
  it("does not include submitted secret values in POST /secrets validation logs or response bodies", async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-secret-logs-"));
    tempRoots.push(logDir);
    process.env.PAPERCLIP_LOG_DIR = logDir;
    vi.resetModules();

    const [{ httpLogger, logger }, { errorHandler }, { secretRoutes }] = await Promise.all([
      import("../middleware/logger.js"),
      import("../middleware/error-handler.js"),
      import("../routes/secrets.js"),
    ]);

    const app = express();
    app.use(express.json());
    app.use(httpLogger);
    app.use((req, _res, next) => {
      req.actor = { kind: "user", source: "local", userId: "board-user", companyIds: ["company-1"] };
      next();
    });
    app.use("/api", secretRoutes({} as Db));
    app.use(errorHandler);

    const canarySecret = "pc-secret-canary-THA-1875-9f1d0a8e8e3b";
    const response = await request(app)
      .post("/api/companies/company-1/secrets")
      .send({ name: "deploy token", value: canarySecret, managedMode: "not-a-managed-mode" });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(canarySecret);

    await new Promise<void>((resolve) => logger.flush(resolve));

    const logText = fs.readFileSync(path.join(logDir, "server.log"), "utf8");
    expect(logText).toContain("POST /api/companies/company-1/secrets 400");
    expect(logText).toContain("[REDACTED]");
    expect(logText).not.toContain(canarySecret);
  });
});
