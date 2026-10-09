import { existsSync, readFileSync } from "node:fs";
import type { ResearchEvidence } from "./workflow.js";

export interface ResearchStats {
  executed: number;
  sourceRead: number;
  reasoningOnly: number;
  noEvidence: number;
  goalsStale: number;
  reasoningStreak: number;
  openContracts: number;
  missingBoundary: number;
}

export interface ResearchOutcome extends ResearchEvidence {
  success: boolean;
}

export interface ResearchHistoryEntry extends ResearchOutcome {
  iteration: number;
}

export type StallSignal = "goals" | "reasoning";

export interface StallReport {
  signal: StallSignal;
  iterations: number;
}

export const STALL_THRESHOLD = 3;

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseObject(line: string): Record<string, unknown> | undefined {
  if (line.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function readResearchHistory(logPath: string): ResearchHistoryEntry[] {
  if (!existsSync(logPath)) return [];
  const byIteration = new Map<number, ResearchHistoryEntry>();
  for (const line of readFileSync(logPath, "utf-8").split("\n")) {
    const event = parseObject(line);
    if (
      event?.event !== "iteration:end" ||
      typeof event.evidenceOrigin !== "string" ||
      !Number.isInteger(event.iteration)
    ) {
      continue;
    }
    const iteration = event.iteration as number;
    byIteration.delete(iteration);
    byIteration.set(iteration, {
      iteration,
      success: event.success === true,
      evidenceOrigin: event.evidenceOrigin,
      goalsChanged: strings(event.goalsChanged),
      contractsRun: strings(event.contractsRun),
      boundary: typeof event.boundary === "string" ? event.boundary : "",
    });
  }
  return [...byIteration.values()];
}

function trailingCount(
  history: ResearchOutcome[],
  matches: (entry: ResearchOutcome) => boolean,
): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0 && matches(history[i]!); i--) {
    count++;
  }
  return count;
}

export function computeResearchStats(
  history: ResearchOutcome[],
  ledger: string,
): ResearchStats {
  const origins = history.map((entry) => entry.evidenceOrigin);
  const count = (origin: string) =>
    origins.filter((value) => value === origin).length;
  const records = ledger
    .split("\n")
    .map(parseObject)
    .filter((record) => record !== undefined);
  const contractsRun = new Set(
    history
      .filter((entry) => entry.success)
      .flatMap((entry) => entry.contractsRun),
  );
  const reframed = new Set(
    records
      .map((record) => record.reframes)
      .filter((id): id is string => typeof id === "string"),
  );
  return {
    executed: count("executed"),
    sourceRead: count("source_read"),
    reasoningOnly: count("reasoning_only"),
    noEvidence: count("none"),
    goalsStale: trailingCount(
      history,
      (entry) => !entry.success || entry.goalsChanged.length === 0,
    ),
    reasoningStreak: trailingCount(
      history,
      (entry) => entry.evidenceOrigin === "reasoning_only",
    ),
    openContracts: records.filter(
      (record) =>
        record.type === "contract" &&
        typeof record.id === "string" &&
        !contractsRun.has(record.id) &&
        !reframed.has(record.id),
    ).length,
    missingBoundary: records.filter(
      (record) =>
        record.type !== "contract" &&
        record.observer === undefined &&
        !(typeof record.id === "string" && reframed.has(record.id)) &&
        (typeof record.boundary !== "string" ||
          record.boundary.trim().length === 0),
    ).length,
  };
}

function fires(streak: number): boolean {
  return streak > 0 && streak % STALL_THRESHOLD === 0;
}

export function detectStall(stats: ResearchStats): StallSignal[] {
  return [
    ...(fires(stats.goalsStale) ? (["goals"] as const) : []),
    ...(fires(stats.reasoningStreak) ? (["reasoning"] as const) : []),
  ];
}

export function stallReports(stats: ResearchStats): StallReport[] {
  return detectStall(stats).map((signal) => ({
    signal,
    iterations: signal === "goals" ? stats.goalsStale : stats.reasoningStreak,
  }));
}

export function researchStatsSegments(
  stats: ResearchStats,
  compact: boolean,
): string[] {
  return [
    `exec ${stats.executed}`,
    `reason ${stats.reasoningOnly}`,
    `${compact ? "stale" : "goals stale"} ${stats.goalsStale}`,
    `${compact ? "contracts" : "open contracts"} ${stats.openContracts}`,
    `no boundary ${stats.missingBoundary}`,
  ];
}

export function formatResearchStats(stats: ResearchStats): string {
  return researchStatsSegments(stats, false).join(" · ");
}
