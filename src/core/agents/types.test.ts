import { describe, expect, it } from "vitest";
import { buildAgentOutputSchema } from "./types.js";

describe("buildAgentOutputSchema", () => {
  it("adds configured commit message fields to properties and required", () => {
    const schema = buildAgentOutputSchema({
      includeStopField: false,
      commitFields: [
        {
          name: "type",
          allowed: ["feat", "fix"],
        },
        {
          name: "scope",
        },
      ],
    });

    expect(schema.properties.type).toEqual({
      type: "string",
      enum: ["feat", "fix"],
    });
    expect(schema.properties.scope).toEqual({ type: "string" });
    expect(schema.required).toContain("type");
    expect(schema.required).toContain("scope");
  });
});

describe("buildAgentOutputSchema research fields", () => {
  const researchFields = [
    "evidence_origin",
    "goals_changed",
    "contracts_run",
    "boundary",
  ];

  it("requires the four research fields when research is true", () => {
    const schema = buildAgentOutputSchema({
      includeStopField: false,
      research: true,
    });

    expect(schema.properties.evidence_origin).toEqual({
      type: "string",
      enum: ["executed", "source_read", "reasoning_only", "none"],
    });
    expect(schema.properties.goals_changed).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(schema.properties.contracts_run).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(schema.properties.boundary).toEqual({ type: "string" });
    expect(schema.required).toEqual(expect.arrayContaining(researchFields));
  });

  it("omits the research fields when research is false or unset", () => {
    for (const schema of [
      buildAgentOutputSchema({ includeStopField: false, research: false }),
      buildAgentOutputSchema({ includeStopField: false }),
    ]) {
      expect(Object.keys(schema.properties)).toEqual([
        "success",
        "summary",
        "key_changes_made",
        "key_learnings",
      ]);
      expect(schema.required).toEqual([
        "success",
        "summary",
        "key_changes_made",
        "key_learnings",
      ]);
    }
  });
});
