import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENCODE_OUTPUT_INACTIVITY_TIMEOUT_MS,
  OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  createOpenCodeOutputInactivityMonitor,
  formatOutputInactivityMonitorErrorMessage,
  resolveOpenCodeInactivityTimeout,
} from "./output-inactivity-monitor.js";

class FakeClock {
  private nowMs = 0;
  private nextHandle = 1;
  private timers = new Map<number, { fireAt: number; cb: () => void }>();

  now(): number {
    return this.nowMs;
  }

  setTimer(cb: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, { fireAt: this.nowMs + ms, cb });
    return handle;
  }

  clearTimer(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  advance(ms: number): void {
    const targetMs = this.nowMs + ms;
    while (true) {
      let nextHandle: number | null = null;
      let nextTimer: { fireAt: number; cb: () => void } | null = null;
      for (const [h, timer] of this.timers) {
        if (timer.fireAt <= targetMs && (!nextTimer || timer.fireAt < nextTimer.fireAt)) {
          nextHandle = h;
          nextTimer = timer;
        }
      }
      if (!nextTimer || nextHandle == null) break;
      this.timers.delete(nextHandle);
      this.nowMs = nextTimer.fireAt;
      nextTimer.cb();
    }
    this.nowMs = targetMs;
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }
}

describe("resolveOpenCodeInactivityTimeout", () => {
  it("uses default when value is unset", () => {
    expect(resolveOpenCodeInactivityTimeout(undefined)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_OPENCODE_OUTPUT_INACTIVITY_TIMEOUT_MS,
    });
  });

  it("treats explicit null as disabled", () => {
    expect(resolveOpenCodeInactivityTimeout(null)).toEqual({
      mode: "disabled",
      reason: "explicit_null",
    });
  });

  it("returns configured value for positive numbers", () => {
    expect(resolveOpenCodeInactivityTimeout(12_000)).toEqual({
      mode: "configured",
      timeoutMs: 12_000,
    });
  });

  it("falls back to default for non-positive numbers", () => {
    expect(resolveOpenCodeInactivityTimeout(0)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_OPENCODE_OUTPUT_INACTIVITY_TIMEOUT_MS,
      reason: "non_positive",
    });
    expect(resolveOpenCodeInactivityTimeout(-100)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_OPENCODE_OUTPUT_INACTIVITY_TIMEOUT_MS,
      reason: "non_positive",
    });
  });

  it("falls back to default for non-number, non-null values", () => {
    expect(resolveOpenCodeInactivityTimeout("420000")).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_OPENCODE_OUTPUT_INACTIVITY_TIMEOUT_MS,
    });
  });
});

describe("formatOutputInactivityMonitorErrorMessage", () => {
  it("formats minutes and seconds", () => {
    expect(formatOutputInactivityMonitorErrorMessage(0)).toBe("monitor: no opencode output for 0m 0s");
    expect(formatOutputInactivityMonitorErrorMessage(7 * 60 * 1000)).toBe("monitor: no opencode output for 7m 0s");
    expect(formatOutputInactivityMonitorErrorMessage(7 * 60 * 1000 + 12_000)).toBe(
      "monitor: no opencode output for 7m 12s",
    );
    expect(formatOutputInactivityMonitorErrorMessage(45_000)).toBe("monitor: no opencode output for 0m 45s");
  });
});

describe("createOpenCodeOutputInactivityMonitor (fires)", () => {
  it("fires after timeoutMs when child emits one event then goes silent", () => {
    const clock = new FakeClock();
    const fires: Array<{ elapsed: number; parsedEventCount: number }> = [];
    const monitor = createOpenCodeOutputInactivityMonitor({
      timeoutMs: 7 * 60 * 1000,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: (state) => {
        fires.push({
          elapsed: (state.firedAt ?? 0) - state.lastEventAt,
          parsedEventCount: state.parsedEventCount,
        });
      },
    });

    clock.advance(50);
    monitor.noteStdoutChunk('{"type":"text","part":{"text":"hello"}}\n');
    expect(fires).toHaveLength(0);
    expect(monitor.state().parsedEventCount).toBe(1);

    clock.advance(7 * 60 * 1000 - 1);
    expect(fires).toHaveLength(0);
    clock.advance(1);
    expect(fires).toHaveLength(1);
    expect(fires[0].elapsed).toBe(7 * 60 * 1000);
    expect(fires[0].parsedEventCount).toBe(1);

    const finalState = monitor.stop();
    expect(finalState.fired).toBe(true);
  });

  it("only fires once even if more silence elapses after firing", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const monitor = createOpenCodeOutputInactivityMonitor({
      timeoutMs: 1_000,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });
    clock.advance(2_000);
    expect(fireCount).toBe(1);
    clock.advance(10_000);
    expect(fireCount).toBe(1);
    monitor.stop();
  });

  it("ignores non-JSON lines when resetting the timer", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const monitor = createOpenCodeOutputInactivityMonitor({
      timeoutMs: 1_000,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });
    clock.advance(500);
    monitor.noteStdoutChunk("loading model...\n");
    expect(monitor.state().parsedEventCount).toBe(0);
    clock.advance(600);
    expect(fireCount).toBe(1);
    monitor.stop();
  });
});

describe("createOpenCodeOutputInactivityMonitor (does not fire)", () => {
  it("does not fire when events arrive every (threshold - 1s)", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const timeoutMs = 7 * 60 * 1000;
    const monitor = createOpenCodeOutputInactivityMonitor({
      timeoutMs,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });

    for (let i = 0; i < 12; i += 1) {
      clock.advance(timeoutMs - 1_000);
      monitor.noteStdoutChunk(`{"type":"text","part":{"text":"tick ${i}"}}\n`);
      expect(fireCount).toBe(0);
    }

    expect(monitor.state().parsedEventCount).toBe(12);
    expect(fireCount).toBe(0);
    monitor.stop();
    expect(fireCount).toBe(0);
  });

  it("multiple events in one chunk all reset the timer", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const monitor = createOpenCodeOutputInactivityMonitor({
      timeoutMs: 1_000,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });
    clock.advance(500);
    monitor.noteStdoutChunk(
      '{"type":"text","part":{"text":"a"}}\n{"type":"step_finish","part":{"tokens":{"input":1,"output":1}}}\n',
    );
    expect(monitor.state().parsedEventCount).toBe(2);
    clock.advance(999);
    expect(fireCount).toBe(0);
    clock.advance(1);
    expect(fireCount).toBe(1);
    monitor.stop();
  });
});

describe("createOpenCodeOutputInactivityMonitor (disabled)", () => {
  it("resolveOpenCodeInactivityTimeout returns disabled for null and the adapter creates no monitor", () => {
    const resolution = resolveOpenCodeInactivityTimeout(null);
    expect(resolution.mode).toBe("disabled");
    expect(() =>
      createOpenCodeOutputInactivityMonitor({
        timeoutMs: 0,
        onFire: () => {},
      }),
    ).toThrow(/timeoutMs > 0/);
  });
});

describe("OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS", () => {
  it("matches the 5-second grace window", () => {
    expect(OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS).toBe(5_000);
  });
});
