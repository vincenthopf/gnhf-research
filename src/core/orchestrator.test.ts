import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git.js")>();
  return {
    ...actual,
    commitAll: vi.fn(() => true),
    getBranchCommitCount: vi.fn(() => 0),
    getCurrentBranch: vi.fn(() => "gnhf/run-abc"),
    getHeadCommit: vi.fn(() => "head123"),
    pushCurrentBranch: vi.fn(),
    resetHard: vi.fn(),
  };
});

vi.mock("./run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run.js")>();
  return {
    ...actual,
    appendNotes: vi.fn(),
  };
});

vi.mock("./debug-log.js", () => ({
  appendDebugLog: vi.fn(),
  initDebugLog: vi.fn(),
  serializeError: vi.fn((err: unknown) =>
    err instanceof Error
      ? { name: err.name, message: err.message }
      : { value: String(err) },
  ),
}));

vi.mock("../templates/iteration-prompt.js", () => ({
  buildIterationPrompt: vi.fn(() => "iteration prompt"),
}));

import {
  CommitFailedError,
  commitAll,
  pushCurrentBranch,
  resetHard,
} from "./git.js";
import { appendNotes } from "./run.js";
import { appendDebugLog } from "./debug-log.js";
import { Orchestrator } from "./orchestrator.js";
import {
  PermanentAgentError,
  RateLimitAgentError,
  type Agent,
  type AgentResult,
} from "./agents/types.js";
import { CONVENTIONAL_COMMIT_MESSAGE } from "./commit-message.js";
import { formatDeadline } from "./deadline.js";
import { buildIterationPrompt } from "../templates/iteration-prompt.js";
import type { Config } from "./config.js";
import type { RunInfo } from "./run.js";

const mockCommitAll = vi.mocked(commitAll);
const mockPushCurrentBranch = vi.mocked(pushCurrentBranch);
const mockAppendNotes = vi.mocked(appendNotes);
const mockResetHard = vi.mocked(resetHard);
const mockAppendDebugLog = vi.mocked(appendDebugLog);

const config: Config = {
  agentPathOverride: {},
  agentModel: {},
  agentArgsOverride: {},
  effort: "medium",
  maxConsecutiveFailures: 3,
  observerEvery: 5,
  preventSleep: true,
};

const runInfo: RunInfo = {
  runId: "run-abc",
  runDir: "/repo/.gnhf/runs/run-abc",
  promptPath: "/repo/.gnhf/runs/run-abc/prompt.md",
  notesPath: "/repo/.gnhf/runs/run-abc/notes.md",
  schemaPath: "/repo/.gnhf/runs/run-abc/output-schema.json",
  logPath: "/repo/.gnhf/runs/run-abc/gnhf.log",
  baseCommit: "base123",
  baseCommitPath: "/repo/.gnhf/runs/run-abc/base-commit",
  stopWhenPath: "/repo/.gnhf/runs/run-abc/stop-when",
  stopWhen: undefined,
  commitMessagePath: "/repo/.gnhf/runs/run-abc/commit-message",
  commitMessage: undefined,
  workflowPath: "/repo/.gnhf/runs/run-abc/workflow",
  workflow: "default",
};

function createSuccessResult(summary = "done"): AgentResult {
  return {
    output: {
      success: true,
      summary,
      key_changes_made: ["file.ts"],
      key_learnings: ["learning"],
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  };
}

describe("Orchestrator output normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("names the agent in lifecycle debug logs", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createSuccessResult()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    await orchestrator.start();

    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "orchestrator:start",
      expect.objectContaining({ agent: "claude" }),
    );
    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "agent:run:start",
      expect.objectContaining({ agent: "claude" }),
    );
  });

  it("handles key_changes_made returned as a JSON string instead of an array", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        async () =>
          ({
            output: {
              success: true,
              summary: "done",
              key_changes_made: '["file.ts", "other.ts"]',
              key_learnings: ["learning"],
            },
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          }) as unknown as AgentResult,
      ),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    await orchestrator.start();

    expect(mockAppendNotes).toHaveBeenCalledTimes(1);
    expect(mockAppendNotes).toHaveBeenCalledWith(
      runInfo.notesPath,
      1,
      "done",
      ["file.ts", "other.ts"],
      ["learning"],
    );
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(mockCommitAll).toHaveBeenCalledWith("gnhf 1: done", "/repo");
    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("uses the configured commit message convention for successful iterations", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => ({
        output: {
          success: true,
          summary: "handle empty output",
          key_changes_made: ["file.ts"],
          key_learnings: [],
          type: "fix",
          scope: "core",
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      })),
    };
    const orchestrator = new Orchestrator(
      { ...config, commitMessage: CONVENTIONAL_COMMIT_MESSAGE },
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    await orchestrator.start();

    expect(mockCommitAll).toHaveBeenCalledWith(
      "fix(core): handle empty output",
      "/repo",
    );
  });

  it("handles key_learnings returned as a JSON string instead of an array", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        async () =>
          ({
            output: {
              success: true,
              summary: "done",
              key_changes_made: ["file.ts"],
              key_learnings: '["first lesson", "second lesson"]',
            },
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          }) as unknown as AgentResult,
      ),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    await orchestrator.start();

    expect(mockAppendNotes).toHaveBeenCalledTimes(1);
    expect(mockAppendNotes).toHaveBeenCalledWith(
      runInfo.notesPath,
      1,
      "done",
      ["file.ts"],
      ["first lesson", "second lesson"],
    );
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("falls back to single-element array when key_changes_made is a non-JSON string", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        async () =>
          ({
            output: {
              success: true,
              summary: "done",
              key_changes_made: "malformed output",
              key_learnings: [],
            },
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          }) as unknown as AgentResult,
      ),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    await orchestrator.start();

    expect(mockAppendNotes).toHaveBeenCalledTimes(1);
    expect(mockAppendNotes).toHaveBeenCalledWith(
      runInfo.notesPath,
      1,
      "done",
      ["malformed output"],
      [],
    );
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().status).toBe("aborted");
  });
});

function createReportedFailureResult(): AgentResult {
  const result = createSuccessResult();
  return { ...result, output: { ...result.output, success: false } };
}

async function runWithFakeTimers(orchestrator: Orchestrator): Promise<void> {
  let done = false;
  const started = orchestrator.start().then(() => {
    done = true;
  });
  while (!done) {
    await vi.advanceTimersByTimeAsync(10 * 60_000);
  }
  await started;
}

