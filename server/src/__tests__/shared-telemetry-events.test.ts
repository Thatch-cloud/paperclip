import { describe, expect, it, vi } from "vitest";
import {
  trackAgentCreated,
  trackAgentFirstHeartbeat,
  trackAgentTaskCompleted,
  trackInstallCompleted,
  trackTrainingAcceleratorUtilization,
  trackTrainingCheckpoint,
  trackTrainingEvalGate,
  trackTrainingLifecycle,
  trackTrainingQueueWait,
  trackTrainingThroughput,
} from "@paperclipai/shared/telemetry";
import type { TelemetryClient } from "@paperclipai/shared/telemetry";

function createClient(): TelemetryClient {
  return {
    track: vi.fn(),
    hashPrivateRef: vi.fn((value: string) => `hashed:${value}`),
  } as unknown as TelemetryClient;
}

describe("shared telemetry agent events", () => {
  it("includes agent_id for agent.created", () => {
    const client = createClient();

    trackAgentCreated(client, {
      agentRole: "engineer",
      agentId: "11111111-1111-4111-8111-111111111111",
    });

    expect(client.track).toHaveBeenCalledWith("agent.created", {
      agent_role: "engineer",
      agent_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("includes agent_id for agent.first_heartbeat", () => {
    const client = createClient();

    trackAgentFirstHeartbeat(client, {
      agentRole: "coder",
      agentId: "22222222-2222-4222-8222-222222222222",
    });

    expect(client.track).toHaveBeenCalledWith("agent.first_heartbeat", {
      agent_role: "coder",
      agent_id: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("includes agent_id for agent.task_completed", () => {
    const client = createClient();

    trackAgentTaskCompleted(client, {
      agentRole: "qa",
      agentId: "33333333-3333-4333-8333-333333333333",
    });

    expect(client.track).toHaveBeenCalledWith("agent.task_completed", {
      agent_role: "qa",
      agent_id: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("keeps non-agent event dimensions unchanged", () => {
    const client = createClient();

    trackInstallCompleted(client, { adapterType: "codex_local" });

    expect(client.track).toHaveBeenCalledWith("install.completed", {
      adapter_type: "codex_local",
    });
    expect(client.track).not.toHaveBeenCalledWith(
      "install.completed",
      expect.objectContaining({ agent_id: expect.any(String) }),
    );
  });

  it("emits the zero-content training telemetry contract", () => {
    const client = createClient();
    const base = {
      trainingJobId: "job-123",
      tenantId: "tenant-456",
      nodeId: "node-a",
      acceleratorId: "gpu-0",
      acceleratorType: "cuda-rtx-pro-6000",
    };

    trackTrainingLifecycle(client, { ...base, state: "running" });
    trackTrainingThroughput(client, { ...base, samplesPerSecond: 12.5, tokensPerSecond: 4096 });
    trackTrainingEvalGate(client, {
      ...base,
      outcome: "passed",
      metricName: "validation_loss",
      metricValue: 0.42,
      threshold: 0.5,
    });
    trackTrainingAcceleratorUtilization(client, {
      ...base,
      utilizationPercent: 91,
      occupancyPercent: 87,
      memoryUsedBytes: 42_000_000_000,
    });
    trackTrainingCheckpoint(client, {
      ...base,
      state: "completed",
      checkpointId: "checkpoint-7",
      checkpointBytes: 1_024,
    });
    trackTrainingQueueWait(client, { ...base, waitMs: 8_000, queueName: "cuda" });

    expect(client.track).toHaveBeenCalledWith(
      "training.lifecycle",
      expect.objectContaining({
        training_job_ref: "hashed:job-123",
        tenant_ref: "hashed:tenant-456",
        node_id: "node-a",
        accelerator_id: "gpu-0",
        accelerator_type: "cuda-rtx-pro-6000",
        state: "running",
      }),
    );
    expect(client.track).toHaveBeenCalledWith(
      "training.throughput",
      expect.objectContaining({ samples_per_second: 12.5, tokens_per_second: 4096 }),
    );
    expect(client.track).toHaveBeenCalledWith(
      "training.eval_gate",
      expect.objectContaining({ outcome: "passed", metric_name: "validation_loss" }),
    );
    expect(client.track).toHaveBeenCalledWith(
      "training.accelerator_utilization",
      expect.objectContaining({ utilization_percent: 91, occupancy_percent: 87 }),
    );
    expect(client.track).toHaveBeenCalledWith(
      "training.checkpoint",
      expect.objectContaining({ checkpoint_ref: "hashed:checkpoint-7" }),
    );
    expect(client.track).toHaveBeenCalledWith(
      "training.queue_wait",
      expect.objectContaining({ wait_ms: 8_000, queue_name: "cuda" }),
    );
  });

  it("rejects synthetic dataset content on training telemetry surfaces", () => {
    const client = createClient();
    const datasetToken = "DATASET-CANARY-THA-6092 unique customer row";

    expect(() =>
      trackTrainingLifecycle(client, {
        trainingJobId: datasetToken,
        state: "running",
      }),
    ).toThrow(/opaque identifier/);
    expect(() =>
      trackTrainingQueueWait(client, {
        trainingJobId: "job-123",
        waitMs: 1,
        queueName: datasetToken,
      }),
    ).toThrow(/bounded normalized telemetry label/);
    expect(() =>
      trackTrainingEvalGate(client, {
        trainingJobId: "job-123",
        outcome: "failed",
        metricName: "s3://customer-bucket/train.jsonl",
        metricValue: 0.7,
      }),
    ).toThrow(/bounded normalized telemetry label/);

    expect(JSON.stringify(vi.mocked(client.track).mock.calls)).not.toContain(datasetToken);
  });
});
