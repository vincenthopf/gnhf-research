import {
  buildAgentOutputSchema,
  type Agent,
  type AgentOutputCommitField,
} from "./types.js";
import { ClaudeAgent } from "./claude.js";
import type { EffortLevel } from "../effort.js";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

export interface CreateAgentOptions {
  includeStopField: boolean;
  commitFields?: AgentOutputCommitField[];
  model?: string;
  effort: EffortLevel;
}

function setsModel(args: string[] | undefined): boolean {
  return (args ?? []).some(
    (arg) => arg === "--model" || arg.startsWith("--model="),
  );
}

export function createAgent(
  pathOverride: string | undefined,
  agentArgsOverride: string[] | undefined,
  options: CreateAgentOptions,
): Agent {
  return new ClaudeAgent({
    bin: pathOverride,
    extraArgs: agentArgsOverride,
    model:
      options.model ??
      (setsModel(agentArgsOverride) ? undefined : DEFAULT_CLAUDE_MODEL),
    effort: options.effort,
    schema: buildAgentOutputSchema({
      includeStopField: options.includeStopField,
      commitFields: options.commitFields,
    }),
  });
}
