#!/usr/bin/env node

// Stands in for the `claude` CLI. GNHF_MOCK_CLAUDE_MODE picks the stream
// shape, so one fixture covers every combination: the failure shapes the error
// paths need, plus successful runs that first announce the included usage
// window is spent and requests are being billed to extra usage.

import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const mode = process.env.GNHF_MOCK_CLAUDE_MODE ?? "success";
const args = process.argv.slice(2);
const promptIndex = args.indexOf("-p");
const prompt = promptIndex === -1 ? "" : (args[promptIndex + 1] ?? "");
const schemaIndex = args.indexOf("--json-schema");
const schema = schemaIndex === -1 ? "" : (args[schemaIndex + 1] ?? "");
const researchOutput = schema.includes("evidence_origin")
  ? {
      evidence_origin:
        process.env.GNHF_MOCK_CLAUDE_EVIDENCE_ORIGIN ?? "executed",
      goals_changed: ["G1"],
      contracts_run: [],
      boundary: "mock boundary",
    }
  : {};

function appendLog(event, details = {}) {
  const logPath = process.env.GNHF_MOCK_CLAUDE_LOG_PATH;
  if (!logPath) return;
  appendFileSync(
    logPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event, ...details })}\n`,
    "utf-8",
  );
}

function writeResult(summary) {
  const usage = {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 1,
    cache_creation_input_tokens: 0,
  };
  process.stdout.write(
    `${JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        usage,
        content: [{ type: "text", text: "Mock agent is working." }],
      },
    })}\n${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0,
      usage,
      structured_output: {
        success: true,
        summary,
        key_changes_made: ["README.md"],
        key_learnings: ["mock claude completed successfully"],
        ...researchOutput,
      },
    })}\n`,
  );
}

function applyWorkspaceChange() {
  const readmePath = join(process.cwd(), "README.md");
  if (process.env.GNHF_MOCK_CLAUDE_PRECOMMIT_REPAIR === "1") {
    const current = readFileSync(readmePath, "utf-8");
    if (prompt.includes("pre-commit hook failed")) {
      writeFileSync(
        readmePath,
        current.replace("FORBIDDEN", "fixed by mock agent"),
        "utf-8",
      );
      appendLog("workspace:repaired");
      return;
    }
    appendFileSync(readmePath, "FORBIDDEN\n", "utf-8");
    appendLog("workspace:changed", { marker: "FORBIDDEN" });
    return;
  }

  const marker = `- mock change ${randomUUID()}\n`;
  appendFileSync(readmePath, marker, "utf-8");
  appendLog("workspace:changed", { marker: marker.trim() });
}

function applyLedgerChange() {
  const ledgerMode = process.env.GNHF_MOCK_CLAUDE_LEDGER;
  if (!ledgerMode) return;
  const ledgerMatch = /^Ledger file: (.+)$/m.exec(prompt);
  const iterationMatch = /This is iteration (\d+)\./.exec(prompt);
  if (!ledgerMatch || !iterationMatch) return;
  const ledgerPath = ledgerMatch[1];
  const iteration = Number(iterationMatch[1]);
  const current = readFileSync(ledgerPath, "utf-8");
  appendLog("ledger:seen", { iteration, ledgerPath, content: current });
  if (ledgerMode === "rewrite-iteration-2" && iteration === 2) {
    const lines = current.split("\n");
    const first = JSON.parse(lines[0]);
    lines[0] = JSON.stringify({ ...first, claim: "rewritten by mock" });
    writeFileSync(ledgerPath, lines.join("\n"), "utf-8");
    return;
  }
  appendFileSync(
    ledgerPath,
    `${JSON.stringify({
      id: `r${iteration}`,
      iteration,
      evidence_origin: "executed",
      claim: `mock claim ${iteration}`,
    })}\n`,
    "utf-8",
  );
}

function shouldHang() {
  if (prompt.includes("slow cleanup")) return true;
  const hang = process.env.GNHF_MOCK_CLAUDE_HANG_ITERATION;
  return !!hang && prompt.includes(`This is iteration ${hang}.`);
}

appendLog("spawn", { args, prompt });

if (mode === "no-output") {
  process.exit(1);
}

if (mode === "stderr-error") {
  process.stderr.write("Invalid API key - please run /login\n");
  process.exit(1);
}

if (mode === "stdout-error") {
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Invalid model name: claude-nonexistent-5",
    })}\n`,
  );
  process.exit(1);
}

if (mode === "overage-elapsed-reset" || mode === "overage-no-reset") {
  // Real work for the orchestrator to commit, so the extra-usage decision is
  // taken after a genuinely successful, committed iteration.
  writeFileSync(
    join(process.cwd(), `overage-${randomUUID()}.txt`),
    "billed to extra usage\n",
    "utf-8",
  );

  const rateLimitInfo = { status: "allowed", isUsingOverage: true };
  if (mode === "overage-elapsed-reset") {
    // An hour behind us: the included window has already come back.
    rateLimitInfo.resetsAt = Math.floor(Date.now() / 1000) - 3600;
  }

  process.stdout.write(
    `${JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: rateLimitInfo,
    })}\n`,
  );
  writeResult("did the work while billed to extra usage");
  process.exit(0);
}

appendLog("message:start", { prompt });

if (shouldHang()) {
  if (process.env.GNHF_MOCK_CLAUDE_DIRTY_BEFORE_HANG === "1") {
    applyWorkspaceChange();
  }
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      appendLog("signal", { signal });
      process.exit(143);
    });
  }
  setInterval(() => {}, 1_000);
} else {
  if (process.env.GNHF_MOCK_CLAUDE_NO_CHANGES !== "1") {
    applyWorkspaceChange();
  }
  applyLedgerChange();
  writeResult("mocked objective complete");
  process.exit(0);
}
