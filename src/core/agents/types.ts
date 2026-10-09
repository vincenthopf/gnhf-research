export interface AgentOutput {
  success: boolean;
  summary: string;
  key_changes_made: unknown;
  key_learnings: unknown;
  should_fully_stop?: boolean;
  evidence_origin?: EvidenceOrigin;
  goals_changed?: unknown;
  contracts_run?: unknown;
  boundary?: string;
}

export const EVIDENCE_ORIGINS = [
  "executed",
  "source_read",
  "reasoning_only",
  "none",
] as const;

export type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number];

export interface AgentOutputSchema {
  type: "object";
  additionalProperties: false;
  properties: Record<
    string,
    { type: string; items?: { type: string }; enum?: string[] }
  >;
  required: string[];
}

export interface AgentOutputCommitField {
  name: string;
  allowed?: string[];
}

export function buildAgentOutputSchema(opts: {
  includeStopField: boolean;
  commitFields?: AgentOutputCommitField[];
  research?: boolean;
}): AgentOutputSchema {
  const properties: AgentOutputSchema["properties"] = {
    success: { type: "boolean" },
    summary: { type: "string" },
    key_changes_made: { type: "array", items: { type: "string" } },
    key_learnings: { type: "array", items: { type: "string" } },
  };
  const required = ["success", "summary", "key_changes_made", "key_learnings"];
  for (const field of opts.commitFields ?? []) {
    properties[field.name] = {
      type: "string",
      ...(field.allowed === undefined ? {} : { enum: field.allowed }),
    };
    required.push(field.name);
  }
  if (opts.research) {
    properties.evidence_origin = {
      type: "string",
      enum: [...EVIDENCE_ORIGINS],
    };
    properties.goals_changed = { type: "array", items: { type: "string" } };
    properties.contracts_run = { type: "array", items: { type: "string" } };
    properties.boundary = { type: "string" };
    required.push(
      "evidence_origin",
      "goals_changed",
      "contracts_run",
      "boundary",
    );
  }
  if (opts.includeStopField) {
    properties.should_fully_stop = { type: "boolean" };
    required.push("should_fully_stop");
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

export interface TokenUsage {
  // Adapters must keep these buckets mutually exclusive so totals can sum
  // input, output, cache-read, and cache-write usage without double-counting.
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  // True when the agent could not source authoritative usage from the model
  // and the numbers are heuristic estimates.
  estimated?: boolean;
}

// The provider served this iteration from paid extra usage (Claude "usage
// credits") because the included window was exhausted. Unlike a rejection the
// request was still served, so the iteration's work is real and is kept; only
// the next one waits for the window to reset. Reported through `onOverage`
// rather than the result, since an iteration can spend the window and still
// end in an error.
export interface UsageOverage {
  resumeAt: Date | null;
}

export interface AgentResult {
  output: AgentOutput;
  usage: TokenUsage;
}

export class PermanentAgentError extends Error {
  detail: string;

  constructor(message: string, detail: string) {
    super(message, { cause: detail });
    this.name = "PermanentAgentError";
    this.detail = detail;
  }
}

// The provider rejected the request because a usage window is exhausted
// (e.g. the Claude subscription 5-hour window). Unlike retryable errors this
// carries the provider-reported reset time so the orchestrator can wait for
// the window to reset instead of burning the consecutive-failure budget.
export class RateLimitAgentError extends Error {
  detail: string;
  resumeAt: Date | null;

  constructor(message: string, detail: string, resumeAt: Date | null) {
    super(message, { cause: detail });
    this.name = "RateLimitAgentError";
    this.detail = detail;
    this.resumeAt = resumeAt;
  }
}

export type OnUsage = (usage: TokenUsage) => void;

export type OnMessage = (text: string) => void;

// Reported out-of-band because overage is orthogonal to how the iteration
// ends: the window can be spent on an attempt that later fails, and the
// orchestrator must still wait rather than buy the next iteration. `null`
// means the provider reported the window recovered.
export type OnOverage = (overage: UsageOverage | null) => void;

export interface AgentRunOptions {
  /** Opt-in provider model override for the current iteration. */
  model?: string;
  onUsage?: OnUsage;
  onMessage?: OnMessage;
  onOverage?: OnOverage;
  signal?: AbortSignal;
  logPath?: string;
}

export interface Agent {
  name: string;
  close?(): Promise<void> | void;
  run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult>;
}
