import { describe, it, expect } from "vitest";
import { buildIterationPrompt } from "./iteration-prompt.js";
import { CONVENTIONAL_COMMIT_MESSAGE } from "../core/commit-message.js";

describe("buildIterationPrompt", () => {
  it("includes the iteration number", () => {
    const result = buildIterationPrompt({
      n: 3,
      runId: "test-run-123",
      prompt: "fix all bugs",
    });
    expect(result).toContain("iteration 3");
  });

  it("includes the run ID in the notes path", () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: "my-run-abc",
      prompt: "do stuff",
    });
    expect(result).toContain(".gnhf/runs/my-run-abc/notes.md");
  });

  it("includes the objective prompt at the end", () => {
    const prompt = "improve test coverage";
    const result = buildIterationPrompt({
      n: 1,
      runId: "run-1",
      prompt,
    });
    expect(result).toContain("## Objective");
    expect(result.trimEnd().endsWith(prompt)).toBe(true);
  });

  it("includes instructions about reading notes and focusing on small units", () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: "run-1",
      prompt: "test",
    });
    expect(result).toContain("Read .gnhf/runs/");
    expect(result).toContain("smallest logical unit");
  });

  it("instructs agents to submit structured output only after cleanup and final verification", () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: "run-1",
      prompt: "test",
    });
    expect(result).toContain("Only submit the final JSON object after");
    expect(result).toContain("stopped any background processes");
  });

  it("produces a prompt identical to the default when stopWhen is not set", () => {
    const baseline = buildIterationPrompt({
      n: 1,
      runId: "run-1",
      prompt: "do stuff",
    });
    const withUndefined = buildIterationPrompt({
      n: 1,
      runId: "run-1",
      prompt: "do stuff",
      stopWhen: undefined,
    });
    expect(withUndefined).toBe(baseline);
    expect(baseline).not.toContain("should_fully_stop");
    expect(baseline).not.toContain("Stop Condition");
  });

  it("injects a stop condition section and should_fully_stop output field when stopWhen is set", () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: "run-1",
      prompt: "do stuff",
      stopWhen: "all tasks are done",
    });
    expect(result).toContain("Stop Condition");
    expect(result).toContain("all tasks are done");
    expect(result).toContain("should_fully_stop");
    expect(result).toContain("set it to false");
    expect(result).not.toContain("omit it");
  });

  it("adds commit message field instructions when the convention requires them", () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: "run-1",
      prompt: "do stuff",
      commitMessage: CONVENTIONAL_COMMIT_MESSAGE,
    });

    expect(result).toContain("type: Commit type");
    expect(result).toContain(
      "allowed values: build, ci, docs, feat, fix, perf, refactor, test, chore",
    );
    expect(result).toContain('default: "chore"');
    expect(result).toContain("scope: Optional commit scope");
    expect(result).toContain('default: ""');
  });

  it("warns the agent that complete no-op iterations should report success=false", () => {
    // Without this guardrail, an agent that converges (no further useful
    // work) keeps reporting success=true with empty key_changes_made,
    // which the orchestrator can't distinguish from a productive
    // iteration and the loop spins forever.
    const result = buildIterationPrompt({
      n: 1,
      runId: "run-1",
      prompt: "test",
    });
    expect(result).toContain("complete no-op iteration");
    expect(result).toContain("success=false");
  });

  it("states the run deadline when one is set", () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: "run-1",
      prompt: "test",
      deadline: "2026-10-10 17:30",
    });
    expect(result).toContain("## Deadline");
    expect(result).toContain("2026-10-10 17:30");
    expect(result.trimEnd().endsWith("test")).toBe(true);
  });

  it("omits the deadline and final iteration sections by default", () => {
    const result = buildIterationPrompt({ n: 1, runId: "run-1", prompt: "t" });
    expect(result).not.toContain("## Deadline");
    expect(result).not.toContain("## Final Iteration");
  });

  it("asks the last capped iteration to finish its work and post the summary", () => {
    const result = buildIterationPrompt({
      n: 5,
      runId: "run-1",
      prompt: "test",
      finalIteration: {
        reason: "this is the last iteration allowed by --max-iterations (5)",
        wrapUpOnly: false,
      },
    });
    expect(result).toContain("## Final Iteration");
    expect(result).toContain(
      "this is the last iteration allowed by --max-iterations (5)",
    );
    expect(result).toContain("final summary");
    expect(result).not.toContain("Do not start new work");
  });

  it("tells a deadline wrap-up iteration not to start new work", () => {
    const result = buildIterationPrompt({
      n: 5,
      runId: "run-1",
      prompt: "test",
      finalIteration: {
        reason: "the run deadline (2026-10-10 17:30) has passed",
        wrapUpOnly: true,
      },
    });
    expect(result).toContain("## Final Iteration");
    expect(result).toContain("Do not start new work");
    expect(result).toContain("final summary");
  });
});
