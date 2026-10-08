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

import { createAgent } from "./factory.js";
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
    });
    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: noStopSchema,
    });
    expect(agent.name).toBe("claude");
  });

  it("passes extra args through to the ClaudeAgent", () => {
    const agent = createAgent(undefined, ["--model", "sonnet"], {
      includeStopField: false,
    });

    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: ["--model", "sonnet"],
      schema: noStopSchema,
    });
    expect(agent.name).toBe("claude");
  });

  it("hands ClaudeAgent a schema that requires should_fully_stop when includeStopField is true", () => {
    createAgent(undefined, undefined, {
      includeStopField: true,
    });
    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: withStopSchema,
    });
  });

  it("hands ClaudeAgent a schema with configured commit message fields", () => {
    createAgent(undefined, undefined, {
      includeStopField: false,
      commitFields: [
        { name: "type", allowed: ["feat", "fix"] },
        { name: "scope" },
      ],
    });

    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
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
});
