import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ADMIN_USER = "paperclip";
const LEGACY_ADMIN_PASSWORD = "paperclip";
const RUNTIME_USER = "paperclip_runtime";

export type EmbeddedPostgresCredentials = {
  adminUser: string;
  adminPassword: string;
  bootstrapAdminPassword: string;
  runtimeUser: string;
  runtimePassword: string;
  credentialsPath: string;
};

type CredentialsFile = {
  version?: number;
  adminUser?: string;
  adminPassword?: string;
  runtimeUser?: string;
  runtimePassword?: string;
};

function credentialsPathForDataDir(dataDir: string): string {
  return `${path.resolve(dataDir)}.credentials.json`;
}

function generatedPassword(): string {
  return randomBytes(32).toString("base64url");
}

function readCredentialsFile(credentialsPath: string): CredentialsFile | null {
  if (!existsSync(credentialsPath)) return null;
  const parsed = JSON.parse(
    readFileSync(credentialsPath, "utf8"),
  ) as CredentialsFile;
  if (
    parsed.version !== 1 ||
    parsed.adminUser !== ADMIN_USER ||
    typeof parsed.adminPassword !== "string" ||
    parsed.runtimeUser !== RUNTIME_USER ||
    typeof parsed.runtimePassword !== "string"
  ) {
    throw new Error(
      `Invalid embedded PostgreSQL credentials file: ${credentialsPath}`,
    );
  }
  return parsed;
}

function writeCredentialsFile(
  credentialsPath: string,
  credentials: CredentialsFile,
): void {
  mkdirSync(path.dirname(credentialsPath), { recursive: true });
  writeFileSync(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function resolveEmbeddedPostgresCredentials(
  dataDir: string,
): EmbeddedPostgresCredentials {
  const credentialsPath = credentialsPathForDataDir(dataDir);
  const existing = readCredentialsFile(credentialsPath);
  if (existing) {
    return {
      adminUser: ADMIN_USER,
      adminPassword: existing.adminPassword!,
      bootstrapAdminPassword: existing.adminPassword!,
      runtimeUser: RUNTIME_USER,
      runtimePassword: existing.runtimePassword!,
      credentialsPath,
    };
  }

  const clusterAlreadyInitialized = existsSync(
    path.resolve(dataDir, "PG_VERSION"),
  );
  const adminPassword = generatedPassword();
  const runtimePassword = generatedPassword();
  writeCredentialsFile(credentialsPath, {
    version: 1,
    adminUser: ADMIN_USER,
    adminPassword,
    runtimeUser: RUNTIME_USER,
    runtimePassword,
  });

  return {
    adminUser: ADMIN_USER,
    adminPassword,
    bootstrapAdminPassword: clusterAlreadyInitialized
      ? LEGACY_ADMIN_PASSWORD
      : adminPassword,
    runtimeUser: RUNTIME_USER,
    runtimePassword,
    credentialsPath,
  };
}

export function postgresConnectionString(input: {
  user: string;
  password: string;
  port: number;
  database: string;
}): string {
  const user = encodeURIComponent(input.user);
  const password = encodeURIComponent(input.password);
  const database = encodeURIComponent(input.database);
  return `postgres://${user}:${password}@127.0.0.1:${input.port}/${database}`;
}
