import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isLinePrefix,
  longestValidPrefix,
  validateLedger,
  writeRejectedLedger,
} from "./ledger.js";

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

const r1 = line({
  id: "r1",
  iteration: 1,
  evidence_origin: "executed",
  claim: "the cache halves cold start",
});
const r2 = line({
  id: "r2",
  iteration: 2,
  evidence_origin: "source_read",
  claim: "the paper reports the same effect",
  boundary: "one machine only",
  sources: ["paper.pdf"],
  extra: { anything: true },
});

describe("validateLedger", () => {
  it("accepts an empty ledger", () => {
    expect(validateLedger("", "")).toEqual({ valid: true, records: 0 });
  });

  it("accepts appended records with optional and unknown fields", () => {
    expect(validateLedger(r1, r1 + r2)).toEqual({ valid: true, records: 2 });
  });

  it("accepts a ledger the agent left unchanged", () => {
    expect(validateLedger(r1, r1)).toEqual({ valid: true, records: 1 });
  });

  it("ignores blank lines", () => {
    expect(validateLedger(r1, `${r1}\n  \n${r2}`)).toEqual({
      valid: true,
      records: 2,
    });
  });

  it("accepts a last record without a trailing newline", () => {
    expect(validateLedger(r1, r1 + r2.trimEnd())).toEqual({
      valid: true,
      records: 2,
    });
  });

  it("rejects a changed earlier line and names its id", () => {
    const changed = line({
      id: "r1",
      iteration: 1,
      evidence_origin: "executed",
      claim: "rewritten",
    });
    expect(validateLedger(r1 + r2, changed + r2)).toEqual({
      valid: false,
      reason: "line 1 changed (id r1)",
    });
  });

  it("rejects a change to the second line", () => {
    const changed = line({ ...JSON.parse(r2), claim: "rewritten" });
    expect(validateLedger(r1 + r2, r1 + changed)).toEqual({
      valid: false,
      reason: "line 2 changed (id r2)",
    });
  });

  it("rejects a deleted earlier line", () => {
    expect(validateLedger(r1 + r2, r1)).toEqual({
      valid: false,
      reason: "line 2 deleted (id r2)",
    });
  });

  it("rejects an emptied ledger", () => {
    expect(validateLedger(r1, "")).toEqual({
      valid: false,
      reason: "line 1 deleted (id r1)",
    });
  });

  it("rejects text joined onto a last line that had no trailing newline", () => {
    const previous = r1.trimEnd();
    expect(validateLedger(previous, `${previous}x\n`)).toEqual({
      valid: false,
      reason: "line 1 changed (id r1)",
    });
  });

  it("rejects a line that is not JSON", () => {
    expect(validateLedger(r1, `${r1}{not json\n`)).toEqual({
      valid: false,
      reason: "line 2 is not valid JSON",
    });
  });

  it("rejects a line that is not a JSON object", () => {
    expect(validateLedger("", "[1,2]\n")).toEqual({
      valid: false,
      reason: "line 1 is not a JSON object",
    });
    expect(validateLedger("", "null\n")).toEqual({
      valid: false,
      reason: "line 1 is not a JSON object",
    });
  });

  it("rejects a missing or empty id", () => {
    expect(
      validateLedger(
        "",
        line({ iteration: 1, evidence_origin: "none", claim: "c" }),
      ),
    ).toEqual({
      valid: false,
      reason: 'line 1 field "id" must be a non-empty string',
    });
    expect(
      validateLedger(
        "",
        line({ id: "", iteration: 1, evidence_origin: "none", claim: "c" }),
      ),
    ).toEqual({
      valid: false,
      reason: 'line 1 field "id" must be a non-empty string',
    });
  });

  it("rejects a non-integer iteration", () => {
    expect(
      validateLedger(
        "",
        line({ id: "a", iteration: 1.5, evidence_origin: "none", claim: "c" }),
      ),
    ).toEqual({
      valid: false,
      reason: 'line 1 field "iteration" must be an integer (id a)',
    });
    expect(
      validateLedger(
        "",
        line({ id: "a", iteration: "1", evidence_origin: "none", claim: "c" }),
      ),
    ).toEqual({
      valid: false,
      reason: 'line 1 field "iteration" must be an integer (id a)',
    });
  });

  it("rejects an unknown evidence_origin", () => {
    expect(
      validateLedger(
        "",
        line({ id: "a", iteration: 1, evidence_origin: "vibes", claim: "c" }),
      ),
    ).toEqual({
      valid: false,
      reason:
        'line 1 field "evidence_origin" must be one of executed, source_read, reasoning_only, none (id a)',
    });
  });

  it("rejects a missing or blank claim", () => {
    expect(
      validateLedger(
        "",
        line({ id: "a", iteration: 1, evidence_origin: "none" }),
      ),
    ).toEqual({
      valid: false,
      reason: 'line 1 field "claim" must be a non-empty string (id a)',
    });
    expect(
      validateLedger(
        "",
        line({ id: "a", iteration: 1, evidence_origin: "none", claim: "  " }),
      ),
    ).toEqual({
      valid: false,
      reason: 'line 1 field "claim" must be a non-empty string (id a)',
    });
  });

  it("rejects a non-string boundary but allows it to be missing", () => {
    expect(
      validateLedger(
        "",
        line({
          id: "a",
          iteration: 1,
          evidence_origin: "none",
          claim: "c",
          boundary: 3,
        }),
      ),
    ).toEqual({
      valid: false,
      reason: 'line 1 field "boundary" must be a string (id a)',
    });
  });

  it("rejects a duplicate id", () => {
    const dup = line({
      id: "r1",
      iteration: 2,
      evidence_origin: "none",
      claim: "again",
    });
    expect(validateLedger(r1, r1 + dup)).toEqual({
      valid: false,
      reason: "line 2 duplicate id r1 (first on line 1)",
    });
  });

  it("accepts reframes that names an earlier record", () => {
    const reframe = line({
      id: "r3",
      iteration: 3,
      evidence_origin: "reasoning_only",
      claim: "r1 only holds on cold caches",
      reframes: "r1",
    });
    expect(validateLedger(r1 + r2, r1 + r2 + reframe)).toEqual({
      valid: true,
      records: 3,
    });
  });

  it("rejects reframes that does not name an earlier record", () => {
    const reframe = line({
      id: "r3",
      iteration: 3,
      evidence_origin: "reasoning_only",
      claim: "c",
      reframes: "r9",
    });
    expect(validateLedger(r1, r1 + reframe)).toEqual({
      valid: false,
      reason:
        'line 2 field "reframes" must be the id of an earlier record (id r3)',
    });
  });

  it("reports the first problem when several exist", () => {
    expect(validateLedger(r1, `${r1}oops\n[]\n`)).toEqual({
      valid: false,
      reason: "line 2 is not valid JSON",
    });
  });
});