describe("Orchestrator stop limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockCommitAll.mockReturnValue(true);
  });

  it("marks the last capped iteration as the final iteration", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createSuccessResult()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    await orchestrator.start();

    const calls = vi.mocked(buildIterationPrompt).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0].finalIteration).toBeUndefined();
    expect(calls[1]![0].finalIteration).toEqual({
      reason: "this is the last iteration allowed by --max-iterations (2)",
      wrapUpOnly: false,
    });
  });

  it("wraps up and stops after three successful iterations without a commit", async () => {
    mockCommitAll.mockReturnValue(false);
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createSuccessResult()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 10 },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(4);
    const calls = vi.mocked(buildIterationPrompt).mock.calls;
    expect(calls[2]![0].finalIteration).toBeUndefined();
    expect(calls[3]![0].finalIteration).toEqual({
      reason: "the last 3 iterations made no progress (no commit)",
      wrapUpOnly: true,
    });
    expect(abort).toHaveBeenCalledWith(
      "no progress in 3 consecutive iterations",
    );
  });

  it("uses maxConsecutiveFailures as the no-progress limit", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createReportedFailureResult()),
    };
    const orchestrator = new Orchestrator(
      { ...config, maxConsecutiveFailures: 5 },
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 10 },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(6);
    expect(
      vi.mocked(buildIterationPrompt).mock.calls[5]![0].finalIteration,
    ).toEqual({
      reason: "the last 5 iterations made no progress (no commit)",
      wrapUpOnly: true,
    });
    expect(abort).toHaveBeenCalledWith(
      "no progress in 5 consecutive iterations",
    );
  });

  it("still aborts on consecutive failures when an agent error breaks the no-progress streak", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        calls++;
        if (calls === 3) throw new Error("transient error");
        return createReportedFailureResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 10 },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await runWithFakeTimers(orchestrator);

    expect(agent.run).toHaveBeenCalledTimes(3);
    expect(
      vi
        .mocked(buildIterationPrompt)
        .mock.calls.map((call) => call[0].finalIteration),
    ).toEqual([undefined, undefined, undefined]);
    expect(abort).toHaveBeenCalledWith("3 consecutive failures");
  });

  it("does not reset the no-progress streak on an agent error", async () => {
    vi.useFakeTimers();
    mockCommitAll.mockReturnValue(false);
    let calls = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        calls++;
        if (calls === 3) throw new Error("transient error");
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 10 },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await runWithFakeTimers(orchestrator);

    expect(agent.run).toHaveBeenCalledTimes(5);
    expect(
      vi.mocked(buildIterationPrompt).mock.calls[4]![0].finalIteration
        ?.wrapUpOnly,
    ).toBe(true);
    expect(abort).toHaveBeenCalledWith(
      "no progress in 3 consecutive iterations",
    );
  });

  it("restarts the no-progress streak after a commit failure", async () => {
    mockCommitAll
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockImplementationOnce(() => {
        throw new CommitFailedError(new Error("hook failed"));
      })
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createSuccessResult()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 5 },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(5);
    expect(
      vi
        .mocked(buildIterationPrompt)
        .mock.calls.map((call) => call[0].finalIteration?.wrapUpOnly),
    ).toEqual([undefined, undefined, undefined, undefined, false]);
    expect(abort).toHaveBeenCalledWith("max iterations reached (5)");
  });

  it("reports the no-progress stop even when the wrap-up iteration errors", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        calls++;
        if (calls === 4) throw new Error("wrap-up crashed");
        return createReportedFailureResult();
      }),
    };
    const orchestrator = new Orchestrator(
      { ...config, maxConsecutiveFailures: 3 },
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 10 },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await runWithFakeTimers(orchestrator);

    expect(agent.run).toHaveBeenCalledTimes(4);
    expect(abort).toHaveBeenCalledWith(
      "no progress in 3 consecutive iterations",
    );
    expect(orchestrator.getState().lastAgentError).toBeNull();
  });

  it("wraps up instead of aborting on three reported failures", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createReportedFailureResult()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 10 },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(4);
    expect(
      vi.mocked(buildIterationPrompt).mock.calls[3]![0].finalIteration,
    ).toEqual({
      reason: "the last 3 iterations made no progress (no commit)",
      wrapUpOnly: true,
    });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(
      "no progress in 3 consecutive iterations",
    );
  });

  it("resets the no-progress streak when an iteration commits", async () => {
    mockCommitAll
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createSuccessResult()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 5 },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(5);
    expect(
      vi
        .mocked(buildIterationPrompt)
        .mock.calls.slice(0, 4)
        .map((call) => call[0].finalIteration),
    ).toEqual([undefined, undefined, undefined, undefined]);
    expect(abort).toHaveBeenCalledWith("max iterations reached (5)");
  });

  it("runs one wrap-up iteration when the deadline has already passed", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createSuccessResult()),
    };
    const until = new Date(Date.now() - 60_000);
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { until },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    const params = vi.mocked(buildIterationPrompt).mock.calls[0]![0];
    expect(params.deadline).toBe(formatDeadline(until));
    expect(params.finalIteration).toEqual({
      reason: `the run deadline (${formatDeadline(until)}) has passed`,
      wrapUpOnly: true,
    });
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(
      `deadline reached (${formatDeadline(until)})`,
    );
  });

  it("stops after the wrap-up iteration even when it fails", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => ({
        ...createSuccessResult(),
        output: { ...createSuccessResult().output, success: false },
      })),
    };
    const until = new Date(Date.now() - 60_000);
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { until },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(
      `deadline reached (${formatDeadline(until)})`,
    );
  });

  it("stops without waiting when the wrap-up iteration is rate-limited", async () => {
    vi.useFakeTimers();
    const until = new Date(Date.now() - 60_000);
    let calls = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        calls++;
        if (calls === 1) {
          throw new RateLimitAgentError(
            "claude usage limit reached",
            "claude exited with code 1: usage limit",
            new Date(Date.now() - 1_000),
          );
        }
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { until, maxRateLimitWaitMs: Infinity },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    const startPromise = orchestrator.start();
    await vi.waitFor(() => expect(abort).toHaveBeenCalled());
    await startPromise;

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(
      `deadline reached (${formatDeadline(until)}) before the usage limit resets`,
    );
  });

  it("stops instead of waiting for a usage reset that lands after the deadline", async () => {
    vi.useFakeTimers();
    const until = new Date(Date.now() + 10 * 60_000);
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        throw new RateLimitAgentError(
          "claude usage limit reached",
          "claude exited with code 1: usage limit",
          new Date(Date.now() + 2 * 60 * 60_000),
        );
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { until },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().waitingUntil).toBeNull();
    expect(abort).toHaveBeenCalledWith(
      `deadline reached (${formatDeadline(until)}) before the usage limit resets`,
    );
  });

  it("waits for a usage reset that lands before the deadline and then wraps up", async () => {
    vi.useFakeTimers();
    const until = new Date(Date.now() + 10 * 60_000);
    let calls = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        calls++;
        if (calls === 1) {
          throw new RateLimitAgentError(
            "claude usage limit reached",
            "claude exited with code 1: usage limit",
            new Date(Date.now() + 60_000),
          );
        }
        if (calls === 2) vi.setSystemTime(until.getTime() + 1);
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { until },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    const startPromise = orchestrator.start();
    await vi.waitFor(() =>
      expect(orchestrator.getState().status).toBe("waiting"),
    );
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await startPromise;

    expect(agent.run).toHaveBeenCalledTimes(3);
    const finals = vi
      .mocked(buildIterationPrompt)
      .mock.calls.map(([params]) => params.finalIteration?.wrapUpOnly);
    expect(finals).toEqual([undefined, undefined, true]);
    expect(abort).toHaveBeenCalledWith(
      `deadline reached (${formatDeadline(until)})`,
    );
  });

  it("wraps up on the next iteration after the deadline passes mid-run", async () => {
    const until = new Date(Date.now() + 60 * 60_000);
    let calls = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        calls++;
        if (calls === 2) vi.setSystemTime(until.getTime() + 1);
        return createSuccessResult();
      }),
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { until, maxIterations: 10 },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();
    vi.useRealTimers();

    expect(agent.run).toHaveBeenCalledTimes(3);
    const finals = vi
      .mocked(buildIterationPrompt)
      .mock.calls.map(([params]) => params.finalIteration?.wrapUpOnly);
    expect(finals).toEqual([undefined, undefined, true]);
    expect(abort).toHaveBeenCalledWith(
      `deadline reached (${formatDeadline(until)})`,
    );
  });

  it("aborts before starting when the max iteration cap is already reached", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      2,
      { maxIterations: 2 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith("max iterations reached (2)");
    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("aborts after completing the configured number of iterations", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createSuccessResult()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith("max iterations reached (1)");
    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("aborts after the iteration when the agent reports should_fully_stop and stopWhen is set", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => ({
        output: {
          success: true,
          summary: "all tasks done",
          key_changes_made: ["file.ts"],
          key_learnings: [],
          should_fully_stop: true,
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      })),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { stopWhen: "all tasks done", maxIterations: 5 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith("stop condition met");
    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("aborts when the agent reports should_fully_stop with success=false and stopWhen is set", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => ({
        output: {
          success: false,
          summary: "nothing left to do",
          key_changes_made: [],
          key_learnings: [],
          should_fully_stop: true,
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      })),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { stopWhen: "all tasks done", maxIterations: 5 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(mockCommitAll).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith("stop condition met");
    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("ignores should_fully_stop when stopWhen is not set", async () => {
    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        callCount++;
        return {
          output: {
            success: true,
            summary: `iter ${callCount}`,
            key_changes_made: [],
            key_learnings: [],
            should_fully_stop: true,
          },
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        };
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(2);
    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("aborts when reported token usage reaches the configured cap", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        (_prompt, _cwd, options) =>
          new Promise<AgentResult>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new Error("Agent was aborted"));
            });
            options?.onUsage?.({
              inputTokens: 7,
              outputTokens: 4,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            });
          }),
      ),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxTokens: 10 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(mockAppendNotes).not.toHaveBeenCalled();
    expect(mockCommitAll).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith("max tokens reached (11/10)");
    expect(orchestrator.getState()).toMatchObject({
      status: "aborted",
      totalInputTokens: 7,
      totalOutputTokens: 4,
    });
  });

  it("does not commit when an agent resolves after triggering the token cap", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn((_prompt, _cwd, options) => {
        options?.onUsage?.({
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheCreationTokens: 0,
        });
        expect(options?.signal?.aborted).toBe(true);
        return Promise.resolve(createSuccessResult("should not commit"));
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxTokens: 15 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(mockAppendNotes).not.toHaveBeenCalled();
    expect(mockCommitAll).not.toHaveBeenCalled();
    expect(mockResetHard).toHaveBeenCalledWith("/repo");
    expect(abort).toHaveBeenCalledWith("max tokens reached (16/15)");
    expect(orchestrator.getState()).toMatchObject({
      status: "aborted",
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalCacheReadTokens: 1,
      totalCacheCreationTokens: 0,
    });
  });

  it("counts cache read and cache creation tokens against the token budget", async () => {
    // #212: an opencode/claude-sonnet run billed ~41M tokens against a 1M cap
    // because cache_read and cache_write carried the traffic and neither was
    // added to the budget. Input+output alone were 22% of the cap while the
    // run had already spent $48.
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        (_prompt, _cwd, options) =>
          new Promise<AgentResult>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new Error("Agent was aborted"));
            });
            options?.onUsage?.({
              inputTokens: 2,
              outputTokens: 3,
              cacheReadTokens: 40,
              cacheCreationTokens: 30,
            });
          }),
      ),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxTokens: 50 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    // 2 + 3 + 40 + 30 = 75, over the cap of 50. Counting only input+output
    // would give 5 and the run would never abort.
    expect(abort).toHaveBeenCalledWith("max tokens reached (75/50)");
    expect(orchestrator.getState()).toMatchObject({
      status: "aborted",
      totalCacheReadTokens: 40,
      totalCacheCreationTokens: 30,
    });
  });

  it("accumulates cache tokens across iterations rather than overwriting them", async () => {
    let call = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, options) => {
        call += 1;
        options?.onUsage?.({
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 10,
          cacheCreationTokens: 5,
        });
        return {
          output: {
            success: true,
            summary: `iteration ${call}`,
            key_changes_made: [],
            key_learnings: [],
          },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 10,
            cacheCreationTokens: 5,
          },
        } satisfies AgentResult;
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(2);
    expect(orchestrator.getState()).toMatchObject({
      totalCacheReadTokens: 20,
      totalCacheCreationTokens: 10,
    });
  });

  it("marks in-flight usage as estimated until authoritative usage arrives", async () => {
    const observedEstimatedStates: boolean[] = [];
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, options) => {
        options?.onUsage?.({
          inputTokens: 4,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimated: true,
        });
        options?.onUsage?.({
          inputTokens: 5,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        });
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );
    orchestrator.on("state", (state) => {
      if (state.totalInputTokens > 0 || state.totalOutputTokens > 0) {
        observedEstimatedStates.push(state.tokensEstimated);
      }
    });

    await orchestrator.start();

    expect(observedEstimatedStates[0]).toBe(true);
    expect(observedEstimatedStates.slice(1)).toEqual([false, false, false]);
    expect(orchestrator.getState().tokensEstimated).toBe(false);
  });

  it("keeps usage estimated when estimated tokens are followed by an agent error", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, options) => {
        callCount++;
        if (callCount === 1) {
          options?.onUsage?.({
            inputTokens: 4,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimated: true,
          });
          throw new Error("transient error");
        }
        options?.onUsage?.({
          inputTokens: 5,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        });
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });

    await startPromise;

    expect(orchestrator.getState()).toMatchObject({
      totalInputTokens: 9,
      totalOutputTokens: 5,
      tokensEstimated: true,
    });
  });

  it("closes the agent when stop is requested", async () => {
    const close = vi.fn();
    const agent: Agent = {
      name: "claude",
      run: vi.fn(),
      close,
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    orchestrator.stop();
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("finishes the active iteration before stopping gracefully", async () => {
    let resolveRun!: (result: AgentResult) => void;
    const close = vi.fn(() => Promise.resolve());
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        () =>
          new Promise<AgentResult>((resolve) => {
            resolveRun = resolve;
          }),
      ),
      close,
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });

    orchestrator.requestGracefulStop();
    resolveRun(createSuccessResult("finished before shutdown"));
    await startPromise;

    expect(mockAppendNotes).toHaveBeenCalledTimes(1);
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(mockResetHard).not.toHaveBeenCalled();
    expect(orchestrator.getState().status).toBe("stopped");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("honors a graceful stop requested before the loop starts", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(),
      close: vi.fn(() => Promise.resolve()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    orchestrator.requestGracefulStop();
    await orchestrator.start();

    expect(agent.run).not.toHaveBeenCalled();
    expect(orchestrator.getState().status).toBe("stopped");
  });

  it("prefers graceful stop over stopWhen after the active iteration finishes", async () => {
    let resolveRun!: (result: AgentResult) => void;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        () =>
          new Promise<AgentResult>((resolve) => {
            resolveRun = resolve;
          }),
      ),
      close: vi.fn(() => Promise.resolve()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { stopWhen: "done" },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });

    orchestrator.requestGracefulStop();
    resolveRun({
      output: {
        success: true,
        summary: "done",
        key_changes_made: ["file.ts"],
        key_learnings: ["learning"],
        should_fully_stop: true,
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    await startPromise;

    expect(abort).not.toHaveBeenCalled();
    expect(orchestrator.getState().status).toBe("stopped");
  });

  it("cuts short backoff when graceful stop is requested", async () => {
    vi.useFakeTimers();

    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        throw new Error("transient error");
      }),
      close: vi.fn(() => Promise.resolve()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(orchestrator.getState().status).toBe("waiting");
    });

    orchestrator.requestGracefulStop();
    await vi.runAllTimersAsync();
    await startPromise;

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().status).toBe("stopped");
  });

  it("emits stopped only after agent cleanup completes", async () => {
    let resolveClose!: () => void;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );
    const agent: Agent = {
      name: "claude",
      run: vi.fn(),
      close,
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const stopped = vi.fn();
    orchestrator.on("stopped", stopped);

    orchestrator.stop();
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    expect(stopped).not.toHaveBeenCalled();

    resolveClose();
    await Promise.resolve();
    await Promise.resolve();

    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it("does not re-emit stopped when stop is called after the loop is done", async () => {
    let resolveRun!: (result: AgentResult) => void;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        () =>
          new Promise<AgentResult>((resolve) => {
            resolveRun = resolve;
          }),
      ),
      close: vi.fn(() => Promise.resolve()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const stopped = vi.fn();
    orchestrator.on("stopped", stopped);

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });

    orchestrator.requestGracefulStop();
    resolveRun(createSuccessResult("finished before shutdown"));
    await startPromise;

    expect(stopped).toHaveBeenCalledTimes(1);

    orchestrator.stop();
    orchestrator.stop();

    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it("waits for the active iteration to unwind before closing the agent", async () => {
    let rejectRun!: (error: Error) => void;
    const close = vi.fn(() => Promise.resolve());
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        (_prompt, _cwd, options) =>
          new Promise<AgentResult>((_resolve, reject) => {
            rejectRun = reject;
            options?.signal?.addEventListener("abort", () => {
              queueMicrotask(() => {
                reject(new Error("Agent was aborted"));
              });
            });
          }),
      ),
      close,
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });

    orchestrator.stop();

    expect(close).not.toHaveBeenCalled();

    rejectRun(new Error("Agent was aborted"));
    await startPromise;

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("starts agent cleanup if a stopped iteration remains stuck after a grace period", async () => {
    vi.useFakeTimers();

    let rejectRun!: (error: Error) => void;
    const close = vi.fn(() => {
      rejectRun(new Error("Agent was aborted"));
      return Promise.resolve();
    });
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        (_prompt, _cwd, options) =>
          new Promise<AgentResult>((_resolve, reject) => {
            rejectRun = reject;
            options?.signal?.addEventListener("abort", () => {
              // Simulate an agent that stays hung until close() tears down
              // its backing process.
            });
          }),
      ),
      close,
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });

    orchestrator.stop();

    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);

    expect(close).toHaveBeenCalledTimes(1);

    await startPromise;
  });

  it("does not record or commit a late successful result after stop is requested", async () => {
    vi.useFakeTimers();

    let resolveRun!: (result: AgentResult) => void;
    const close = vi.fn(() => Promise.resolve());
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        (_prompt, _cwd, options) =>
          new Promise<AgentResult>((resolve) => {
            resolveRun = resolve;
            options?.signal?.addEventListener("abort", () => {
              setTimeout(() => {
                resolve(createSuccessResult("late success"));
              }, 10);
            });
          }),
      ),
      close,
    };
    const orchestrator = new Orchestrator(
      { ...config, preventSleep: false },
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });

    orchestrator.stop();
    await vi.advanceTimersByTimeAsync(10);
    await startPromise;

    expect(resolveRun).toBeTypeOf("function");
    expect(mockAppendNotes).not.toHaveBeenCalled();
    expect(mockCommitAll).not.toHaveBeenCalled();
    expect(orchestrator.getState().iterations).toEqual([]);
    expect(orchestrator.getState().status).toBe("stopped");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("clears pending commit failure state after force-stop reset", async () => {
    vi.useFakeTimers();

    let rejectRepair!: (error: Error) => void;
    const agent: Agent = {
      name: "claude",
      run: vi
        .fn()
        .mockResolvedValueOnce(createSuccessResult("needs hook repair"))
        .mockImplementationOnce(
          (_prompt, _cwd, options) =>
            new Promise<AgentResult>((_resolve, reject) => {
              rejectRepair = reject;
              options?.signal?.addEventListener("abort", () => {
                reject(new Error("Agent was aborted"));
              });
            }),
        ),
      close: vi.fn(() => Promise.resolve()),
    };
    mockCommitAll.mockImplementationOnce(() => {
      throw new CommitFailedError(new Error("hook failed"));
    });

    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );
    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });
    expect(orchestrator.getState().hasPendingCommitFailure).toBe(true);

    orchestrator.stop();
    await vi.runAllTimersAsync();
    rejectRepair(new Error("Agent was aborted"));
    await startPromise;

    expect(mockResetHard).toHaveBeenCalled();
    expect(orchestrator.getState().hasPendingCommitFailure).toBe(false);
  });

  it("preserves pending commit failure state when a repair iteration errors", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi
        .fn()
        .mockResolvedValueOnce(createSuccessResult("needs hook repair"))
        .mockRejectedValueOnce(new Error("network down")),
    };
    mockCommitAll.mockImplementationOnce(() => {
      throw new CommitFailedError(new Error("hook failed"));
    });

    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    await orchestrator.start();

    expect(mockResetHard).not.toHaveBeenCalled();
    expect(orchestrator.getState().hasPendingCommitFailure).toBe(true);
  });

  it("preserves pending commit failure changes when repair hits token limit", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi
        .fn()
        .mockResolvedValueOnce(createSuccessResult("needs hook repair"))
        .mockImplementationOnce(
          (_prompt, _cwd, options) =>
            new Promise<AgentResult>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => {
                reject(new Error("Agent was aborted"));
              });
              options?.onUsage?.({
                inputTokens: 11,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              });
            }),
        ),
    };
    mockCommitAll.mockImplementationOnce(() => {
      throw new CommitFailedError(new Error("hook failed"));
    });

    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxTokens: 10 },
    );

    await orchestrator.start();

    expect(mockResetHard).not.toHaveBeenCalled();
    expect(orchestrator.getState()).toMatchObject({
      status: "aborted",
      hasPendingCommitFailure: true,
    });
  });

  it("preserves pending commit failure changes when repair hits permanent agent error", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi
        .fn()
        .mockResolvedValueOnce(createSuccessResult("needs hook repair"))
        .mockRejectedValueOnce(
          new PermanentAgentError(
            "claude credit balance too low - see gnhf.log",
            "claude exited with code 1: Credit balance is too low",
          ),
        ),
    };
    mockCommitAll.mockImplementationOnce(() => {
      throw new CommitFailedError(new Error("hook failed"));
    });

    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    await orchestrator.start();

    expect(mockResetHard).not.toHaveBeenCalled();
    expect(orchestrator.getState()).toMatchObject({
      status: "aborted",
      hasPendingCommitFailure: true,
      lastAgentError: "claude exited with code 1: Credit balance is too low",
    });
  });
});

