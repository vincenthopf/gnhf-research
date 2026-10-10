import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LEDGER_EVIDENCE_ORIGINS = [
  "executed",
  "source_read",
  "reasoning_only",
  "none",
] as const;

export type LedgerValidation =
  | { valid: true; records: number }
  | { valid: false; reason: string };

export function defaultLedgerPath(runDir: string): string {
  return join(runDir, "ledger", "records.jsonl");
}

export function validatedLedgerPath(runDir: string): string {
  return join(runDir, "ledger", "validated.jsonl");
}

export function writeRejectedLedger(
  runDir: string,
  name: string,
  content: string,
): string {
  const dir = join(runDir, "ledger");
  mkdirSync(dir, { recursive: true });
  for (let suffix = 1; ; suffix++) {
    const path = join(
      dir,
      suffix === 1 ? `${name}.jsonl` : `${name}-${suffix}.jsonl`,
    );
    try {
      writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function isLinePrefix(prefix: string, content: string): boolean {
  return (
    content.startsWith(prefix) &&
    (prefix.length === 0 ||
      prefix.endsWith("\n") ||
      prefix.length === content.length)
  );
}

export function longestValidPrefix(content: string): string {
  const complete = content.slice(0, content.lastIndexOf("\n") + 1);
  const lines = complete.split("\n").slice(0, -1);
  const check = checkRecords(lines);
  const kept = check.valid ? lines : lines.slice(0, check.line - 1);
  return kept.map((line) => `${line}\n`).join("");
}

export function readLedger(ledgerPath: string): string {
  return existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf-8") : "";
}

function idSuffix(id: unknown): string {
  return typeof id === "string" && id.length > 0 ? ` (id ${id})` : "";
}

export function parseJsonObject(
  line: string,
): Record<string, unknown> | undefined {
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

function checkPrefix(previous: string, current: string): string | null {
  const before = previous.split("\n");
  const after = current.split("\n");
  if (before[before.length - 1] === "") before.pop();
  for (let i = 0; i < before.length; i++) {
    const old = before[i]!;
    if (
      i >= after.length ||
      (after[i] === "" && old !== "" && i === after.length - 1)
    ) {
      return `line ${i + 1} deleted${idSuffix(parseJsonObject(old)?.id)}`;
    }
    if (after[i] !== old) {
      return `line ${i + 1} changed${idSuffix(parseJsonObject(old)?.id)}`;
    }
  }
  return null;
}

function checkRecord(
  record: Record<string, unknown>,
  lineNumber: number,
  seen: Map<string, number>,
): string | null {
  const at = `line ${lineNumber}`;
  const { id } = record;
  if (typeof id !== "string" || id.length === 0) {
    return `${at} field "id" must be a non-empty string`;
  }
  const suffix = idSuffix(id);
  if (!Number.isInteger(record.iteration)) {
    return `${at} field "iteration" must be an integer${suffix}`;
  }
  if (
    !(LEDGER_EVIDENCE_ORIGINS as readonly unknown[]).includes(
      record.evidence_origin,
    )
  ) {
    return `${at} field "evidence_origin" must be one of ${LEDGER_EVIDENCE_ORIGINS.join(", ")}${suffix}`;
  }
  if (typeof record.claim !== "string" || record.claim.trim().length === 0) {
    return `${at} field "claim" must be a non-empty string${suffix}`;
  }
  if ("boundary" in record && typeof record.boundary !== "string") {
    return `${at} field "boundary" must be a string${suffix}`;
  }
  if (
    "reframes" in record &&
    (typeof record.reframes !== "string" || !seen.has(record.reframes))
  ) {
    return `${at} field "reframes" must be the id of an earlier record${suffix}`;
  }
  const firstLine = seen.get(id);
  if (firstLine !== undefined) {
    return `${at} duplicate id ${id} (first on line ${firstLine})`;
  }
  seen.set(id, lineNumber);
  return null;
}

type RecordsCheck =
  | { valid: true; records: number }
  | { valid: false; reason: string; line: number };

function checkRecords(lines: string[]): RecordsCheck {
  const seen = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    if (text.trim().length === 0) continue;
    const line = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { valid: false, reason: `line ${line} is not valid JSON`, line };
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        valid: false,
        reason: `line ${line} is not a JSON object`,
        line,
      };
    }
    const problem = checkRecord(parsed as Record<string, unknown>, line, seen);
    if (problem !== null) return { valid: false, reason: problem, line };
  }
  return { valid: true, records: seen.size };
}

export function validateLedger(
  previous: string,
  current: string,
): LedgerValidation {
  const prefixProblem = checkPrefix(previous, current);
  if (prefixProblem !== null) return { valid: false, reason: prefixProblem };
  const check = checkRecords(current.split("\n"));
  return check.valid ? check : { valid: false, reason: check.reason };
}
