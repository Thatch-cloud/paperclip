import type { TelemetryClient } from "./client.js";

export type TrainingLifecycleState =
  | "queued"
  | "scheduled"
  | "running"
  | "evaluating"
  | "checkpointing"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TrainingEvalGateOutcome = "pending" | "passed" | "failed";

export type TrainingCheckpointState = "started" | "completed" | "failed";

export interface TrainingTelemetryIdentity {
  trainingJobId: string;
  tenantId?: string;
  nodeId?: string;
  acceleratorId?: string;
  acceleratorType?: string;
}

interface TrainingBaseDimensions {
  training_job_ref: string;
  tenant_ref?: string;
  node_id?: string;
  accelerator_id?: string;
  accelerator_type?: string;
}

function trainingBaseDimensions(
  client: TelemetryClient,
  dims: TrainingTelemetryIdentity,
): Record<string, string | number | boolean> {
  return compactDimensions({
    training_job_ref: client.hashPrivateRef(requireTelemetryId("trainingJobId", dims.trainingJobId)),
    tenant_ref: dims.tenantId ? client.hashPrivateRef(requireTelemetryId("tenantId", dims.tenantId)) : undefined,
    node_id: dims.nodeId ? requireSafeTelemetryLabel("nodeId", dims.nodeId) : undefined,
    accelerator_id: dims.acceleratorId
      ? requireSafeTelemetryLabel("acceleratorId", dims.acceleratorId)
      : undefined,
    accelerator_type: dims.acceleratorType
      ? requireSafeTelemetryLabel("acceleratorType", dims.acceleratorType)
      : undefined,
  });
}

function requireTelemetryId(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required for training telemetry`);
  }
  if (looksLikeContent(trimmed)) {
    throw new Error(`${field} must be an opaque identifier, not customer content`);
  }
  return trimmed;
}

function requireSafeTelemetryLabel(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required when provided for training telemetry`);
  }
  if (trimmed.length > 96 || looksLikeContent(trimmed)) {
    throw new Error(`${field} must be a bounded normalized telemetry label`);
  }
  return trimmed;
}