describe("Orchestrator backoff behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not back off after an explicit agent failure (success=false)", async () => {
    vi.useFakeTimers();

    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => ({
        output: {
          success: false,
          summary: "tried and failed",
          key_changes_made: [],
          key_learnings: [],
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      })),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });

    // Without advancing any timers, iteration 2 must start.
    // If backoff were (incorrectly) triggered, a 60s timer would block us
    // and waitFor would time out.
    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });

    await startPromise;

    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("backs off after an error failure (agent threw)", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("transient error");
        }
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });

    // After the error, a backoff timer should be scheduled.
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });
    expect(orchestrator.getState().lastAgentError).toBe("transient error");
    // And iteration 2 must not have started yet.
    expect(agent.run).toHaveBeenCalledTimes(1);

    // Advance past the 60s first-failure backoff.
    await vi.advanceTimersByTimeAsync(60_000);

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });

    await startPromise;
  });

  it("waits until the rate limit resets and retries the same iteration without counting a failure", async () => {
    vi.useFakeTimers();

    const resumeAt = new Date(Date.now() + 10 * 60_000);
    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new RateLimitAgentError(
            "claude usage limit reached",
            "claude exited with code 1: usage limit",
            resumeAt,
          );
        }
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(orchestrator.getState().status).toBe("waiting");
    });

    // The rate-limited attempt is rolled back but not recorded as a failure.
    expect(mockResetHard).toHaveBeenCalledTimes(1);
    expect(mockAppendNotes).not.toHaveBeenCalled();
    expect(orchestrator.getState()).toMatchObject({
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      currentIteration: 0,
      completedIterations: 0,
    });
    // Wakes shortly after the provider-reported reset time, not before.
    const waitingUntil = orchestrator.getState().waitingUntil;
    expect(waitingUntil).toEqual(new Date(resumeAt.getTime() + 60_000));

    await vi.advanceTimersByTimeAsync(11 * 60_000);

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });
    await startPromise;

    // The retry reused iteration 1, so maxIterations: 1 still permitted it.
    expect(orchestrator.getState()).toMatchObject({
      successCount: 1,
      failCount: 0,
      currentIteration: 1,
      completedIterations: 1,
      maxIterations: 1,
    });
  });

  it("starts from the success and failure counts of earlier runs", () => {
    const agent: Agent = { name: "claude", run: vi.fn() };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      5,
      { completedIterations: 5, successCount: 3, failCount: 2 },
    );

    expect(orchestrator.getState()).toMatchObject({
      currentIteration: 5,
      completedIterations: 5,
      successCount: 3,
      failCount: 2,
    });
  });

  it("counts an iteration only after it finishes and keeps the cap", async () => {
    let resolveRun: ((value: AgentResult) => void) | undefined;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        () =>
          new Promise<AgentResult>((resolve) => {
            resolveRun = resolve;
          }),
      ),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      2,
      { maxIterations: 3 },
    );

    expect(orchestrator.getState()).toMatchObject({
      completedIterations: 0,
      maxIterations: 3,
      currentIteration: 2,
    });

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });
    expect(orchestrator.getState()).toMatchObject({
      completedIterations: 0,
      currentIteration: 3,
      maxIterations: 3,
    });

    resolveRun!(createSuccessResult());
    await startPromise;

    expect(orchestrator.getState()).toMatchObject({
      completedIterations: 1,
      currentIteration: 3,
      maxIterations: 3,
    });
  });

  it("does not count an unfinished resumed attempt as complete", async () => {
    let resolveRun: ((value: AgentResult) => void) | undefined;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        () =>
          new Promise<AgentResult>((resolve) => {
            resolveRun = resolve;
          }),
      ),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      2,
      { maxIterations: 3, completedIterations: 1 },
    );

    expect(orchestrator.getState()).toMatchObject({
      completedIterations: 1,
      currentIteration: 2,
      maxIterations: 3,
    });

    const startPromise = orchestrator.start();
    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });
    expect(orchestrator.getState()).toMatchObject({
      completedIterations: 1,
      currentIteration: 3,
      maxIterations: 3,
    });

    resolveRun!(createSuccessResult());
    await startPromise;

    expect(orchestrator.getState()).toMatchObject({
      completedIterations: 2,
      currentIteration: 3,
      maxIterations: 3,
    });
  });

  it("uses the configured fallback model once before returning to the rate-limit wait", async () => {
    vi.useFakeTimers();

    const resumeAt = new Date(Date.now() + 10 * 60_000);
    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        callCount++;
        if (callCount < 3) {
          throw new RateLimitAgentError(
            "claude usage limit reached",
            "claude exited with code 1: usage limit",
            resumeAt,
          );
        }
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { fallbackModel: "claude-haiku", maxIterations: 1 },
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });
    expect(agent.run).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      "/repo",
      expect.objectContaining({ model: "claude-haiku" }),
    );
    await vi.waitFor(() => {
      expect(orchestrator.getState().status).toBe("waiting");
    });

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await startPromise;

    expect(agent.run).toHaveBeenCalledTimes(3);
    expect(agent.run).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      "/repo",
      expect.not.objectContaining({ model: expect.anything() }),
    );
    expect(orchestrator.getState()).toMatchObject({
      successCount: 1,
      failCount: 0,
      currentIteration: 1,
    });
  });

  it("aborts when the total configured rate-limit wait would be exceeded", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        callCount++;
        if (callCount <= 2) {
          throw new RateLimitAgentError(
            "claude usage limit reached",
            "detail",
            new Date(Date.now() + 60_000),
          );
        }
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1, maxRateLimitWaitMs: 3 * 60_000 },
    );
    const abort = vi.fn();
    orchestrator.on("abort", abort);

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(orchestrator.getState().status).toBe("waiting");
    });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });

    // Let the pre-change implementation finish its unbounded second wait so
    // this test fails on the assertion below instead of hanging.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await startPromise;

    expect(agent.run).toHaveBeenCalledTimes(2);
    expect(orchestrator.getState().status).toBe("aborted");
    expect(abort).toHaveBeenCalledWith(
      expect.stringContaining("maximum rate-limit wait"),
    );
    // On a rejection the standing agent error is the provider's own account of
    // the wait - which limit, and until when - so the leash abort must leave it
    // for cli.ts to report as the reason the run ended.
    const finalState = orchestrator.getState();
    expect(finalState.lastAgentError ?? finalState.lastMessage).toContain(
      "claude usage limit reached",
    );
  });

  it("honors a graceful stop requested mid-iteration instead of entering the rate-limit wait", async () => {
    vi.useFakeTimers();

    let rejectRun!: (error: Error) => void;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        () =>
          new Promise<AgentResult>((_resolve, reject) => {
            rejectRun = reject;
          }),
      ),
      close: vi.fn(() => Promise.resolve()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });

    orchestrator.requestGracefulStop();
    rejectRun(
      new RateLimitAgentError(
        "claude usage limit reached",
        "detail",
        new Date(Date.now() + 60 * 60_000),
      ),
    );
    await startPromise;

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().status).toBe("stopped");
  });

  it("caps the wait for a far-future rate limit reset so the timer cannot overflow", async () => {
    vi.useFakeTimers();

    const resumeAt = new Date(Date.now() + 40 * 24 * 60 * 60_000);
    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new RateLimitAgentError(
            "claude usage limit reached",
            "detail",
            resumeAt,
          );
        }
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(orchestrator.getState().status).toBe("waiting");
    });

    const waitingUntil = orchestrator.getState().waitingUntil;
    expect(waitingUntil!.getTime() - Date.now()).toBeLessThanOrEqual(
      24 * 60 * 60_000,
    );

    // An overflowed setTimeout fires after ~1 ms; a capped wait must hold.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(agent.run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });
    await startPromise;

    expect(orchestrator.getState()).toMatchObject({
      successCount: 1,
      failCount: 0,
    });
  });

  it("uses a bounded fallback wait when the rate limit reset time is missing", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new RateLimitAgentError(
            "claude usage limit reached",
            "detail",
            null,
          );
        }
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(orchestrator.getState().status).toBe("waiting");
    });
    expect(agent.run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });
    await startPromise;

    expect(orchestrator.getState()).toMatchObject({
      successCount: 1,
      failCount: 0,
    });
  });

  it("waits for the window to reset after an iteration billed to extra usage", async () => {
    vi.useFakeTimers();

    const resumeAt = new Date(Date.now() + 10 * 60_000);
    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, options) => {
        callCount++;
        if (callCount === 1) {
          options?.onOverage?.({ resumeAt });
        }
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(orchestrator.getState().status).toBe("waiting");
    });

    // Unlike a rejection the request was served, so the iteration's work is
    // real: it is kept, counted, and never rolled back.
    expect(mockResetHard).not.toHaveBeenCalled();
    expect(orchestrator.getState()).toMatchObject({
      successCount: 1,
      failCount: 0,
      currentIteration: 1,
    });
    expect(orchestrator.getState().waitingUntil).toEqual(
      new Date(resumeAt.getTime() + 60_000),
    );
    // The pause must explain itself, otherwise it is indistinguishable from
    // an error backoff in the TUI.
    expect(orchestrator.getState().lastAgentError).toBe(
      `extra usage engaged - waiting for the usage window to reset at ${resumeAt.toISOString()}`,
    );

    await vi.advanceTimersByTimeAsync(11 * 60_000);

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });
    await startPromise;

    expect(orchestrator.getState()).toMatchObject({
      successCount: 2,
      currentIteration: 2,
    });
    expect(orchestrator.getState().lastAgentError).toBeNull();
  });

  it("honors the configured rate-limit leash for extra-usage waits", async () => {
    vi.useFakeTimers();

    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, options) => {
        options?.onOverage?.({ resumeAt: new Date(Date.now() + 10 * 60_000) });
        // The billed iteration also errored, so lastAgentError is set when the
        // leash trips.
        throw new Error("claude returned no structured_output");
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxRateLimitWaitMs: 0 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(
      expect.stringContaining("maximum rate-limit wait"),
    );
    // cli.ts reports `lastAgentError ?? lastMessage` as the reason the run
    // ended, so a transient wait notice must never shadow the leash abort.
    const finalState = orchestrator.getState();
    expect(finalState.lastAgentError ?? finalState.lastMessage).toContain(
      "maximum rate-limit wait exceeded",
    );
  });

  it("keeps the extra-usage wait reason out of the reason the run ended", async () => {
    vi.useFakeTimers();

    const firstResumeAt = new Date(Date.now() + 10 * 60_000);
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, options) => {
        options?.onOverage?.({ resumeAt: new Date(Date.now() + 10 * 60_000) });
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxRateLimitWaitMs: 15 * 60_000 },
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(orchestrator.getState().status).toBe("waiting");
    });
    expect(orchestrator.getState().lastAgentError).toBe(
      `extra usage engaged - waiting for the usage window to reset at ${firstResumeAt.toISOString()}`,
    );

    // Resume, then let the second pause overrun the leash.
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await vi.waitFor(() => {
      expect(orchestrator.getState().status).toBe("aborted");
    });
    await startPromise;

    const finalState = orchestrator.getState();
    expect(finalState.lastAgentError ?? finalState.lastMessage).toContain(
      "maximum rate-limit wait exceeded",
    );
  });

  it("drops the extra-usage wait reason when the pause is interrupted", async () => {
    vi.useFakeTimers();

    const resumeAt = new Date(Date.now() + 10 * 60_000);
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, options) => {
        options?.onOverage?.({ resumeAt });
        return createSuccessResult();
      }),
      close: vi.fn(() => Promise.resolve()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(orchestrator.getState().status).toBe("waiting");
    });
    expect(orchestrator.getState().lastAgentError).toBe(
      `extra usage engaged - waiting for the usage window to reset at ${resumeAt.toISOString()}`,
    );

    orchestrator.requestGracefulStop();
    await startPromise;

    expect(orchestrator.getState().status).toBe("stopped");
    // The pause is over, so its notice must not be left behind as the reason
    // the run ended.
    expect(orchestrator.getState().lastAgentError).toBeNull();
  });

  it("continues immediately when the extra-usage reset time has already elapsed", async () => {
    vi.useFakeTimers();

    // An elapsed reset instant is the provider saying the included window is
    // already back, so the next iteration is free: continue without pausing
    // and without ending the run.
    const resumeAt = new Date(Date.now() - 60_000);
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, options) => {
        options?.onOverage?.({ resumeAt });
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    // No timer advancing: a pause here would leave this promise unresolved.
    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(2);
    expect(abort).not.toHaveBeenCalledWith(
      expect.stringContaining("extra usage"),
    );
    expect(orchestrator.getState()).toMatchObject({
      successCount: 2,
      currentIteration: 2,
    });
  });

  it("continues when the window returned while the billed iteration was still running", async () => {
    vi.useFakeTimers();

    // The realistic shape: the window flips to overage five minutes before it
    // resets, and the iteration then runs for another twenty. By the time the
    // orchestrator sees the signal the window is long back.
    const resumeAt = new Date(Date.now() + 5 * 60_000);
    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, options) => {
        callCount++;
        if (callCount === 1) {
          options?.onOverage?.({ resumeAt });
          vi.setSystemTime(resumeAt.getTime() + 20 * 60_000);
        }
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(2);
    expect(abort).not.toHaveBeenCalledWith(
      expect.stringContaining("extra usage"),
    );
    expect(orchestrator.getState()).toMatchObject({
      successCount: 2,
      currentIteration: 2,
    });
  });

  it("aborts instead of resuming into a billed iteration when the extra-usage reset is beyond the wait cap", async () => {
    vi.useFakeTimers();

    // Further out than a single sleep can cover (a weekly rather than
    // five-hour limit). Capping the wait would end it before the window
    // returns, so resuming on it buys another billed iteration.
    const resumeAt = new Date(Date.now() + 25 * 60 * 60_000);
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, options) => {
        options?.onOverage?.({ resumeAt });
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 3 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    const startPromise = orchestrator.start();
    await vi.advanceTimersByTimeAsync(26 * 60 * 60_000);
    await startPromise;

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(
      expect.stringContaining("further out than a single wait can cover"),
    );
  });

  it("still waits out a rejection whose reset time is beyond the wait cap", async () => {
    vi.useFakeTimers();

    // The same reset time on the rejection path costs nothing to probe: the
    // capped wait is spent and the retry re-reads the reset time, so it must
    // not abort and must not drop to the escalating fallback.
    const resumeAt = new Date(Date.now() + 25 * 60 * 60_000);
    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new RateLimitAgentError(
            "claude usage limit reached",
            "detail",
            resumeAt,
          );
        }
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(orchestrator.getState().status).toBe("waiting");
    });
    // Capped at 24h: neither the escalating fallback nor the full 25h.
    const waitingUntil = orchestrator.getState().waitingUntil;
    expect(waitingUntil?.getTime()).toBeGreaterThan(
      Date.now() + 23 * 60 * 60_000,
    );
    expect(waitingUntil?.getTime()).toBeLessThan(resumeAt.getTime());

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });
    await startPromise;

    expect(abort).not.toHaveBeenCalledWith(
      expect.stringContaining("rate-limit wait"),
    );
  });

  it("waits when the extra-usage reset time is still ahead, however close", async () => {
    vi.useFakeTimers();

    const resumeAt = new Date(Date.now() + 1_000);
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, options) => {
        options?.onOverage?.({ resumeAt });
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    const startPromise = orchestrator.start();

    // A reset time in the future is usable no matter how soon it lands; only
    // one already behind us leaves nothing to wait for.
    await vi.waitFor(() => {
      expect(orchestrator.getState().status).toBe("waiting");
    });
    expect(abort).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await startPromise;

    expect(agent.run).toHaveBeenCalledTimes(2);
  });

  it("waits for the window to reset when an errored iteration was billed to extra usage", async () => {
    vi.useFakeTimers();

    // Deliberately shorter than the 60s first-error backoff: the window is
    // decided against the moment the provider reported it, so a pause of
    // gnhf's own can never consume a reset time that was usable when it
    // arrived and abort a run whose window has genuinely returned.
    const resumeAt = new Date(Date.now() + 40_000);
    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, options) => {
        callCount++;
        if (callCount === 1) {
          options?.onOverage?.({ resumeAt });
          throw new Error("claude returned no structured_output");
        }
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    const startPromise = orchestrator.start();

    // The window is spent, so the reset wait comes first and names itself.
    await vi.waitFor(() => {
      expect(orchestrator.getState().status).toBe("waiting");
    });
    expect(orchestrator.getState().waitingUntil).toEqual(
      new Date(resumeAt.getTime() + 60_000),
    );
    expect(orchestrator.getState().lastAgentError).toBe(
      `extra usage engaged - waiting for the usage window to reset at ${resumeAt.toISOString()}`,
    );

    await vi.advanceTimersByTimeAsync(100_000);

    // Then the ordinary error backoff, which reports the error again rather
    // than the pause that just ended.
    await vi.waitFor(() => {
      expect(orchestrator.getState().lastAgentError).toBe(
        "claude returned no structured_output",
      );
    });
    expect(agent.run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });
    await startPromise;

    expect(abort).not.toHaveBeenCalledWith(
      expect.stringContaining("extra usage"),
    );
    expect(orchestrator.getState()).toMatchObject({
      successCount: 1,
      failCount: 1,
      currentIteration: 2,
    });
  });

  it("aborts instead of buying more when extra usage reports no reset time", async () => {
    vi.useFakeTimers();

    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, options) => {
        options?.onOverage?.({ resumeAt: null });
        // The billed iteration also errored, so lastAgentError is set when the
        // overage abort happens.
        throw new Error("claude returned no structured_output");
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    // Escalating backoff would re-enter overage on every probe, so a flag
    // whose whole purpose is "stop spending" fails closed.
    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(
      expect.stringContaining("no reset time"),
    );
    // cli.ts reports `lastAgentError ?? lastMessage` in the permanent stdout
    // summary, so the agent's own error must not displace the reason gnhf
    // stopped to protect the user's credits.
    const finalState = orchestrator.getState();
    expect(finalState.lastAgentError ?? finalState.lastMessage).toContain(
      "no reset time was reported",
    );
  });

  it("aborts immediately for permanent agent errors without backoff", async () => {
    vi.useFakeTimers();

    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        throw new PermanentAgentError(
          "claude credit balance too low - see gnhf.log",
          "claude exited with code 1: Credit balance is too low",
        );
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(mockAppendNotes).not.toHaveBeenCalled();
    expect(mockResetHard).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(
      "claude credit balance too low - see gnhf.log",
    );
    expect(orchestrator.getState()).toMatchObject({
      status: "aborted",
      consecutiveErrors: 0,
      lastMessage: "claude credit balance too low - see gnhf.log",
      lastAgentError: "claude exited with code 1: Credit balance is too low",
    });
  });

  it("resets the error streak after a reported failure so a later error backs off from 60s again", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("early error");
        if (callCount === 2)
          return {
            output: {
              success: false,
              summary: "tried and failed",
              key_changes_made: [],
              key_learnings: [],
            },
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          };
        if (callCount === 3) throw new Error("later error");
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      { ...config, maxConsecutiveFailures: 10 },
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 4 },
    );

    const startPromise = orchestrator.start();

    // Iteration 1: error -> backoff 60s
    await vi.waitFor(() => expect(agent.run).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);

    // Iteration 2 (reported failure) has no backoff so iteration 3 (error)
    // follows immediately; waiting for the third call verifies the no-backoff
    // path between 2 and 3.
    await vi.waitFor(() => expect(agent.run).toHaveBeenCalledTimes(3));

    // Wait for iteration 3's backoff to be scheduled before advancing time.
    await vi.waitFor(() =>
      expect(orchestrator.getState().status).toBe("waiting"),
    );

    // Iteration 3's error backoff should be 60s again (streak reset), not
    // 120s. Advancing exactly 60s must be enough to unblock iteration 4.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(agent.run).toHaveBeenCalledTimes(4));

    await startPromise;
  });
});

