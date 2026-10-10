export const WORKFLOWS = ["default", "research"] as const;

export type Workflow = (typeof WORKFLOWS)[number];

export interface ResearchEvidence {
  evidenceOrigin: string;
  goalsChanged: string[];
  contractsRun: string[];
  boundary: string;
}

export function isWorkflow(value: string): value is Workflow {
  return (WORKFLOWS as readonly string[]).includes(value);
}

export function parseWorkflow(value: string): Workflow {
  if (!isWorkflow(value)) {
    throw new Error(`must be one of: ${WORKFLOWS.join(" or ")}`);
  }
  return value;
}

function orNone(value: string): string {
  return value.length > 0 ? value : "none";
}

export function formatResearchEvidence(evidence: ResearchEvidence): string {
  return [
    `**Evidence:** ${orNone(evidence.evidenceOrigin)}.`,
    `Goals changed: ${orNone(evidence.goalsChanged.join(", "))}.`,
    `Contracts run: ${orNone(evidence.contractsRun.join(", "))}.`,
    `Boundary: ${orNone(evidence.boundary.trim())}`,
  ].join(" ");
}
