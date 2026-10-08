import {
  buildAgentOutputSchema,
  type Agent,
  type AgentOutputCommitField,
} from "./types.js";
import { ClaudeAgent } from "./claude.js";

export interface CreateAgentOptions {
  includeStopField: boolean;
  commitFields?: AgentOutputCommitField[];
  model?: string;
}

export function createAgent(
  pathOverride: string | undefined,
  agentArgsOverride: string[] | undefined,
  options: CreateAgentOptions,
): Agent {
  return new ClaudeAgent({
    bin: pathOverride,
    extraArgs: agentArgsOverride,
    model: options.model,
    schema: buildAgentOutputSchema({
      includeStopField: options.includeStopField,
      commitFields: options.commitFields,
    }),
  });
}