describe("Orchestrator crash resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    mockResetHard.mockImplementation(() => {});
    mockAppendNotes.mockImplementation(() => {});
  });

  it("rethrows when git reset fails during failure recording", async () => {
    mockResetHard.mockImplementation(() => {
      throw new Error("not a git repository");
    });

    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => ({
        output: {
          success: false,
          summary: "iteration failed",
          key_changes_made: [],
          key_learnings: [],
        },
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      })),
    };

    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await expect(orchestrator.start()).rejects.toThrow("not a git repository");

    expect(orchestrator.getState().status).not.toBe("aborted");
    expect(abort).not.toHaveBeenCalled();
  });

  it("rethrows success recording failures without resetting the worktree", async () => {
    mockAppendNotes.mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createSuccessResult()),
    };

    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await expect(orchestrator.start()).rejects.toThrow(
      "ENOSPC: no space left on device",
    );

    expect(mockResetHard).not.toHaveBeenCalled();
    expect(orchestrator.getState().status).not.toBe("aborted");
    expect(abort).not.toHaveBeenCalled();
  });

  it("rethrows observer errors without resetting the worktree", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createSuccessResult()),
    };

    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    orchestrator.on("iteration:end", () => {
      throw new Error("listener failed");
    });

    await expect(orchestrator.start()).rejects.toThrow("listener failed");

    expect(mockAppendNotes).toHaveBeenCalledTimes(1);
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(mockResetHard).not.toHaveBeenCalled();
  });

  it("pushes the current branch after each successful commit when requested", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createSuccessResult()),
    };

    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1, push: true },
    );

    await orchestrator.start();

    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(mockPushCurrentBranch).toHaveBeenCalledWith("/repo");
    expect(mockResetHard).not.toHaveBeenCalled();
  });

  it("aborts without resetting when pushing a successful commit fails", async () => {
    mockPushCurrentBranch.mockImplementation(() => {
      throw new Error("remote rejected push");
    });
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createSuccessResult()),
    };

    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2, push: true },
    );
    const abort = vi.fn();
    const iterationEnd = vi.fn();
    orchestrator.on("abort", abort);
    orchestrator.on("iteration:end", iterationEnd);

    await orchestrator.start();

    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(mockPushCurrentBranch).toHaveBeenCalledWith("/repo");
    expect(mockResetHard).not.toHaveBeenCalled();
    expect(iterationEnd).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith("push failed: remote rejected push");
    expect(orchestrator.getState().status).toBe("aborted");
  });
});