function looksLikeContent(value: string): boolean {
  return (
    /\s/.test(value) ||
    /[{}[\]<>]/.test(value) ||
    /(?:^|[:/\\.])(?:jsonl?|csv|parquet|txt|md|zip|tar|gz)(?:$|[?#])/i.test(value) ||
    /(?:s3|gs|https?|file):\/\//i.test(value)
  );
}

function compactDimensions<T extends Record<string, string | number | boolean | undefined>>(
  dims: T,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(dims).filter((entry): entry is [string, string | number | boolean] => {
      return entry[1] !== undefined;
    }),
  );
}

export function trackInstallStarted(client: TelemetryClient): void {
  client.track("install.started");
}

export function trackInstallCompleted(
  client: TelemetryClient,
  dims: { adapterType: string },
): void {
  client.track("install.completed", { adapter_type: dims.adapterType });
}

export function trackCompanyImported(
  client: TelemetryClient,
  dims: { sourceType: string; sourceRef: string; isPrivate: boolean },
): void {
  const ref = dims.isPrivate ? client.hashPrivateRef(dims.sourceRef) : dims.sourceRef;
  client.track("company.imported", {
    source_type: dims.sourceType,
    source_ref: ref,
    source_ref_hashed: dims.isPrivate,
  });
}

export function trackProjectCreated(client: TelemetryClient): void {
  client.track("project.created");
}

export function trackRoutineCreated(client: TelemetryClient): void {
  client.track("routine.created");
}

export function trackRoutineRun(
  client: TelemetryClient,
  dims: { source: string; status: string },
): void {
  client.track("routine.run", {
    source: dims.source,
    status: dims.status,
  });
}

export function trackGoalCreated(
  client: TelemetryClient,
  dims?: { goalLevel?: string | null },
): void {
  client.track("goal.created", dims?.goalLevel ? { goal_level: dims.goalLevel } : undefined);
}

export function trackAgentCreated(
  client: TelemetryClient,
  dims: { agentRole: string; agentId?: string },
): void {
  client.track("agent.created", {
    agent_role: dims.agentRole,
    ...(dims.agentId ? { agent_id: dims.agentId } : {}),
  });
}

export function trackSkillImported(
  client: TelemetryClient,
  dims: { sourceType: string; skillRef?: string | null },
): void {
  client.track("skill.imported", {
    source_type: dims.sourceType,
    ...(dims.skillRef ? { skill_ref: dims.skillRef } : {}),
  });
}

export function trackAgentFirstHeartbeat(
  client: TelemetryClient,
  dims: { agentRole: string; agentId?: string },
): void {
  client.track("agent.first_heartbeat", {
    agent_role: dims.agentRole,
    ...(dims.agentId ? { agent_id: dims.agentId } : {}),
  });
}

export function trackAgentTaskCompleted(
  client: TelemetryClient,
  dims: { agentRole: string; agentId?: string; adapterType?: string; model?: string },
): void {
  client.track("agent.task_completed", {
    agent_role: dims.agentRole,
    ...(dims.agentId ? { agent_id: dims.agentId } : {}),
    ...(dims.adapterType ? { adapter_type: dims.adapterType } : {}),
    ...(dims.model ? { model: dims.model } : {}),
  });
}

export function trackErrorHandlerCrash(
  client: TelemetryClient,
  dims: { errorCode: string },
): void {
  client.track("error.handler_crash", { error_code: dims.errorCode });
}

export function trackTrainingLifecycle(
  client: TelemetryClient,
  dims: TrainingTelemetryIdentity & { state: TrainingLifecycleState; reasonCode?: string },
): void {
  client.track(
    "training.lifecycle",
    compactDimensions({
      ...trainingBaseDimensions(client, dims),
      state: dims.state,
      reason_code: dims.reasonCode ? requireSafeTelemetryLabel("reasonCode", dims.reasonCode) : undefined,
    }),
  );
}

export function trackTrainingThroughput(
  client: TelemetryClient,
  dims: TrainingTelemetryIdentity & {
    samplesPerSecond: number;
    tokensPerSecond?: number;
    step?: number;
  },
): void {
  client.track(
    "training.throughput",
    compactDimensions({
      ...trainingBaseDimensions(client, dims),
      samples_per_second: dims.samplesPerSecond,
      tokens_per_second: dims.tokensPerSecond,
      step: dims.step,
    }),
  );
}

export function trackTrainingEvalGate(
  client: TelemetryClient,
  dims: TrainingTelemetryIdentity & {
    outcome: TrainingEvalGateOutcome;
    metricName: string;
    metricValue: number;
    threshold?: number;
  },
): void {
  client.track(
    "training.eval_gate",
    compactDimensions({
      ...trainingBaseDimensions(client, dims),
      outcome: dims.outcome,
      metric_name: requireSafeTelemetryLabel("metricName", dims.metricName),
      metric_value: dims.metricValue,
      threshold: dims.threshold,
    }),
  );
}

export function trackTrainingAcceleratorUtilization(
  client: TelemetryClient,
  dims: TrainingTelemetryIdentity & {
    utilizationPercent: number;
    occupancyPercent?: number;
    memoryUsedBytes?: number;
  },
): void {
  client.track(
    "training.accelerator_utilization",
    compactDimensions({
      ...trainingBaseDimensions(client, dims),
      utilization_percent: dims.utilizationPercent,
      occupancy_percent: dims.occupancyPercent,
      memory_used_bytes: dims.memoryUsedBytes,
    }),
  );
}

export function trackTrainingCheckpoint(
  client: TelemetryClient,
  dims: TrainingTelemetryIdentity & {
    state: TrainingCheckpointState;
    checkpointId?: string;
    checkpointBytes?: number;
    step?: number;
  },
): void {
  client.track(
    "training.checkpoint",
    compactDimensions({
      ...trainingBaseDimensions(client, dims),
      state: dims.state,
      checkpoint_ref: dims.checkpointId
        ? client.hashPrivateRef(requireTelemetryId("checkpointId", dims.checkpointId))
        : undefined,
      checkpoint_bytes: dims.checkpointBytes,
      step: dims.step,
    }),
  );
}

export function trackTrainingQueueWait(
  client: TelemetryClient,
  dims: TrainingTelemetryIdentity & { waitMs: number; queueName?: string },
): void {
  client.track(
    "training.queue_wait",
    compactDimensions({
      ...trainingBaseDimensions(client, dims),
      wait_ms: dims.waitMs,
      queue_name: dims.queueName ? requireSafeTelemetryLabel("queueName", dims.queueName) : undefined,
    }),
  );
}
