import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff, Key, Plus } from "lucide-react";
import { agentsApi, type AgentKey } from "../api/agents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { queryKeys } from "../lib/queryKeys";
import { formatDate } from "../lib/utils";

export function KeysTab({ agentId, companyId }: { agentId: string; companyId?: string }) {
  const queryClient = useQueryClient();
  const [newKeyName, setNewKeyName] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revokeNotice, setRevokeNotice] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [showRevokedKeys, setShowRevokedKeys] = useState(false);
  const keysQueryKey = queryKeys.agents.keys(agentId);

  const { data: keys, isLoading } = useQuery({
    queryKey: keysQueryKey,
    queryFn: () => agentsApi.listKeys(agentId, companyId),
  });

  const createKey = useMutation({
    mutationFn: () => agentsApi.createKey(agentId, newKeyName.trim() || "Default", companyId),
    onSuccess: (data) => {
      setNewToken(data.token);
      setTokenVisible(true);
      setNewKeyName("");
      queryClient.invalidateQueries({ queryKey: keysQueryKey });
    },
  });

  const revokeKey = useMutation({
    mutationFn: (key: AgentKey) => agentsApi.revokeKey(agentId, key.id, companyId),
    onSuccess: (_data, key) => {
      setRevokeError(null);
      setRevokeNotice(`Revoked API key "${key.name}".`);
      queryClient.setQueryData<AgentKey[]>(keysQueryKey, (current) =>
        current?.map((candidate) =>
          candidate.id === key.id ? { ...candidate, revokedAt: new Date() } : candidate,
        ),
      );
      queryClient.invalidateQueries({ queryKey: keysQueryKey });
    },
    onError: (error) => {
      setRevokeNotice(null);
      setRevokeError(error instanceof Error ? error.message : String(error));
    },
  });

  function requestRevoke(key: AgentKey) {
    if (
      !window.confirm(
        `Revoke API key "${key.name}"? This key will stop authenticating immediately and cannot be restored.`,
      )
    ) {
      return;
    }
    setRevokeNotice(null);
    setRevokeError(null);
    revokeKey.mutate(key);
  }

  function copyToken() {
    if (!newToken) return;
    navigator.clipboard.writeText(newToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const activeKeys = (keys ?? []).filter((key: AgentKey) => !key.revokedAt);
  const revokedKeys = (keys ?? []).filter((key: AgentKey) => key.revokedAt);

  return (
    <div className="space-y-6">
      {newToken && (
        <div className="border border-yellow-300 dark:border-yellow-600/40 bg-yellow-50 dark:bg-yellow-500/5 rounded-lg p-4 space-y-2">
          <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
            API key created - copy it now, it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-neutral-100 dark:bg-neutral-950 rounded px-3 py-1.5 text-xs font-mono text-green-700 dark:text-green-300 truncate">
              {tokenVisible ? newToken : newToken.replace(/./g, "*")}
            </code>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setTokenVisible((value) => !value)}
              title={tokenVisible ? "Hide" : "Show"}
            >
              {tokenVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={copyToken} title="Copy">
              <Copy className="h-3.5 w-3.5" />
            </Button>
            {copied && <span className="text-xs text-green-400">Copied!</span>}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground text-xs"
            onClick={() => setNewToken(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      <div className="border border-border rounded-lg p-4 space-y-3">
        <h3 className="text-xs font-medium text-muted-foreground flex items-center gap-2">
          <Key className="h-3.5 w-3.5" />
          Create API Key
        </h3>
        <p className="text-xs text-muted-foreground">
          API keys allow this agent to authenticate calls to the Paperclip server. New keys are scoped to read/write
          access and expire after one year.
        </p>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Key name (e.g. production)"
            value={newKeyName}
            onChange={(event) => setNewKeyName(event.target.value)}
            className="h-8 text-sm"
            onKeyDown={(event) => {
              if (event.key === "Enter") createKey.mutate();
            }}
          />
          <Button size="sm" onClick={() => createKey.mutate()} disabled={createKey.isPending}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Create
          </Button>
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading keys...</p>}

      {revokeNotice && (
        <p role="status" className="text-sm text-green-600 dark:text-green-400">
          {revokeNotice}
        </p>
      )}

      {revokeError && (
        <p role="alert" className="text-sm text-destructive">
          Could not revoke API key: {revokeError}
        </p>
      )}

      {!isLoading && activeKeys.length === 0 && !newToken && (
        <p className="text-sm text-muted-foreground">No active API keys.</p>
      )}

      {activeKeys.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2">Active Keys</h3>
          <div className="border border-border rounded-lg divide-y divide-border">
            {activeKeys.map((key: AgentKey) => (
              <div key={key.id} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <span className="text-sm font-medium">{key.name}</span>
                  <span className="text-xs text-muted-foreground ml-3">Created {formatDate(key.createdAt)}</span>
                  <span className="text-xs text-muted-foreground ml-3">
                    Scope {key.scopes?.join("+") ?? "legacy full access"}
                  </span>
                  <span className="text-xs text-muted-foreground ml-3">
                    Expires {key.expiresAt ? formatDate(key.expiresAt) : "never (legacy)"}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive text-xs"
                  onClick={() => requestRevoke(key)}
                  disabled={revokeKey.isPending}
                >
                  {revokeKey.isPending && revokeKey.variables?.id === key.id ? "Revoking..." : "Revoke"}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {revokedKeys.length > 0 && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => setShowRevokedKeys((value) => !value)}
          >
            {showRevokedKeys ? "Hide" : "Show"} revoked keys ({revokedKeys.length})
          </Button>
          {showRevokedKeys && (
            <div className="mt-2 border border-border rounded-lg divide-y divide-border opacity-50">
              {revokedKeys.map((key: AgentKey) => (
                <div key={key.id} className="flex items-center justify-between px-4 py-2.5">
                  <div>
                    <span className="text-sm line-through">{key.name}</span>
                    <span className="text-xs text-muted-foreground ml-3">
                      Revoked {key.revokedAt ? formatDate(key.revokedAt) : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