describe("longestValidPrefix", () => {
  it("keeps every complete valid line", () => {
    expect(longestValidPrefix(r1 + r2)).toBe(r1 + r2);
  });

  it("drops a partial last line", () => {
    expect(longestValidPrefix(`${r1}{"id":"r2","itera`)).toBe(r1);
  });

  it("drops a valid last line that has no trailing newline", () => {
    expect(longestValidPrefix(r1 + r2.trimEnd())).toBe(r1);
  });

  it("stops at the first invalid line", () => {
    expect(longestValidPrefix(`${r1}oops\n${r2}`)).toBe(r1);
    expect(longestValidPrefix("oops\n")).toBe("");
  });
});

describe("isLinePrefix", () => {
  it("accepts whole leading lines of the content", () => {
    expect(isLinePrefix("", r1 + r2)).toBe(true);
    expect(isLinePrefix(r1, r1 + r2)).toBe(true);
    expect(isLinePrefix(r1 + r2, r1 + r2)).toBe(true);
  });

  it("rejects a cut inside a line or different text", () => {
    expect(isLinePrefix(r1.slice(0, 5), r1 + r2)).toBe(false);
    expect(isLinePrefix(r2, r1 + r2)).toBe(false);
    expect(isLinePrefix(r1 + r2, r1)).toBe(false);
  });
});

describe("writeRejectedLedger", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it("creates the ledger directory and never overwrites an earlier file", () => {
    const runDir = mkdtempSync(join(tmpdir(), "gnhf-ledger-rejected-"));
    dirs.push(runDir);

    const first = writeRejectedLedger(runDir, "rejected-iteration-1", "a");
    const second = writeRejectedLedger(runDir, "rejected-iteration-1", "b");
    const third = writeRejectedLedger(runDir, "rejected-iteration-1", "c");

    expect(first).toBe(join(runDir, "ledger", "rejected-iteration-1.jsonl"));
    expect(second).toBe(join(runDir, "ledger", "rejected-iteration-1-2.jsonl"));
    expect(third).toBe(join(runDir, "ledger", "rejected-iteration-1-3.jsonl"));
    expect(readFileSync(first, "utf-8")).toBe("a");
    expect(readFileSync(second, "utf-8")).toBe("b");
    expect(readFileSync(third, "utf-8")).toBe("c");
  });

  it("keeps a file that already exists before the first write", () => {
    const runDir = mkdtempSync(join(tmpdir(), "gnhf-ledger-rejected-"));
    dirs.push(runDir);
    writeRejectedLedger(runDir, "x", "seed");
    writeFileSync(join(runDir, "ledger", "x.jsonl"), "kept", "utf-8");

    const path = writeRejectedLedger(runDir, "x", "new");

    expect(path).toBe(join(runDir, "ledger", "x-2.jsonl"));
    expect(readFileSync(join(runDir, "ledger", "x.jsonl"), "utf-8")).toBe(
      "kept",
    );
  });
});