describe("Orchestrator research workflow", () => {
  const researchRunInfo: RunInfo = { ...runInfo, workflow: "research" };
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockCommitAll.mockReturnValue(true);
  });

  function researchAgent(success: boolean): Agent {
    return {
      name: "claude",
      run: vi.fn(async () => ({
        output: {
          success,
          summary: "studied cache",
          key_changes_made: ["ledger.md"],
          key_learnings: ["cold start dominates"],
          evidence_origin: "executed" as const,
          goals_changed: ["G1", "G2"],
          contracts_run: ["N5-1"],
          boundary: "does not cover warm starts",
        },
        usage,
      })),
    };
  }

  it("passes the research workflow to the iteration prompt", async () => {
    const orchestrator = new Orchestrator(
      config,
      researchAgent(true),
      researchRunInfo,
      "study it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    await orchestrator.start();

    expect(vi.mocked(buildIterationPrompt).mock.calls[0]![0].workflow).toBe(
      "research",
    );
  });

  it("passes the default workflow to the iteration prompt", async () => {
    const orchestrator = new Orchestrator(
      config,
      researchAgent(true),
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    await orchestrator.start();

    expect(vi.mocked(buildIterationPrompt).mock.calls[0]![0].workflow).toBe(
      "default",
    );
  });

  it("records research evidence in notes and the iteration end log", async () => {
    const orchestrator = new Orchestrator(
      config,
      researchAgent(true),
      researchRunInfo,
      "study it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    await orchestrator.start();

    const evidence = {
      evidenceOrigin: "executed",
      goalsChanged: ["G1", "G2"],
      contractsRun: ["N5-1"],
      boundary: "does not cover warm starts",
    };
    expect(mockAppendNotes).toHaveBeenCalledWith(
      researchRunInfo.notesPath,
      1,
      "studied cache",
      ["ledger.md"],
      ["cold start dominates"],
      evidence,
    );
    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "iteration:end",
      expect.objectContaining(evidence),
    );
  });

  it("records research evidence for a reported failure", async () => {
    const orchestrator = new Orchestrator(
      config,
      researchAgent(false),
      researchRunInfo,
      "study it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    await orchestrator.start();

    expect(mockAppendNotes).toHaveBeenCalledWith(
      researchRunInfo.notesPath,
      1,
      "[FAIL] studied cache",
      [],
      ["cold start dominates"],
      expect.objectContaining({ evidenceOrigin: "executed" }),
    );
  });

  it("coerces malformed research fields instead of failing after the commit", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        async () =>
          ({
            output: {
              success: true,
              summary: "studied cache",
              key_changes_made: ["ledger.md"],
              key_learnings: [],
              evidence_origin: 5,
              goals_changed: "G3",
              contracts_run: null,
              boundary: null,
            },
            usage,
          }) as unknown as AgentResult,
      ),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      researchRunInfo,
      "study it",
      "/repo",
      0,
      { maxIterations: 1 },
    );
    const iterationEnd = vi.fn();
    orchestrator.on("iteration:end", iterationEnd);

    await orchestrator.start();

    expect(mockAppendNotes).toHaveBeenCalledWith(
      researchRunInfo.notesPath,
      1,
      "studied cache",
      ["ledger.md"],
      [],
      {
        evidenceOrigin: "none",
        goalsChanged: ["G3"],
        contractsRun: [],
        boundary: "",
      },
    );
    expect(iterationEnd.mock.calls[0]![0].success).toBe(true);
  });

  it("keeps default-mode notes and iteration end log free of evidence", async () => {
    const orchestrator = new Orchestrator(
      config,
      researchAgent(true),
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    await orchestrator.start();

    expect(mockAppendNotes.mock.calls[0]).toHaveLength(5);
    const endCall = mockAppendDebugLog.mock.calls.find(
      ([event]) => event === "iteration:end",
    );
    expect(endCall![1]).not.toHaveProperty("evidenceOrigin");
  });
});

