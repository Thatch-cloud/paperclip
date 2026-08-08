import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  readAdapterExecutionTargetHomeDir,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  runChildProcess,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import {
  hasOpenCodeCompletedTurn,
  isOpenCodeProviderExhaustionError,
  isOpenCodeUnknownSessionError,
  parseOpenCodeJsonl,
} from "./parse.js";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  isTruthyEnvFlag,
  parseOpenCodeModelsOutput,
  requireOpenCodeModelId,
} from "./models.js";
import { removeMaintainerOnlySkillSymlinks } from "@paperclipai/adapter-utils/server-utils";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";
import { SANDBOX_INSTALL_COMMAND, isValidOpenCodeModelId } from "../index.js";
import {
  createOpenCodeOutputInactivityMonitor,
  formatOutputInactivityMonitorErrorMessage,
  resolveOpenCodeInactivityTimeout,
  OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
} from "./output-inactivity-monitor.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function signalOpenCodeChild(
  target: { pid: number | null; processGroupId: number | null },
  signal: NodeJS.Signals,
): boolean {
  if (process.platform !== "win32" && target.processGroupId && target.processGroupId > 0) {
    try {
      process.kill(-target.processGroupId, signal);
      return true;
    } catch {
      // Fall back to direct child signal if group signaling fails (e.g. group already gone).
    }
  }
  if (target.pid && target.pid > 0) {
    try {
      process.kill(target.pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function resolveOpenCodeBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

// Build the ordered list of fallback models for cross-provider failover (THA-422).
// Reads adapterConfig.fallbackModels (string[]), drops anything that is not a
// valid provider/model id, the primary `model` itself, and duplicates, while
// preserving the configured order. Returning [] simply disables failover, so
// the adapter behaves exactly as before when no fallback is configured.
function resolveOpenCodeFallbackModels(fallbackConfig: unknown, primaryModel: string): string[] {
  const raw = asStringArray(fallbackConfig);
  const seen = new Set<string>();
  const normalizedPrimary = primaryModel.trim();
  if (normalizedPrimary) seen.add(normalizedPrimary);
  const fallbacks: string[] = [];
  for (const entry of raw) {
    const model = entry.trim();
    if (!model || seen.has(model)) continue;
    if (!isValidOpenCodeModelId(model)) continue;
    seen.add(model);
    fallbacks.push(model);
  }
  return fallbacks;
}

// True when an attempt exited with a provider-exhaustion class error that
// failover can address. Requires a non-timeout failure with either a parsed
// error message or a non-zero exit that classifies as exhaustion. Modeled on
// the existing `initialFailed`/missing-session predicate.
function isAttemptProviderExhaustionFailure(attempt: {
  proc: { exitCode: number | null; timedOut: boolean };
  parsed: ReturnType<typeof parseOpenCodeJsonl>;
}): boolean {
  if (attempt.proc.timedOut) return false;
  const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
  if (parsedError) return isOpenCodeProviderExhaustionError(parsedError);
  // Exit-code-only failure with no parsed error text cannot be reliably
  // classified as provider exhaustion; do not trigger failover on it.
  return false;
}

// True when the inactivity monitor fired and the assistant turn never completed.
// A hung provider emits no exhaustion signal (no error JSON, exitCode remains
// null after SIGTERM), so `isAttemptProviderExhaustionFailure` returns false —
// but failover is equally appropriate since the lane is unresponsive. This is
// the THA-6649 fix: treat a hung lane as a first-class failover trigger.
function isAttemptHangFailure(attempt: {
  proc: { stdout: string };
  monitor?: { fired: boolean };
}): boolean {
  return attempt.monitor?.fired === true && !hasOpenCodeCompletedTurn(attempt.proc.stdout);
}

const REMOTE_OPENCODE_MODELS_PROBE_DEFAULT_TIMEOUT_SEC = 20;
const REMOTE_OPENCODE_MODELS_PROBE_SANDBOX_TIMEOUT_SEC = 120;

export async function ensureRemoteOpenCodeModelConfiguredAndAvailable(input: {
  runId: string;
  executionTarget: NonNullable<AdapterExecutionContext["executionTarget"]>;
  command: string;
  model: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}) {
  const model = requireOpenCodeModelId(input.model);

  // When the caller opts into OPENCODE_ALLOW_ALL_MODELS, OpenCode accepts any
  // provider/model at run time (e.g. gateway-routed models that never appear in
  // `opencode models` output). Honour that on the REMOTE path too by skipping the
  // remote availability probe; we still enforce the provider/model format above.
  // Mirrors the local ensureOpenCodeModelConfiguredAndAvailable bypass. Prefer the
  // explicit run env, then the process env.
  if (isTruthyEnvFlag(input.env.OPENCODE_ALLOW_ALL_MODELS ?? process.env.OPENCODE_ALLOW_ALL_MODELS)) {
    return;
  }

  const defaultProbeTimeoutSec =
    input.executionTarget.kind === "remote" && input.executionTarget.transport === "sandbox"
      ? REMOTE_OPENCODE_MODELS_PROBE_SANDBOX_TIMEOUT_SEC
      : REMOTE_OPENCODE_MODELS_PROBE_DEFAULT_TIMEOUT_SEC;
  const probeTimeoutSec = input.timeoutSec > 0
    ? Math.min(input.timeoutSec, defaultProbeTimeoutSec)
    : defaultProbeTimeoutSec;
  const probe = await runAdapterExecutionTargetProcess(
    input.runId,
    input.executionTarget,
    input.command,
    ["models"],
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: probeTimeoutSec,
      graceSec: input.graceSec,
      onLog: async () => {},
    },
  );

  if (probe.timedOut) {
    throw new Error(`\`opencode models\` timed out on the remote execution target after ${probeTimeoutSec}s.`);
  }

  if ((probe.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(probe.stderr) || firstNonEmptyLine(probe.stdout);
    throw new Error(
      detail
        ? `\`opencode models\` failed on the remote execution target: ${detail}`
        : "`opencode models` failed on the remote execution target.",
    );
  }

  const models = parseOpenCodeModelsOutput(probe.stdout);
  if (models.length === 0) {
    throw new Error(
      "OpenCode returned no models on the remote execution target. Run `opencode models` there and verify provider auth.",
    );
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable on the remote execution target: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }
}

function claudeSkillsHome(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

async function ensureOpenCodeSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
) {
  const skillsHome = claudeSkillsHome();
  await fs.mkdir(skillsHome, { recursive: true });
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only OpenCode skill "${skillName}" from ${skillsHome}\n`,
    );
  }
  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} OpenCode skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject OpenCode skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function buildOpenCodeSkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-skills-"));
  const target = path.join(tmp, "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(resolvePaperclipDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return target;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "opencode");
  const model = asString(config.model, "").trim();
  const variant = asString(config.variant, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const openCodeSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredOpenCodeSkillNames = resolvePaperclipDesiredSkillNames(config, openCodeSkillEntries);
  if (!executionTargetIsRemote) {
    await ensureOpenCodeSkillsInjected(
      onLog,
      openCodeSkillEntries,
      desiredOpenCodeSkillNames,
    );
  }

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  // Prevent OpenCode from writing an opencode.json config file into the
  // project working directory (which would pollute the git repo).  Model
  // selection is already handled via the --model CLI flag.  Set after the
  // envConfig loop so user overrides cannot disable this guard.
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const preparedRuntimeConfig = await prepareOpenCodeRuntimeConfig({ env, config });
  const localRuntimeConfigHome =
    preparedRuntimeConfig.notes.length > 0 ? preparedRuntimeConfig.env.XDG_CONFIG_HOME : "";
  try {
    const runtimeEnv = Object.fromEntries(
      Object.entries(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env })).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: SANDBOX_INSTALL_COMMAND,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    let loggedEnv = buildInvocationEnvForLogs(preparedRuntimeConfig.env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });
    if (!executionTargetIsRemote) {
      await ensureOpenCodeModelConfiguredAndAvailable({
        model,
        command,
        cwd,
        env: runtimeEnv,
      });
    }

    const monitorResolution = resolveOpenCodeInactivityTimeout(config.outputInactivityTimeoutMs);
    if (monitorResolution.mode === "disabled") {
      await onLog(
        "stdout",
        `[paperclip] OpenCode output inactivity monitor is DISABLED via adapterConfig.outputInactivityTimeoutMs=null. Hung opencode runs will only be detected by the platform-level silent-run safety net.\n`,
      );
    } else if (monitorResolution.mode === "default" && "reason" in monitorResolution) {
      await onLog(
        "stdout",
        `[paperclip] Ignoring non-positive adapterConfig.outputInactivityTimeoutMs; falling back to default ${monitorResolution.timeoutMs}ms.\n`,
      );
    }

    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();
    let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
    let localSkillsDir: string | null = null;
    let remoteRuntimeRootDir: string | null = null;
    let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

    if (executionTarget?.kind === "remote") {
      localSkillsDir = await buildOpenCodeSkillsDir(config);
      await onLog(
        "stdout",
        `[paperclip] Syncing workspace and OpenCode runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "opencode",
        timeoutSec,
        workspaceLocalDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        assets: [
          {
            key: "skills",
            localDir: localSkillsDir,
            followSymlinks: true,
          },
          ...(localRuntimeConfigHome
            ? [{
              key: "xdgConfig",
              localDir: localRuntimeConfigHome,
            }]
            : []),
        ],
      });
      restoreRemoteWorkspace = () => preparedExecutionTargetRuntime.restoreWorkspace();
      effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
      refreshPaperclipWorkspaceEnvForExecution({
        env: preparedRuntimeConfig.env,
        envConfig,
        workspaceCwd: effectiveWorkspaceCwd,
        workspaceSource,
        workspaceId,
        workspaceRepoUrl,
        workspaceRepoRef,
        workspaceHints,
        agentHome,
        executionTargetIsRemote,
        executionCwd: effectiveExecutionCwd,
      });
      remoteRuntimeRootDir = preparedExecutionTargetRuntime.runtimeRootDir;
      const managedHome = adapterExecutionTargetUsesManagedHome(executionTarget);
      if (managedHome && preparedExecutionTargetRuntime.runtimeRootDir) {
        preparedRuntimeConfig.env.HOME = preparedExecutionTargetRuntime.runtimeRootDir;
      }
      if (localRuntimeConfigHome && preparedExecutionTargetRuntime.assetDirs.xdgConfig) {
        preparedRuntimeConfig.env.XDG_CONFIG_HOME = preparedExecutionTargetRuntime.assetDirs.xdgConfig;
      }
      const remoteHomeDir = managedHome && preparedExecutionTargetRuntime.runtimeRootDir
        ? preparedExecutionTargetRuntime.runtimeRootDir
        : await readAdapterExecutionTargetHomeDir(runId, executionTarget, {
            cwd,
            env: preparedRuntimeConfig.env,
            timeoutSec,
            graceSec,
            onLog,
          });
      if (remoteHomeDir && preparedExecutionTargetRuntime.assetDirs.skills) {
        const remoteSkillsDir = path.posix.join(remoteHomeDir, ".claude", "skills");
        await runAdapterExecutionTargetShellCommand(
          runId,
          executionTarget,
          `mkdir -p ${JSON.stringify(path.posix.dirname(remoteSkillsDir))} && rm -rf ${JSON.stringify(remoteSkillsDir)} && cp -a ${JSON.stringify(preparedExecutionTargetRuntime.assetDirs.skills)} ${JSON.stringify(remoteSkillsDir)}`,
          { cwd, env: preparedRuntimeConfig.env, timeoutSec, graceSec, onLog },
        );
      }
      await ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId,
        executionTarget,
        command,
        model,
        cwd,
        env: preparedRuntimeConfig.env,
        timeoutSec,
        graceSec,
      });
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "opencode",
        timeoutSec,
        hostApiToken: preparedRuntimeConfig.env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(preparedRuntimeConfig.env, paperclipBridge.env);
        loggedEnv = buildInvocationEnvForLogs(preparedRuntimeConfig.env, {
          runtimeEnv: Object.fromEntries(
            Object.entries(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env })).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          includeRuntimeKeys: ["HOME"],
          resolvedCommand,
        });
      }
    }

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
      adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const sessionId = canResumeSession ? runtimeSessionId : null;
    if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] OpenCode session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
      );
    } else if (runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] OpenCode session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
      );
    }
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const resolvedInstructionsFilePath = instructionsFilePath
      ? path.resolve(cwd, instructionsFilePath)
      : "";
    const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
    let instructionsPrefix = "";
    if (resolvedInstructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
        instructionsPrefix =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsDir}.\n\n`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
        );
      }
    }

    const commandNotes = (() => {
      const notes = [...preparedRuntimeConfig.notes];
      if (!resolvedInstructionsFilePath) return notes;
      if (instructionsPrefix.length > 0) {
        notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
        notes.push(
          `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
        );
        return notes;
      }
      notes.push(
        `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      );
      return notes;
    })();

    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const renderedBootstrapPrompt =
      !sessionId && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
    const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
    const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const prompt = joinPromptSections([
      instructionsPrefix,
      renderedBootstrapPrompt,
      wakePrompt,
      sessionHandoffNote,
      renderedPrompt,
    ]);
    const promptMetrics = {
      promptChars: prompt.length,
      instructionsChars: instructionsPrefix.length,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    };

    // Optional diagnostic: surface OpenCode's own logs on stderr (captured into the
    // run result) so failures that OpenCode otherwise wraps as an opaque
    // "Unexpected server error" can be diagnosed in remote/sandbox runs where the
    // log file is unreachable. Toggle via PAPERCLIP_OPENCODE_PRINT_LOGS (run env,
    // then process env).
    const printLogs = isTruthyEnvFlag(
      env.PAPERCLIP_OPENCODE_PRINT_LOGS ?? process.env.PAPERCLIP_OPENCODE_PRINT_LOGS,
    );
    const buildArgs = (resumeSessionId: string | null, activeModel: string) => {
      const args = ["run", "--format", "json"];
      if (printLogs) args.push("--print-logs");
      if (resumeSessionId) args.push("--session", resumeSessionId);
      if (activeModel) args.push("--model", activeModel);
      if (variant) args.push("--variant", variant);
      if (extraArgs.length > 0) args.push(...extraArgs);
      return args;
    };

    const runAttempt = async (resumeSessionId: string | null, activeModel: string) => {
      const args = buildArgs(resumeSessionId, activeModel);
      if (onMeta) {
        await onMeta({
          adapterType: "opencode_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: [...args, `<stdin prompt ${prompt.length} chars>`],
          env: loggedEnv,
          prompt,
          promptMetrics,
          context,
        });
      }

      let monitorFired = false;
      let monitorTerminationSignal: NodeJS.Signals | null = null;
      let monitorElapsedMs = 0;
      let monitorTimeoutMs = 0;
      let killTarget: { pid: number | null; processGroupId: number | null } | null = null;
      let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
      let monitorLogPromise: Promise<unknown> | null = null;

      const monitor =
        monitorResolution.mode === "disabled"
          ? null
          : createOpenCodeOutputInactivityMonitor({
              timeoutMs: monitorResolution.timeoutMs,
              onFire: (state) => {
                monitorFired = true;
                monitorElapsedMs = (state.firedAt ?? Date.now()) - state.lastEventAt;
                monitorTimeoutMs = monitorResolution.timeoutMs;
                const message = formatOutputInactivityMonitorErrorMessage(monitorElapsedMs);
                const elapsedSec = Math.round(monitorElapsedMs / 1000);
                const timeoutSecLabel = Math.round(monitorResolution.timeoutMs / 1000);
                const logLine =
                  `[paperclip] adapter.invoke ${message}; ` +
                  `timeoutMs=${monitorResolution.timeoutMs} elapsedSinceLastEventMs=${monitorElapsedMs} ` +
                  `parsedEvents=${state.parsedEventCount} (timeout=${timeoutSecLabel}s elapsed=${elapsedSec}s); ` +
                  `terminating opencode child via SIGTERM (5s grace, then SIGKILL).\n`;
                monitorLogPromise = Promise.resolve(onLog("stderr", logLine)).catch(() => {});
                const target = killTarget;
                if (!target || (target.pid == null && target.processGroupId == null)) {
                  return;
                }
                const sentSig = signalOpenCodeChild(target, "SIGTERM");
                if (sentSig) monitorTerminationSignal = "SIGTERM";
                sigkillTimer = setTimeout(() => {
                  sigkillTimer = null;
                  const stillSent = signalOpenCodeChild(target, "SIGKILL");
                  if (stillSent) monitorTerminationSignal = "SIGKILL";
                }, OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS);
                if (typeof (sigkillTimer as { unref?: () => void }).unref === "function") {
                  (sigkillTimer as { unref: () => void }).unref();
                }
              },
            });

      const wrappedOnSpawn = async (meta: { pid: number; processGroupId: number | null; startedAt: string }) => {
        killTarget = { pid: meta.pid ?? null, processGroupId: meta.processGroupId };
        if (onSpawn) {
          await onSpawn(meta);
        }
      };

      try {
        const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
          cwd,
          env: preparedRuntimeConfig.env,
          stdin: prompt,
          timeoutSec,
          graceSec,
          onSpawn: wrappedOnSpawn,
          onLog: async (stream, chunk) => {
            if (stream === "stdout") {
              monitor?.noteStdoutChunk(chunk);
            }
            await onLog(stream, chunk);
          },
        });
        return {
          proc,
          rawStderr: proc.stderr,
          parsed: parseOpenCodeJsonl(proc.stdout),
          monitor: monitorFired
            ? {
                fired: true as const,
                terminationSignal: monitorTerminationSignal,
                elapsedMsSinceLastEvent: monitorElapsedMs,
                timeoutMs: monitorTimeoutMs,
              }
            : { fired: false as const },
        };
      } finally {
        monitor?.stop();
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
          sigkillTimer = null;
        }
        if (monitorLogPromise) {
          await monitorLogPromise;
          monitorLogPromise = null;
        }
      }
    };

    const toResult = (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
        rawStderr: string;
        parsed: ReturnType<typeof parseOpenCodeJsonl>;
        monitor?:
          | { fired: false }
          | { fired: true; terminationSignal: NodeJS.Signals | null; elapsedMsSinceLastEvent: number; timeoutMs: number };
      },
      activeModel: string,
      clearSessionOnMissingSession = false,
    ): AdapterExecutionResult => {
      if (attempt.monitor?.fired) {
        // If the assistant turn completed (step_finish seen) before the monitor
        // reaped the lingering child, do NOT surface a failure — the work is
        // done, only the process failed to exit on its own. Fall through to the
        // normal result path, which synthesizes a successful result.
        if (!hasOpenCodeCompletedTurn(attempt.proc.stdout)) {
          const errorMessage = formatOutputInactivityMonitorErrorMessage(attempt.monitor.elapsedMsSinceLastEvent);
          return {
            exitCode: null,
            signal: attempt.monitor.terminationSignal ?? attempt.proc.signal,
            timedOut: false,
            errorMessage,
            errorCode: "opencode_output_inactivity_monitor",
            errorFamily: null,
            usage: attempt.parsed.usage,
            sessionId: null,
            sessionParams: null,
            sessionDisplayId: null,
            provider: parseModelProvider(activeModel || null),
            biller: resolveOpenCodeBiller(runtimeEnv, parseModelProvider(activeModel || null)),
            model: activeModel || null,
            billingType: "unknown",
            costUsd: attempt.parsed.costUsd,
            resultJson: {
              stdout: attempt.proc.stdout,
              stderr: attempt.proc.stderr,
              outputInactivityMonitor: {
                kind: "output_inactivity",
                timeoutMs: attempt.monitor.timeoutMs,
                elapsedMsSinceLastEvent: attempt.monitor.elapsedMsSinceLastEvent,
                terminationSignal: attempt.monitor.terminationSignal,
              },
            },
            summary: attempt.parsed.summary,
            clearSession: clearSessionOnMissingSession,
          };
        }
      }
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const resolvedSessionId =
        attempt.parsed.sessionId ??
        (clearSessionOnMissingSession ? null : runtimeSessionId ?? runtime.sessionId ?? null);
      const resolvedSessionParams = resolvedSessionId
        ? ({
            sessionId: resolvedSessionId,
            cwd: effectiveExecutionCwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
            ...(executionTargetIsRemote
              ? {
                  remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
                }
              : {}),
          } as Record<string, unknown>)
        : null;

      const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      // When the output-inactivity monitor reaped a child whose turn already
      // completed (step_finish seen), the process exits with signal=SIGTERM and
      // exitCode=null. Synthesize exit 0 so the completed work is not converted
      // into a failed run.
      const completedTurnReaped =
        attempt.proc.exitCode === null &&
        attempt.proc.signal === "SIGTERM" &&
        hasOpenCodeCompletedTurn(attempt.proc.stdout);
      const rawExitCode = completedTurnReaped ? 0 : attempt.proc.exitCode;
      const synthesizedExitCode = parsedError && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
      const fallbackErrorMessage =
        parsedError ||
        stderrLine ||
        `OpenCode exited with code ${synthesizedExitCode ?? -1}`;
      const modelId = activeModel || null;

      return {
        exitCode: synthesizedExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
        usage: {
          inputTokens: attempt.parsed.usage.inputTokens,
          outputTokens: attempt.parsed.usage.outputTokens,
          cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: parseModelProvider(modelId),
        biller: resolveOpenCodeBiller(runtimeEnv, parseModelProvider(modelId)),
        model: modelId,
        billingType: "unknown",
        costUsd: attempt.parsed.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
          ...(attempt.monitor?.fired
            ? {
                outputInactivityMonitor: {
                  kind: "output_inactivity_completed_turn_reaped",
                  timeoutMs: attempt.monitor.timeoutMs,
                  elapsedMsSinceLastEvent: attempt.monitor.elapsedMsSinceLastEvent,
                  terminationSignal: attempt.monitor.terminationSignal,
                },
              }
            : {}),
        },
        summary: attempt.parsed.summary,
        clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
      };
    };

    // Ordered fallback models for cross-provider failover on provider-exhaustion
    // (THA-422). Empty when not configured, so behaviour is unchanged from before.
    const fallbackModels = resolveOpenCodeFallbackModels(config.fallbackModels, model);

    try {
      const initial = await runAttempt(sessionId, model);
      // THA-6649: a hung primary (inactivity monitor fired, turn not complete)
      // must also count as failed so the failover block below can run.
      const initialHung = isAttemptHangFailure(initial);
      const initialFailed =
        initialHung ||
        (!initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || Boolean(initial.parsed.errorMessage)));
      if (
        sessionId &&
        initialFailed &&
        !initialHung &&
        isOpenCodeUnknownSessionError(initial.proc.stdout, initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] OpenCode session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        const retry = await runAttempt(null, model);
        return toResult(retry, model, true);
      }

      // Cross-provider failover: when the primary model hit a provider-exhaustion
      // class error (usage/rate/overload/connection) OR hung (inactivity monitor
      // fired, THA-6649), and an ordered fallback model list is configured,
      // re-run on the next already-authed provider. Modeled on the missing-session
      // retry above. Failover always starts a FRESH session (a different provider
      // cannot resume the primary's session) and forces clearSession so the next
      // heartbeat does not attempt a cross-provider resume. THA-386 attribution
      // is automatic: toResult attributes provider/biller/model from the model
      // that actually served.
      if (initialFailed && (isAttemptProviderExhaustionFailure(initial) || initialHung) && fallbackModels.length > 0) {
        let failoverAttempt = initial;
        let failoverModel = model;
        let currentFailureIsHang = initialHung;
        for (const candidateModel of fallbackModels) {
          const reasonLabel = currentFailureIsHang
            ? "hung (inactivity monitor fired)"
            : "hit a provider-exhaustion error";
          await onLog(
            "stdout",
            `[paperclip] OpenCode model "${failoverModel}" ${reasonLabel}; failing over to "${candidateModel}".\n`,
          );
          const candidate = await runAttempt(null, candidateModel);
          failoverAttempt = candidate;
          failoverModel = candidateModel;
          const candidateHung = isAttemptHangFailure(candidate);
          const candidateFailed =
            candidateHung ||
            (!candidate.proc.timedOut &&
              ((candidate.proc.exitCode ?? 0) !== 0 || Boolean(candidate.parsed.errorMessage)));
          if (!candidateFailed) {
            await onLog(
              "stdout",
              `[paperclip] OpenCode failover succeeded on "${candidateModel}".\n`,
            );
            break;
          }
          if (isAttemptProviderExhaustionFailure(candidate) || candidateHung) {
            currentFailureIsHang = candidateHung;
            const candidateReasonLabel = candidateHung ? "hung" : "hit a provider-exhaustion error";
            await onLog(
              "stdout",
              `[paperclip] OpenCode fallback "${candidateModel}" also ${candidateReasonLabel}; continuing to next fallback.\n`,
            );
            continue;
          }
          // Non-exhaustion, non-hang failure on the fallback: stop failing over and surface it.
          break;
        }
        const result = toResult(failoverAttempt, failoverModel, true);
        // A fallback-provider session must not be resumed by the next heartbeat's
        // primary --model, so always drop the stored session after a failover.
        result.clearSession = true;
        return result;
      }

      return toResult(initial, model);
    } finally {
      await Promise.all([
        paperclipBridge?.stop(),
        restoreRemoteWorkspace?.(),
        localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
      ]);
    }
  } finally {
    await preparedRuntimeConfig.cleanup();
  }
}
