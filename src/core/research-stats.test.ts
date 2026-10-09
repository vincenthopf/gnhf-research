import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeResearchStats,
  detectStall,
  formatResearchStats,
  readResearchHistory,
  researchStatsSegments,
  type ResearchStats,
} from "./research-stats.js";
import type { ResearchEvidence } from "./workflow.js";

function evidence(
  evidenceOrigin: string,
  goalsChanged: string[] = [],
  contractsRun: string[] = [],
): ResearchEvidence {
  return { evidenceOrigin, goalsChanged, contractsRun, boundary: "" };
}

function ledger(...records: Record<string, unknown>[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

const empty: ResearchStats = {
  executed: 0,
  sourceRead: 0,
  reasoningOnly: 0,
  noEvidence: 0,
  goalsStale: 0,
  reasoningStreak: 0,
  openContracts: 0,
  missingBoundary: 0,
};

describe("computeResearchStats", () => {
  it("returns zeros for no history and an empty ledger", () => {
    expect(computeResearchStats([], "")).toEqual(empty);
  });

  it("counts iterations by evidence origin", () => {
    const stats = computeResearchStats(
      [
        evidence("executed", ["G1"]),
        evidence("reasoning_only", ["G1"]),
        evidence("executed", ["G2"]),
        evidence("source_read", ["G1"]),
        evidence("none", ["G1"]),
        evidence("executed", ["G1"]),
      ],
      "",
    );
    expect(stats).toMatchObject({
      executed: 3,
      sourceRead: 1,
      reasoningOnly: 1,
      noEvidence: 1,
    });
  });

  it("counts trailing iterations with no goal change as goals stale", () => {
    const stats = computeResearchStats(
      [
        evidence("executed", []),
        evidence("executed", ["G1"]),
        evidence("executed", []),
        evidence("source_read", []),
      ],
      "",
    );
    expect(stats.goalsStale).toBe(2);
  });

  it("counts trailing reasoning_only iterations as the reasoning streak", () => {
    const stats = computeResearchStats(
      [
        evidence("reasoning_only", ["G1"]),
        evidence("executed", ["G1"]),
        evidence("reasoning_only", ["G1"]),
        evidence("reasoning_only", ["G1"]),
      ],
      "",
    );
    expect(stats.reasoningStreak).toBe(2);
    expect(stats.reasoningOnly).toBe(3);
  });

  it("counts contract records that were not run or reframed as open", () => {
    const stats = computeResearchStats(
      [evidence("executed", ["G1"], ["c1"])],
      ledger(
        { id: "c1", type: "contract", claim: "run c1", boundary: "b" },
        { id: "c2", type: "contract", claim: "run c2", boundary: "b" },
        { id: "c3", type: "contract", claim: "run c3", boundary: "b" },
        { id: "r1", claim: "claim", boundary: "b" },
        { id: "r2", claim: "drop c3", reframes: "c3", boundary: "b" },
        { id: "c4", type: "contract", claim: "run c4", boundary: "b" },
      ),
    );
    expect(stats.openContracts).toBe(2);
  });

  it("counts records without a non-empty string boundary", () => {
    const stats = computeResearchStats(
      [],
      ledger(
        { id: "r1", claim: "a", boundary: "only warm cache" },
        { id: "r2", claim: "b" },
        { id: "r3", claim: "c", boundary: "" },
        { id: "r4", claim: "d", boundary: "   " },
        { id: "r5", claim: "e", boundary: 3 },
      ),
    );
    expect(stats.missingBoundary).toBe(4);
  });

  it("skips blank and unparseable ledger lines", () => {
    const stats = computeResearchStats(
      [],
      `\n${ledger({ id: "r1", claim: "a" })}not json\n`,
    );
    expect(stats.missingBoundary).toBe(1);
  });
});

describe("detectStall", () => {
  it("does not fire below three iterations", () => {
    expect(
      detectStall({ ...empty, goalsStale: 2, reasoningStreak: 2 }),
    ).toEqual([]);
  });

  it("fires the goals signal at three stale iterations", () => {
    expect(detectStall({ ...empty, goalsStale: 3 })).toEqual(["goals"]);
  });

  it("fires the reasoning signal at three reasoning_only iterations", () => {
    expect(detectStall({ ...empty, reasoningStreak: 3 })).toEqual([
      "reasoning",
    ]);
  });

  it("fires both signals together", () => {
    expect(
      detectStall({ ...empty, goalsStale: 3, reasoningStreak: 3 }),
    ).toEqual(["goals", "reasoning"]);
  });

  it("re-fires every three further iterations of the same streak", () => {
    expect(detectStall({ ...empty, goalsStale: 4 })).toEqual([]);
    expect(detectStall({ ...empty, goalsStale: 5 })).toEqual([]);
    expect(detectStall({ ...empty, goalsStale: 6 })).toEqual(["goals"]);
  });
});

describe("formatResearchStats", () => {
  const stats: ResearchStats = {
    ...empty,
    executed: 3,
    reasoningOnly: 1,
    goalsStale: 2,
    openContracts: 4,
    missingBoundary: 1,
  };

  it("formats the full stats line", () => {
    expect(formatResearchStats(stats)).toBe(
      "exec 3 · reason 1 · goals stale 2 · open contracts 4 · no boundary 1",
    );
  });

  it("returns compact segments for narrow displays", () => {
    expect(researchStatsSegments(stats, true)).toEqual([
      "exec 3",
      "reason 1",
      "stale 2",
      "contracts 4",
      "no boundary 1",
    ]);
    expect(researchStatsSegments(stats, false).join(" · ")).toBe(
      formatResearchStats(stats),
    );
  });
});

describe("readResearchHistory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gnhf-research-stats-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty history when the log does not exist", () => {
    expect(readResearchHistory(join(dir, "missing.log"))).toEqual([]);
  });

  it("rebuilds evidence from iteration:end events in order", () => {
    const logPath = join(dir, "gnhf.log");
    writeFileSync(
      logPath,
      [
        JSON.stringify({ event: "run:start", runId: "r" }),
        JSON.stringify({
          event: "iteration:end",
          iteration: 1,
          evidenceOrigin: "executed",
          goalsChanged: ["G1"],
          contractsRun: ["c1"],
          boundary: "b1",
        }),
        "not json",
        JSON.stringify({ event: "iteration:end", iteration: 2 }),
        JSON.stringify({
          event: "iteration:end",
          iteration: 3,
          evidenceOrigin: "reasoning_only",
          goalsChanged: "G2",
          contractsRun: [1, "c2"],
        }),
        "",
      ].join("\n"),
      "utf-8",
    );

    expect(readResearchHistory(logPath)).toEqual([
      {
        iteration: 1,
        evidenceOrigin: "executed",
        goalsChanged: ["G1"],
        contractsRun: ["c1"],
        boundary: "b1",
      },
      {
        iteration: 3,
        evidenceOrigin: "reasoning_only",
        goalsChanged: [],
        contractsRun: ["c2"],
        boundary: "",
      },
    ]);
  });

  it("keeps the last event for a repeated iteration number", () => {
    const logPath = join(dir, "gnhf.log");
    writeFileSync(
      logPath,
      [
        JSON.stringify({
          event: "iteration:end",
          iteration: 1,
          evidenceOrigin: "executed",
          goalsChanged: [],
          contractsRun: [],
          boundary: "",
        }),
        JSON.stringify({
          event: "iteration:end",
          iteration: 1,
          evidenceOrigin: "source_read",
          goalsChanged: [],
          contractsRun: [],
          boundary: "",
        }),
      ].join("\n"),
      "utf-8",
    );

    expect(
      readResearchHistory(logPath).map((entry) => entry.evidenceOrigin),
    ).toEqual(["source_read"]);
  });
});
