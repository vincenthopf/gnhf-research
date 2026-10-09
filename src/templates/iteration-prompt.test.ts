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

describe("buildIterationPrompt workflow", () => {
  const base = { n: 2, runId: "run-1", prompt: "do stuff" };

  it("keeps the default prompt byte-for-byte unchanged", () => {
    const expected = [
      "You are working autonomously towards an objective given below.",
      "This is iteration 2. Each iteration aims to make an incremental step forward, not to complete the entire objective.",
      "",
      "## Instructions",
      "",
      "1. Read .gnhf/runs/run-1/notes.md first to understand what has been done in previous iterations. Do NOT write to or modify notes.md - it is maintained automatically by the gnhf orchestrator",
      "2. Identify the next smallest logical unit of work that's individually verifiable and would make incremental progress towards the objective, and treat that as the scope of this iteration",
      "3. If you attempted a solution and it didn't end up moving the needle on the objective, document learnings and record success=false, then conclude the iteration rather than continuously pivoting",
      "4. If you made code changes, run build/tests/linters/formatters if available to validate your work. Do NOT make any git commits - that will be handled automatically by the gnhf orchestrator",
      "5. If you started any long-running background processes (dev servers, browsers, watchers, Electron, etc.), stop them before finishing the iteration",
      "6. Only submit the final JSON object after the result is final: your work is complete, validation is done, and you have stopped any background processes you started",
      "",
      "## Output",
      "",
      "- success: whether you were able to make a meaningful contribution that got us closer towards the objective. setting this to false means any code change you made should be discarded. A complete no-op iteration (no file changes AND no new meaningful learnings worth recording) is not a success - set success=false so the run can halt rather than spin on no-op iterations",
      "- summary: a concise one-sentence summary of the accomplishment in this iteration",
      "- key_changes_made: an array of descriptions for key changes you made. don't group this by file - group by logical units of work. don't describe activities - describe material outcomes",
      "- key_learnings: an array of new learnings that were surprising, weren't captured by previous notes and would be informative for future iterations",
      "",
      "## Objective",
      "",
      "do stuff",
    ].join("\n");

    expect(buildIterationPrompt(base)).toBe(expected);
    expect(buildIterationPrompt({ ...base, workflow: "default" })).toBe(
      expected,
    );
  });

  it("omits research fields and the research section by default", () => {
    const result = buildIterationPrompt(base);
    expect(result).not.toContain("## Research Workflow");
    expect(result).not.toContain("evidence_origin");
    expect(result).not.toContain("goals_changed");
    expect(result).not.toContain("contracts_run");
    expect(result).not.toContain("- boundary:");
  });

  it("describes the four research output fields in research mode", () => {
    const result = buildIterationPrompt({ ...base, workflow: "research" });
    const output = result.slice(
      result.indexOf("## Output"),
      result.indexOf("## Research Workflow"),
    );
    expect(output).toContain(
      "- evidence_origin: executed, source_read, reasoning_only, or none",
    );
    expect(output).toContain("- goals_changed:");
    expect(output).toContain("- contracts_run:");
    expect(output).toContain("- boundary:");
  });

  it("places the research workflow section before the objective", () => {
    const result = buildIterationPrompt({ ...base, workflow: "research" });
    const section = result.indexOf("## Research Workflow");
    const objective = result.indexOf("## Objective");
    expect(section).toBeGreaterThan(result.indexOf("## Output"));
    expect(section).toBeLessThan(objective);
    expect(result.trimEnd().endsWith("do stuff")).toBe(true);
  });

  it("lists the eight continuation steps in order", () => {
    const result = buildIterationPrompt({ ...base, workflow: "research" });
    const section = result.slice(
      result.indexOf("## Research Workflow"),
      result.indexOf("## Objective"),
    );
    const steps = [
      "1. Re-anchor:",
      "2. Pick one study:",
      "3. Sources:",
      "4. Execute one bounded study:",
      "5. Evidence records:",
      "6. Cross-goal return:",
      "7. Next contracts:",
      "8. Never delete:",
    ];
    const positions = steps.map((step) => section.indexOf(step));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(section).toContain("notes.md");
    expect(section).toContain("reasoning_only");
    expect(section).toContain("goals_changed");
    expect(section).toContain("contracts_run");
    expect(section).toContain("abstract, skimmed, full read, code read");
    expect(section).toContain(
      "Repetition is a reason to change approach, not to stop.",
    );
    expect(section).toContain(
      "If nothing was executed, label the iteration source_read or reasoning_only, whichever is true",
    );
    expect(section).not.toContain(
      "label the iteration reasoning_only honestly",
    );
  });

  it("keeps stop condition and deadline sections in research mode", () => {
    const result = buildIterationPrompt({
      ...base,
      workflow: "research",
      stopWhen: "done",
      deadline: "17:30",
    });
    const research = result.indexOf("## Research Workflow");
    expect(research).toBeGreaterThan(result.indexOf("- boundary:"));
    expect(research).toBeLessThan(result.indexOf("## Stop Condition"));
    expect(research).toBeLessThan(result.indexOf("## Deadline"));
  });

  it("keeps the wrap-up final iteration as the last instruction in research mode", () => {
    const result = buildIterationPrompt({
      ...base,
      workflow: "research",
      finalIteration: { reason: "the deadline has passed", wrapUpOnly: true },
    });
    const research = result.indexOf("## Research Workflow");
    const finalIteration = result.indexOf("## Final Iteration");
    const objective = result.indexOf("## Objective");
    expect(research).toBeGreaterThan(-1);
    expect(finalIteration).toBeGreaterThan(research);
    expect(objective).toBeGreaterThan(finalIteration);
    expect(result.slice(finalIteration, objective)).toContain(
      "Do not start new work",
    );
  });
});
