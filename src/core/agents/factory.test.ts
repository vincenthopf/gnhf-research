import { describe, it, expect, vi } from "vitest";

vi.mock("./claude.js", () => {
  const ClaudeAgent = vi.fn(function (
    this: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) {
    this.name = "claude";
    this.deps = deps;
  });
  return { ClaudeAgent };
});

import { DEFAULT_CLAUDE_MODEL, createAgent } from "./factory.js";
import { ClaudeAgent } from "./claude.js";

const noStopSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    success: { type: "boolean" },
    summary: { type: "string" },
    key_changes_made: { type: "array", items: { type: "string" } },
    key_learnings: { type: "array", items: { type: "string" } },
  },
  required: ["success", "summary", "key_changes_made", "key_learnings"],
};

const withStopSchema = {
  ...noStopSchema,
  properties: {
    ...noStopSchema.properties,
    should_fully_stop: { type: "boolean" },
  },
  required: [...noStopSchema.required, "should_fully_stop"],
};

describe("createAgent", () => {
  it("creates a ClaudeAgent", () => {
    const agent = createAgent(undefined, undefined, {
      includeStopField: false,
      effort: "medium",
    });
    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      model: DEFAULT_CLAUDE_MODEL,
      effort: "medium",
      schema: noStopSchema,
    });
    expect(agent.name).toBe("claude");
  });

  it("passes extra args through to the ClaudeAgent", () => {
    const agent = createAgent("/opt/bin/claude", ["--add-dir", "../lib"], {
      includeStopField: false,
      effort: "medium",
    });

    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: "/opt/bin/claude",
      extraArgs: ["--add-dir", "../lib"],
      model: DEFAULT_CLAUDE_MODEL,
      effort: "medium",
      schema: noStopSchema,
    });
    expect(agent.name).toBe("claude");
  });

  it("hands ClaudeAgent a schema that requires should_fully_stop when includeStopField is true", () => {
    createAgent(undefined, undefined, {
      includeStopField: true,
      effort: "medium",
    });
    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      model: DEFAULT_CLAUDE_MODEL,
      effort: "medium",
      schema: withStopSchema,
    });
  });

  it("hands ClaudeAgent a schema with configured commit message fields", () => {
    createAgent(undefined, undefined, {
      includeStopField: false,
      effort: "medium",
      commitFields: [
        { name: "type", allowed: ["feat", "fix"] },
        { name: "scope" },
      ],
    });

    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      model: DEFAULT_CLAUDE_MODEL,
      effort: "medium",
      schema: {
        ...noStopSchema,
        properties: {
          ...noStopSchema.properties,
          type: { type: "string", enum: ["feat", "fix"] },
          scope: { type: "string" },
        },
        required: [...noStopSchema.required, "type", "scope"],
      },
    });
  });

  it("defaults the model to Opus 5.5", () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe("claude-opus-5-5");
  });

  it("passes an explicit model and effort through to the ClaudeAgent", () => {
    createAgent(undefined, undefined, {
      includeStopField: false,
      model: "sonnet",
      effort: "max",
    });

    expect(vi.mocked(ClaudeAgent).mock.lastCall?.[0]).toMatchObject({
      model: "sonnet",
      effort: "max",
    });
  });

  it.each([[["--model", "sonnet"]], [["--model=sonnet"]]])(
    "leaves the model to agentArgsOverride when it sets %j",
    (extraArgs) => {
      createAgent(undefined, extraArgs, {
        includeStopField: false,
        effort: "medium",
      });

      expect(vi.mocked(ClaudeAgent).mock.lastCall?.[0]).toMatchObject({
        extraArgs,
        model: undefined,
      });
    },
  );
});
