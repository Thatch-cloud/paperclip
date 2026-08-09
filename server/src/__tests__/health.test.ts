import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { deploymentVersion, serverVersion } from "../version.js";

const mockReadPersistedDevServerStatus = vi.hoisted(() => vi.fn());

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: mockReadPersistedDevServerStatus,
  toDevServerHealthStatus: vi.fn(),
}));

function createApp(db?: Db) {
  const app = express();
  app.use("/health", healthRoutes(db));
  return app;
}

describe("GET /health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadPersistedDevServerStatus.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      version: serverVersion,
      deployment: deploymentVersion,
    });
  }, 15_000);

  it("exposes the deployed control-plane ref in full health details", async () => {
    const originalRef = process.env.PAPERCLIP_CONTROL_PLANE_REF;
    const originalReleaseDir = process.env.PAPERCLIP_CONTROL_PLANE_RELEASE_DIR;
    process.env.PAPERCLIP_CONTROL_PLANE_REF = "abc123";
    process.env.PAPERCLIP_CONTROL_PLANE_RELEASE_DIR = "/tmp/paperclip-release";
    vi.resetModules();
    try {
      const versionModule = await import("../version.js");
      const routesModule = await import("../routes/health.js");
      const app = express();
      app.use("/health", routesModule.healthRoutes());

      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: "ok",
        version: versionModule.serverVersion,
        deployment: {
          version: versionModule.serverVersion,
          controlPlaneRef: "abc123",
          controlPlaneReleaseDir: "/tmp/paperclip-release",
        },
      });
    } finally {
      if (originalRef === undefined) {
        delete process.env.PAPERCLIP_CONTROL_PLANE_REF;
      } else {
        process.env.PAPERCLIP_CONTROL_PLANE_REF = originalRef;
      }
      if (originalReleaseDir === undefined) {
        delete process.env.PAPERCLIP_CONTROL_PLANE_RELEASE_DIR;
      } else {
        process.env.PAPERCLIP_CONTROL_PLANE_RELEASE_DIR = originalReleaseDir;
      }
      vi.resetModules();
    }
  });

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      deployment: deploymentVersion,
      error: "database_unreachable",
    });
  });

  it("redacts deployment metadata for anonymous authenticated requests when the database probe fails", async () => {
    const originalRef = process.env.PAPERCLIP_CONTROL_PLANE_REF;
    const originalReleaseDir = process.env.PAPERCLIP_CONTROL_PLANE_RELEASE_DIR;
    process.env.PAPERCLIP_CONTROL_PLANE_REF = "deadbeefcafe1234";
    process.env.PAPERCLIP_CONTROL_PLANE_RELEASE_DIR =
      "/home/thatch/.paperclip/control-plane/current";
    vi.resetModules();
    try {
      const routesModule = await import("../routes/health.js");
      const db = {
        execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
      } as unknown as Db;
      const app = express();
      app.use((req, _res, next) => {
        (req as any).actor = { type: "none", source: "none" };
        next();
      });
      app.use(
        "/health",
        routesModule.healthRoutes(db, {
          deploymentMode: "authenticated",
          deploymentExposure: "public",
          authReady: true,
          companyDeletionEnabled: false,
        }),
      );

      const res = await request(app).get("/health");

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        status: "unhealthy",
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        error: "database_unreachable",
      });
      expect(res.body).not.toHaveProperty("version");
      expect(res.body).not.toHaveProperty("deployment");
    } finally {
      if (originalRef === undefined) {
        delete process.env.PAPERCLIP_CONTROL_PLANE_REF;
      } else {
        process.env.PAPERCLIP_CONTROL_PLANE_REF = originalRef;
      }
      if (originalReleaseDir === undefined) {
        delete process.env.PAPERCLIP_CONTROL_PLANE_RELEASE_DIR;
      } else {
        process.env.PAPERCLIP_CONTROL_PLANE_RELEASE_DIR = originalReleaseDir;
      }
      vi.resetModules();
    }
  });

  it("redacts detailed metadata for anonymous requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(
      undefined,
    );
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
  });

  it("redacts detailed metadata when authenticated mode is reached without auth middleware", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(
      undefined,
    );
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
  });

  it("keeps detailed metadata for authenticated requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(
      undefined,
    );
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "user-1",
        source: "session",
      };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      deployment: deploymentVersion,
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authReady: true,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
      features: {
        companyDeletionEnabled: false,
      },
    });
  });
});

describe("POST /health/write-canary", () => {
  it("exposes the issue-create write canary", async () => {
    const issueCreateWriteCanary = vi.fn().mockResolvedValue({
      id: "issue-1",
      identifier: "THA-9999",
    });
    const app = express();
    app.use(
      "/health",
      healthRoutes(undefined, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        authReady: true,
        companyDeletionEnabled: true,
        issueCreateWriteCanary,
      }),
    );

    const res = await request(app).post(
      "/health/write-canary?companyId=company-1",
    );

    expect(res.status).toBe(200);
    expect(issueCreateWriteCanary).toHaveBeenCalledWith("company-1");
    expect(res.body).toEqual({
      status: "ok",
      canary: "issue_create",
      issueId: "issue-1",
      identifier: "THA-9999",
    });
  });

  it("returns 503 when the issue-create write canary fails", async () => {
    const issueCreateWriteCanary = vi
      .fn()
      .mockRejectedValue(
        new Error("duplicate key value violates unique constraint"),
      );
    const app = express();
    app.use(
      "/health",
      healthRoutes(undefined, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        authReady: true,
        companyDeletionEnabled: true,
        issueCreateWriteCanary,
      }),
    );

    const res = await request(app).post(
      "/health/write-canary?companyId=company-1",
    );

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      error: "issue_create_write_canary_failed",
    });
  });
});
