// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeysTab } from "./AgentDetailKeysTab";
import type { AgentKey } from "../api/agents";

const listKeysMock = vi.hoisted(() => vi.fn());
const createKeyMock = vi.hoisted(() => vi.fn());
const revokeKeyMock = vi.hoisted(() => vi.fn());

vi.mock("../api/agents", () => ({
  agentsApi: {
    listKeys: (agentId: string, companyId?: string) => listKeysMock(agentId, companyId),
    createKey: (agentId: string, name: string, companyId?: string) =>
      createKeyMock(agentId, name, companyId),
    revokeKey: (agentId: string, keyId: string, companyId?: string) =>
      revokeKeyMock(agentId, keyId, companyId),
  },
}));

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitForText(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await flushReact();
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

describe("KeysTab", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let keys: AgentKey[];

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    keys = [
      {
        id: "key-active",
        name: "production",
        scopes: ["read", "write"],
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        revokedAt: null,
      },
      {
        id: "key-revoked",
        name: "old key",
        scopes: ["read"],
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        revokedAt: new Date("2026-01-15T00:00:00.000Z"),
      },
    ];

    listKeysMock.mockImplementation(() => Promise.resolve(keys));
    createKeyMock.mockResolvedValue({ token: "paperclip_test_token" });
    revokeKeyMock.mockImplementation((_agentId: string, keyId: string) => {
      keys = keys.map((key) =>
        key.id === keyId ? { ...key, revokedAt: new Date("2026-02-01T00:00:00.000Z") } : key,
      );
      return Promise.resolve({ ok: true });
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <KeysTab agentId="agent-1" companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await waitForText(container, "Active Keys");
  });

  afterEach(async () => {
    flushSync(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("confirms key revocation, removes it from the active list, and hides revoked history by default", async () => {
    expect(container.textContent).toContain("Active Keys");
    expect(container.textContent).toContain("production");
    expect(container.textContent).toContain("Show revoked keys (1)");
    expect(container.textContent).not.toContain("old key");

    const revokeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Revoke",
    );

    flushSync(() => {
      revokeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(window.confirm).toHaveBeenCalledWith(
      'Revoke API key "production"? This key will stop authenticating immediately and cannot be restored.',
    );
    expect(revokeKeyMock).toHaveBeenCalledWith("agent-1", "key-active", "company-1");
    expect(container.textContent).toContain('Revoked API key "production".');
    expect(container.textContent).toContain("No active API keys.");
    expect(container.textContent).toContain("Show revoked keys (2)");
    expect(container.textContent).not.toContain("old key");
  });
});