describe("Orchestrator research ledger", () => {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  const r1 = `${JSON.stringify({ id: "r1", iteration: 1, evidence_origin: "executed", claim: "cache halves cold start" })}\n`;
  const r1Rewritten = `${JSON.stringify({ id: "r1", iteration: 1, evidence_origin: "executed", claim: "rewritten" })}\n`;
  const r2 = `${JSON.stringify({ id: "r2", iteration: 2, evidence_origin: "source_read", claim: "paper agrees" })}\n`;
  let dir: string;
  let ledgerInfo: RunInfo;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockCommitAll.mockReturnValue(true);
    dir = mkdtempSync(join(tmpdir(), "gnhf-ledger-"));
    const runDir = join(dir, ".gnhf", "runs", "run-abc");
    mkdirSync(join(runDir, "ledger"), { recursive: true });
    ledgerInfo = {
      ...runInfo,
      runDir,
      workflow: "research",
      ledgerPath: join(runDir, "ledger", "records.jsonl"),
    };
    writeFileSync(ledgerInfo.ledgerPath!, r1, "utf-8");
  });

  afterEach(() => {
    mockResetHard.mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  function ledgerAgent(
    steps: Array<{
      ledger: (current: string) => string;
      success?: boolean;
      stop?: boolean;
    }>,
  ): Agent {
    let call = 0;
    return {
      name: "claude",
      run: vi.fn(async () => {
        const step = steps[Math.min(call, steps.length - 1)]!;
        call++;
        const path = ledgerInfo.ledgerPath!;
        writeFileSync(path, step.ledger(readFileSync(path, "utf-8")), "utf-8");
        return {
          output: {
            success: step.success ?? true,
            summary: "studied cache",
            key_changes_made: ["ledger"],
            key_learnings: ["learning"],
            evidence_origin: "executed" as const,
            goals_changed: [],
            contracts_run: [],
            boundary: "b",
            ...(step.stop === undefined
              ? {}
              : { should_fully_stop: step.stop }),
          },
          usage,
        };
      }),
    };
  }

  const validatedPath = () =>
    join(ledgerInfo.runDir, "ledger", "validated.jsonl");

  function orchestratorFor(agent: Agent, maxIterations: number): Orchestrator {
    return new Orchestrator(config, agent, ledgerInfo, "study it", dir, 0, {
      maxIterations,
    });
  }

  it("passes the ledger path to the iteration prompt", async () => {
    await orchestratorFor(ledgerAgent([{ ledger: (c) => c }]), 1).start();

    expect(vi.mocked(buildIterationPrompt)).toHaveBeenCalledWith(
      expect.objectContaining({ ledgerPath: ledgerInfo.ledgerPath }),
    );
  });

  it("commits an iteration that appends valid records", async () => {
    const orchestrator = orchestratorFor(
      ledgerAgent([{ ledger: (c) => c + r2 }]),
      1,
    );

    await orchestrator.start();

    expect(orchestrator.getState().iterations[0]!.success).toBe(true);
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(readFileSync(ledgerInfo.ledgerPath!, "utf-8")).toBe(r1 + r2);
    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "ledger:valid",
      expect.objectContaining({ iteration: 1, records: 2 }),
    );
  });

  it("fails an iteration that rewrites an earlier line and restores the ledger", async () => {
    const orchestrator = orchestratorFor(
      ledgerAgent([{ ledger: () => r1Rewritten + r2 }]),
      1,
    );

    await orchestrator.start();

    const record = orchestrator.getState().iterations[0]!;
    expect(record.success).toBe(false);
    expect(record.summary).toBe(
      "ledger validation failed: line 1 changed (id r1)",
    );
    expect(mockCommitAll).not.toHaveBeenCalled();
    expect(mockResetHard).toHaveBeenCalledTimes(1);
    expect(readFileSync(ledgerInfo.ledgerPath!, "utf-8")).toBe(r1);
    const rejectedPath = join(
      ledgerInfo.runDir,
      "ledger",
      "rejected-iteration-1.jsonl",
    );
    expect(readFileSync(rejectedPath, "utf-8")).toBe(r1Rewritten + r2);
    expect(mockAppendNotes).toHaveBeenCalledWith(
      ledgerInfo.notesPath,
      1,
      "[FAIL] ledger validation failed: line 1 changed (id r1)",
      [],
      expect.arrayContaining([
        "Agent reported success: studied cache",
        `Rejected ledger saved to ${rejectedPath}`,
      ]),
      expect.objectContaining({ evidenceOrigin: "executed" }),
    );
    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "ledger:invalid",
      expect.objectContaining({
        iteration: 1,
        reason: "line 1 changed (id r1)",
        rejectedPath,
      }),
    );
    expect(orchestrator.getState().lastAgentError).toBeNull();
  });

  it("restores the snapshot after resetHard reverts or removes the ledger", async () => {
    mockResetHard.mockImplementation(() => {
      rmSync(ledgerInfo.ledgerPath!, { force: true });
    });
    const orchestrator = orchestratorFor(
      ledgerAgent([{ ledger: () => r2 }]),
      1,
    );

    await orchestrator.start();

    expect(orchestrator.getState().iterations[0]!.summary).toBe(
      "ledger validation failed: line 1 changed (id r1)",
    );
    expect(readFileSync(ledgerInfo.ledgerPath!, "utf-8")).toBe(r1);
  });

  it("tells the next iteration why the ledger was rejected, once", async () => {
    const agent = ledgerAgent([
      { ledger: () => r1Rewritten },
      { ledger: (c) => c + r2 },
      { ledger: (c) => c },
    ]);

    await orchestratorFor(agent, 3).start();

    const prompts = vi
      .mocked(agent.run)
      .mock.calls.map((call) => String(call[0]));
    expect(prompts[0]).not.toContain("## Previous Ledger Rejection");
    expect(prompts[1]).toContain("## Previous Ledger Rejection");
    expect(prompts[1]).toContain("line 1 changed (id r1)");
    expect(prompts[1]).toContain(
      join(ledgerInfo.runDir, "ledger", "rejected-iteration-1.jsonl"),
    );
    expect(prompts[2]).not.toContain("## Previous Ledger Rejection");
    expect(readFileSync(ledgerInfo.ledgerPath!, "utf-8")).toBe(r1 + r2);
  });

  it("rejects an invalid ledger from a reported failure", async () => {
    const orchestrator = orchestratorFor(
      ledgerAgent([{ ledger: (c) => `${c}not json\n`, success: false }]),
      1,
    );

    await orchestrator.start();

    expect(orchestrator.getState().iterations[0]!.summary).toBe(
      "ledger validation failed: line 2 is not valid JSON",
    );
    expect(readFileSync(ledgerInfo.ledgerPath!, "utf-8")).toBe(r1);
    expect(
      readFileSync(
        join(ledgerInfo.runDir, "ledger", "rejected-iteration-1.jsonl"),
        "utf-8",
      ),
    ).toBe(`${r1}not json\n`);
  });

  it("keeps valid records from a reported failure even when resetHard reverts the ledger", async () => {
    mockResetHard.mockImplementation(() => {
      writeFileSync(ledgerInfo.ledgerPath!, r1, "utf-8");
    });
    const orchestrator = orchestratorFor(
      ledgerAgent([{ ledger: (c) => c + r2, success: false }]),
      1,
    );

    await orchestrator.start();

    expect(orchestrator.getState().iterations[0]!.summary).toBe(
      "studied cache",
    );
    expect(mockResetHard).toHaveBeenCalledTimes(1);
    expect(readFileSync(ledgerInfo.ledgerPath!, "utf-8")).toBe(r1 + r2);
  });

  it("rejects an invalid ledger left by an agent error", async () => {
    mockResetHard.mockImplementation(() => {
      rmSync(ledgerInfo.ledgerPath!, { force: true });
    });
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        writeFileSync(ledgerInfo.ledgerPath!, r2, "utf-8");
        throw new Error("agent crashed");
      }),
    };
    const orchestrator = orchestratorFor(agent, 1);

    await orchestrator.start();

    expect(orchestrator.getState().iterations[0]!.summary).toBe(
      "agent crashed",
    );
    expect(readFileSync(ledgerInfo.ledgerPath!, "utf-8")).toBe(r1);
    expect(
      readFileSync(
        join(ledgerInfo.runDir, "ledger", "rejected-iteration-1.jsonl"),
        "utf-8",
      ),
    ).toBe(r2);
    expect(
      mockAppendDebugLog.mock.calls.some(
        ([event]) => event === "ledger:restored",
      ),
    ).toBe(false);
  });

  it("counts a ledger rejection as no progress, not as an agent error", async () => {
    const orchestrator = orchestratorFor(
      ledgerAgent([{ ledger: () => r1Rewritten }]),
      1,
    );

    await orchestrator.start();

    const state = orchestrator.getState();
    expect(state.failCount).toBe(1);
    expect(state.consecutiveFailures).toBe(1);
    expect(state.consecutiveErrors).toBe(0);
  });

  it("does not read or validate a ledger outside research mode", async () => {
    const agent = ledgerAgent([{ ledger: () => r1Rewritten }]);
    const orchestrator = new Orchestrator(
      config,
      agent,
      { ...ledgerInfo, workflow: "default", ledgerPath: undefined },
      "ship it",
      dir,
      0,
      { maxIterations: 1 },
    );

    await orchestrator.start();

    expect(orchestrator.getState().iterations[0]!.success).toBe(true);
    expect(
      mockAppendDebugLog.mock.calls.some(([event]) =>
        String(event).startsWith("ledger:"),
      ),
    ).toBe(false);
  });

  it("records the validated ledger beside the run", async () => {
    await orchestratorFor(ledgerAgent([{ ledger: (c) => c + r2 }]), 1).start();

    expect(readFileSync(validatedPath(), "utf-8")).toBe(r1 + r2);
  });

  it("never overwrites an earlier rejected file", async () => {
    const earlier = join(
      ledgerInfo.runDir,
      "ledger",
      "rejected-iteration-1.jsonl",
    );
    writeFileSync(earlier, "earlier rejection", "utf-8");

    await orchestratorFor(
      ledgerAgent([{ ledger: () => r1Rewritten }]),
      1,
    ).start();

    expect(readFileSync(earlier, "utf-8")).toBe("earlier rejection");
    expect(
      readFileSync(
        join(ledgerInfo.runDir, "ledger", "rejected-iteration-1-2.jsonl"),
        "utf-8",
      ),
    ).toBe(r1Rewritten);
  });

  it("ignores should_fully_stop from an iteration whose ledger was rejected", async () => {
    const agent = ledgerAgent([
      { ledger: () => r1Rewritten, stop: true },
      { ledger: (c) => c + r2 },
    ]);
    const orchestrator = new Orchestrator(
      config,
      agent,
      ledgerInfo,
      "study it",
      dir,
      0,
      { maxIterations: 2, stopWhen: "done" },
    );

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(2);
    expect(orchestrator.getState().iterations[1]!.success).toBe(true);
  });

  it("rejects a partial line left by an aborted iteration at the next start instead of failing every iteration", async () => {
    const partial = `${r1}{"id":"r2","itera`;
    const aborting: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        writeFileSync(ledgerInfo.ledgerPath!, partial, "utf-8");
        throw new PermanentAgentError("auth failed", "auth failed");
      }),
    };
    await orchestratorFor(aborting, 3).start();

    const record = (id: string) =>
      `${JSON.stringify({ id, iteration: 1, evidence_origin: "none", claim: id })}\n`;
    const agent = ledgerAgent([
      { ledger: (c) => c + r2 },
      { ledger: (c) => c + record("r3") },
      { ledger: (c) => c + record("r4") },
    ]);
    const later = orchestratorFor(agent, 3);
    await later.start();

    const iterations = later.getState().iterations;
    expect(iterations.map((record) => record.success)).toEqual([
      true,
      true,
      true,
    ]);
    const rejectedPath = join(
      ledgerInfo.runDir,
      "ledger",
      "rejected-before-iteration-1.jsonl",
    );
    expect(readFileSync(rejectedPath, "utf-8")).toBe(partial);
    const prompts = vi
      .mocked(agent.run)
      .mock.calls.map((call) => String(call[0]));
    expect(prompts[0]).toContain("## Previous Ledger Rejection");
    expect(prompts[0]).toContain("made outside a checked iteration");
    expect(prompts[0]).toContain(rejectedPath);
    expect(prompts[1]).not.toContain("## Previous Ledger Rejection");
    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "ledger:invalid",
      expect.objectContaining({ iteration: 1, rejectedPath }),
    );
    expect(readFileSync(ledgerInfo.ledgerPath!, "utf-8")).toBe(
      r1 + r2 + record("r3") + record("r4"),
    );
  });

  it("keeps valid records from a reported failure when a later iteration aborts and resetHard reverts the ledger", async () => {
    mockResetHard.mockImplementation(() => {
      writeFileSync(ledgerInfo.ledgerPath!, r1, "utf-8");
    });
    let call = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        call++;
        if (call === 2) {
          throw new PermanentAgentError("auth failed", "auth failed");
        }
        writeFileSync(ledgerInfo.ledgerPath!, r1 + r2, "utf-8");
        return {
          output: {
            success: false,
            summary: "dead end",
            key_changes_made: [],
            key_learnings: [],
            evidence_origin: "executed" as const,
            goals_changed: [],
            contracts_run: [],
            boundary: "b",
          },
          usage,
        };
      }),
    };
    const orchestrator = orchestratorFor(agent, 3);

    await orchestrator.start();

    expect(orchestrator.getState().status).toBe("aborted");
    expect(readFileSync(ledgerInfo.ledgerPath!, "utf-8")).toBe(r1 + r2);
    expect(readFileSync(validatedPath(), "utf-8")).toBe(r1 + r2);
    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "ledger:restored",
      expect.anything(),
    );
  });

  it("accepts valid records left by an aborted iteration without a rejection", async () => {
    const aborting: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        writeFileSync(ledgerInfo.ledgerPath!, r1 + r2, "utf-8");
        throw new PermanentAgentError("auth failed", "auth failed");
      }),
    };
    await orchestratorFor(aborting, 1).start();
    const r3 = `${JSON.stringify({ id: "r3", iteration: 1, evidence_origin: "none", claim: "c3" })}\n`;
    const agent = ledgerAgent([{ ledger: (c) => c + r3 }]);

    await orchestratorFor(agent, 1).start();

    expect(String(vi.mocked(agent.run).mock.calls[0]![0])).not.toContain(
      "## Previous Ledger Rejection",
    );
    expect(readFileSync(ledgerInfo.ledgerPath!, "utf-8")).toBe(r1 + r2 + r3);
  });

  it("restores the validated ledger after a stop resets the workspace", async () => {
    mockResetHard.mockImplementation(() => {
      rmSync(ledgerInfo.ledgerPath!, { force: true });
    });
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        (_prompt, _cwd, options) =>
          new Promise<AgentResult>((_resolve, reject) => {
            writeFileSync(ledgerInfo.ledgerPath!, r1 + r2, "utf-8");
            options?.signal?.addEventListener("abort", () =>
              reject(new Error("Agent was aborted")),
            );
            started();
          }),
      ),
    };
    const orchestrator = orchestratorFor(agent, 1);

    const done = orchestrator.start();
    await running;
    orchestrator.stop();
    await done;

    expect(mockResetHard).toHaveBeenCalled();
    expect(readFileSync(ledgerInfo.ledgerPath!, "utf-8")).toBe(r1);
  });
});

