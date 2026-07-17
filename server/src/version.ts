import { createRequire } from "node:module";

type PackageJson = {
  version?: string;
};

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as PackageJson;

export const serverVersion = pkg.version ?? "0.0.0";

export const controlPlaneRef = process.env.PAPERCLIP_CONTROL_PLANE_REF?.trim() || null;
export const controlPlaneReleaseDir =
  process.env.PAPERCLIP_CONTROL_PLANE_RELEASE_DIR?.trim() || null;

export const deploymentVersion = {
  version: serverVersion,
  ...(controlPlaneRef ? { controlPlaneRef } : {}),
  ...(controlPlaneReleaseDir ? { controlPlaneReleaseDir } : {}),
};