describe("Orchestrator research stats and stall signal", () => {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let dir: string;
  let statsInfo: RunInfo;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockCommitAll.mockReturnValue(true);
    dir = mkdtempSync(join(tmpdir(), "gnhf-research-stats-"));
    const runDir = join(dir, ".gnhf", "runs", "run-abc");
    mkdirSync(join(runDir, "ledger"), { recursive: true });
    statsInfo = {
      ...runInfo,
      runDir,
      logPath: join(runDir, "gnhf.log"),
      workflow: "research",
      ledgerPath: join(runDir, "ledger", "records.jsonl"),
    };
    writeFileSync(statsInfo.ledgerPath!, "", "utf-8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  type Step = {
    origin: "executed" | "source_read" | "reasoning_only" | "none";
    goals?: string[];
    contracts?: string[];
    records?: Record<string, unknown>[];
    success?: boolean;
    rewriteLedger?: string;
    rateLimited?: boolean;
  };

  function evidenceAgent(steps: Step[]): Agent {
    let call = 0;
    return {
      name: "claude",
      run: vi.fn(async () => {
        const step = steps[Math.min(call, steps.length - 1)]!;
        call++;
        if (step.rateLimited === true) {
          throw new RateLimitAgentError(
            "claude usage limit reached",
            "claude exited with code 1: usage limit",
            null,
          );
        }
        for (const record of step.records ?? []) {
          writeFileSync(
            statsInfo.ledgerPath!,
            `${readFileSync(statsInfo.ledgerPath!, "utf-8")}${JSON.stringify(record)}\n`,
            "utf-8",
          );
        }
        if (step.rewriteLedger !== undefined) {
          writeFileSync(statsInfo.ledgerPath!, step.rewriteLedger, "utf-8");
        }
        return {
          output: {
            success: step.success ?? true,
            summary: "studied",
            key_changes_made: ["x"],
            key_learnings: [],
            evidence_origin: step.origin,
            goals_changed: step.goals ?? ["G1"],
            contracts_run: step.contracts ?? [],
            boundary: "b",
          },
          usage,
        };
      }),
    };
  }

  function promptParams(): Array<Record<string, unknown>> {
    return vi
      .mocked(buildIterationPrompt)
      .mock.calls.map(([params]) => params as Record<string, unknown>);
  }

  function run(
    agent: Agent,
    maxIterations: number,
    overrides: Partial<Config> = {},
    info: RunInfo = statsInfo,
  ): Orchestrator {
    return new Orchestrator(
      { ...config, ...overrides },
      agent,
      info,
      "study it",
      dir,
      0,
      { maxIterations },
    );
  }

  it("exposes research stats computed from iterations and the validated ledger", async () => {
    const record = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      iteration: 1,
      evidence_origin: "executed",
      claim: `claim ${id}`,
      ...extra,
    });
    const orchestrator = run(
      evidenceAgent([
        {
          origin: "executed",
          records: [
            record("c1", { type: "contract", boundary: "b" }),
            record("c2", { type: "contract", boundary: "b" }),
            record("c3", { type: "contract" }),
            record("r1"),
          ],
        },
        { origin: "reasoning_only", goals: [], contracts: ["c1"] },
        {
          origin: "source_read",
          goals: [],
          records: [record("r2", { reframes: "c2", boundary: "b" })],
        },
      ]),
      3,
    );

    await orchestrator.start();

    expect(orchestrator.getState().research).toEqual({
      executed: 1,
      sourceRead: 1,
      reasoningOnly: 1,
      noEvidence: 0,
      goalsStale: 2,
      reasoningStreak: 0,
      openContracts: 1,
      missingBoundary: 1,
    });
  });

  it("does not close contracts or reset goals stale from failed or ledger-rejected iterations", async () => {
    const contract = {
      id: "c1",
      iteration: 1,
      evidence_origin: "none",
      claim: "run c1",
      type: "contract",
      boundary: "b",
    };
    const orchestrator = run(
      evidenceAgent([
        { origin: "executed", goals: [], records: [contract] },
        {
          origin: "executed",
          goals: ["G1"],
          contracts: ["c1"],
          rewriteLedger: `${JSON.stringify({ ...contract, claim: "edited" })}\n`,
        },
        {
          origin: "executed",
          goals: ["G1"],
          contracts: ["c1"],
          success: false,
        },
      ]),
      3,
    );

    await orchestrator.start();

    expect(orchestrator.getState().iterations.map((i) => i.success)).toEqual([
      true,
      false,
      false,
    ]);
    expect(orchestrator.getState().iterations[1]!.summary).toMatch(
      /^ledger validation failed/,
    );
    expect(orchestrator.getState().research).toMatchObject({
      executed: 3,
      goalsStale: 3,
      openContracts: 1,
    });
  });

  it("logs success in iteration:end so a resume ignores failed iterations", async () => {
    const orchestrator = run(
      evidenceAgent([
        {
          origin: "executed",
          goals: ["G1"],
          contracts: ["c1"],
          success: false,
        },
      ]),
      1,
    );

    await orchestrator.start();

    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "iteration:end",
      expect.objectContaining({
        iteration: 1,
        success: false,
        contractsRun: ["c1"],
      }),
    );
  });

  it("refreshes ledger stats from the pre-iteration ledger check", async () => {
    let openContractsDuringRun: number | undefined;
    const agent = evidenceAgent([{ origin: "executed" }]);
    const runAgent = agent.run;
    agent.run = vi.fn(async (...args: Parameters<Agent["run"]>) => {
      openContractsDuringRun = orchestrator.getState().research?.openContracts;
      return runAgent(...args);
    });
    const orchestrator = run(agent, 1);
    writeFileSync(
      statsInfo.ledgerPath!,
      `${JSON.stringify({ id: "c1", iteration: 0, evidence_origin: "none", claim: "next", type: "contract", boundary: "b" })}\n`,
      "utf-8",
    );

    expect(orchestrator.getState().research?.openContracts).toBe(0);

    await orchestrator.start();

    expect(openContractsDuringRun).toBe(1);
  });

  it("logs research:observer once per iteration, also across rate-limit retries", async () => {
    const orchestrator = new Orchestrator(
      { ...config, observerEvery: 2 },
      evidenceAgent([
        { origin: "executed" },
        { origin: "executed", rateLimited: true },
        { origin: "executed" },
      ]),
      statsInfo,
      "study it",
      dir,
      0,
      { maxIterations: 3, fallbackModel: "claude-haiku" },
    );

    await orchestrator.start();

    expect(promptParams().map((p) => p.observerPass)).toEqual([
      undefined,
      "iteration 2 is a multiple of observerEvery (2)",
      "iteration 2 is a multiple of observerEvery (2)",
      undefined,
    ]);
    expect(
      mockAppendDebugLog.mock.calls.filter(
        ([event]) => event === "research:observer",
      ),
    ).toEqual([
      [
        "research:observer",
        {
          iteration: 2,
          reasons: ["iteration 2 is a multiple of observerEvery (2)"],
        },
      ],
    ]);
  });

  it("leaves research stats out of the default workflow state", async () => {
    const orchestrator = run(
      evidenceAgent([{ origin: "executed" }]),
      1,
      {},
      { ...statsInfo, workflow: "default", ledgerPath: undefined },
    );

    await orchestrator.start();

    expect(orchestrator.getState()).not.toHaveProperty("research");
    for (const params of promptParams()) {
      expect(params).not.toHaveProperty("stall");
      expect(params).not.toHaveProperty("observerPass");
    }
  });

  it("asks for a change of approach and an observer pass after three reasoning_only iterations without stopping", async () => {
    const agent = evidenceAgent([{ origin: "reasoning_only" }]);
    const orchestrator = run(agent, 5);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(5);
    const params = promptParams();
    expect(params.slice(0, 3).map((p) => p.stall)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(params[3]!.stall).toEqual([{ signal: "reasoning", iterations: 3 }]);
    expect(params[3]!.observerPass).toBe(
      "the stall signal fired after iteration 3",
    );
    expect(params[4]).not.toHaveProperty("stall");
    expect(params[4]).not.toHaveProperty("observerPass");
    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "research:stall",
      expect.objectContaining({
        iteration: 3,
        signals: ["reasoning"],
        reasoningStreak: 3,
      }),
    );
    expect(
      mockAppendDebugLog.mock.calls.filter(
        ([event]) => event === "research:stall",
      ),
    ).toHaveLength(1);
    expect(orchestrator.getState().lastMessage).toBe(
      "max iterations reached (5)",
    );
  });

  it("fires the goals signal after three iterations with no goal change", async () => {
    const orchestrator = run(
      evidenceAgent([{ origin: "executed", goals: [] }]),
      4,
    );

    await orchestrator.start();

    expect(promptParams()[3]).toHaveProperty("finalIteration");
    expect(promptParams()[3]).not.toHaveProperty("stall");
    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "research:stall",
      expect.objectContaining({ iteration: 3, signals: ["goals"] }),
    );
  });

  it("names the goals signal in the next prompt", async () => {
    const orchestrator = run(
      evidenceAgent([{ origin: "executed", goals: [] }]),
      5,
    );

    await orchestrator.start();

    expect(promptParams()[3]!.stall).toEqual([
      { signal: "goals", iterations: 3 },
    ]);
  });

  it("schedules an observer pass every observerEvery iterations", async () => {
    const orchestrator = run(evidenceAgent([{ origin: "executed" }]), 5, {
      observerEvery: 2,
    });

    await orchestrator.start();

    expect(promptParams().map((p) => p.observerPass)).toEqual([
      undefined,
      "iteration 2 is a multiple of observerEvery (2)",
      undefined,
      "iteration 4 is a multiple of observerEvery (2)",
      undefined,
    ]);
  });

  it("defaults observerEvery to 5 and skips the observer on the final iteration", async () => {
    const orchestrator = run(evidenceAgent([{ origin: "executed" }]), 6);

    await orchestrator.start();

    const params = promptParams();
    expect(params[4]!.observerPass).toBe(
      "iteration 5 is a multiple of observerEvery (5)",
    );
    expect(params.filter((p) => p.observerPass !== undefined)).toHaveLength(1);
  });

  it("disables the scheduled observer pass when observerEvery is 0", async () => {
    const orchestrator = run(evidenceAgent([{ origin: "executed" }]), 4, {
      observerEvery: 0,
    });

    await orchestrator.start();

    expect(
      promptParams().filter((p) => p.observerPass !== undefined),
    ).toHaveLength(0);
  });

  it("rebuilds research stats and the stall signal from gnhf.log on resume", async () => {
    writeFileSync(
      statsInfo.logPath,
      [1, 2, 3]
        .map((iteration) =>
          JSON.stringify({
            event: "iteration:end",
            iteration,
            success: true,
            evidenceOrigin: "reasoning_only",
            goalsChanged: ["G1"],
            contractsRun: [],
            boundary: "",
          }),
        )
        .join("\n") + "\n",
      "utf-8",
    );
    writeFileSync(
      join(statsInfo.runDir, "ledger", "validated.jsonl"),
      `${JSON.stringify({ id: "c1", iteration: 1, evidence_origin: "none", claim: "next", type: "contract" })}\n`,
      "utf-8",
    );
    const orchestrator = new Orchestrator(
      config,
      evidenceAgent([{ origin: "executed" }]),
      statsInfo,
      "study it",
      dir,
      3,
      { maxIterations: 5 },
    );

    expect(orchestrator.getState().research).toMatchObject({
      reasoningOnly: 3,
      reasoningStreak: 3,
      openContracts: 1,
      missingBoundary: 0,
    });

    await orchestrator.start();

    expect(promptParams()[0]).toMatchObject({
      n: 4,
      stall: [{ signal: "reasoning", iterations: 3 }],
      observerPass: "the stall signal fired after iteration 3",
    });
    expect(orchestrator.getState().research).toMatchObject({
      executed: 2,
      reasoningOnly: 3,
      reasoningStreak: 0,
    });
  });
});
