import {
  getCommitMessagePromptFields,
  type CommitMessageConfig,
} from "../core/commit-message.js";
import type { Workflow } from "../core/workflow.js";

const RESEARCH_OUTPUT_FIELDS = [
  "- evidence_origin: executed, source_read, reasoning_only, or none. executed means you ran code, a test, a benchmark or an experiment this iteration. source_read means your strongest evidence came from reading sources. reasoning_only means nothing was executed or read. none means this iteration made no claim",
  "- goals_changed: an array of the ids of goals whose state changed this iteration. use an empty array if none changed",
  "- contracts_run: an array of the ids of earlier registered next-study contracts that you executed this iteration. use an empty array if none",
  "- boundary: what this iteration's evidence does NOT show",
];

function buildResearchSection(runId: string): string {
  return `\n\n## Research Workflow

Each iteration continues this cycle. Keep the records in the files the objective names, such as a ledger, never in notes.md.

1. Re-anchor: read .gnhf/runs/${runId}/notes.md, the ledger, the next contracts registered by earlier iterations and any new user input before choosing what to do
2. Pick one study: record what was known before choosing, the alternatives you considered and why you chose this one
3. Sources: read each source at a stated read depth (abstract, skimmed, full read, code read) and record the source with that depth
4. Execute one bounded study: run it with matched controls when possible. If nothing was executed, label the iteration source_read or reasoning_only, whichever is true
5. Evidence records: each claim states its evidence origin and its boundary, which is what the claim does NOT show
6. Cross-goal return: state for every goal what changed and what stays open, and list the changed goals in goals_changed
7. Next contracts: register the next studies, each with what would show it worked, and list the contracts executed this iteration in contracts_run
8. Never delete: reframe an earlier record by adding a new record. Never edit or remove earlier records

Repetition is a reason to change approach, not to stop.`;
}

export function buildIterationPrompt(params: {
  n: number;
  runId: string;
  prompt: string;
  stopWhen?: string;
  commitMessage?: CommitMessageConfig;
  deadline?: string;
  finalIteration?: { reason: string; wrapUpOnly: boolean };
  workflow?: Workflow;
}): string {
  const research = params.workflow === "research";
  const outputFields = [
    "- success: whether you were able to make a meaningful contribution that got us closer towards the objective. setting this to false means any code change you made should be discarded. A complete no-op iteration (no file changes AND no new meaningful learnings worth recording) is not a success - set success=false so the run can halt rather than spin on no-op iterations",
    "- summary: a concise one-sentence summary of the accomplishment in this iteration",
    "- key_changes_made: an array of descriptions for key changes you made. don't group this by file - group by logical units of work. don't describe activities - describe material outcomes",
    "- key_learnings: an array of new learnings that were surprising, weren't captured by previous notes and would be informative for future iterations",
  ];

  for (const field of getCommitMessagePromptFields(params.commitMessage)) {
    const constraints = [
      field.allowed === undefined
        ? null
        : `allowed values: ${field.allowed.join(", ")}`,
      `default: ${JSON.stringify(field.default)}`,
    ].filter((value): value is string => value !== null);
    outputFields.push(
      `- ${field.name}: ${field.description}. ${constraints.join("; ")}`,
    );
  }

  if (research) {
    outputFields.push(...RESEARCH_OUTPUT_FIELDS);
  }

  if (params.stopWhen !== undefined) {
    outputFields.push(
      "- should_fully_stop: set to true ONLY when the stop condition below is fully met and the entire loop should end. default to false",
    );
  }

  const stopConditionSection =
    params.stopWhen !== undefined
      ? `\n\n## Stop Condition\n\nThe user has configured a condition to end the loop: ${params.stopWhen}\nIf this condition is fully met after this iteration's work, set should_fully_stop=true in your output. Otherwise set it to false.`
      : "";

  const deadlineSection =
    params.deadline !== undefined
      ? `\n\n## Deadline\n\nThe run ends at ${params.deadline} local time. Once it passes, gnhf runs one final wrap-up iteration and stops. Size each iteration so it can finish before then.`
      : "";

  const finalIterationSection =
    params.finalIteration === undefined
      ? ""
      : params.finalIteration.wrapUpOnly
        ? `\n\n## Final Iteration\n\nThis is the final iteration of the run: ${params.finalIteration.reason}. Do not start new work. Finish and verify anything left half-done so the tree is in a state worth committing, record what is complete and what is not, and post the final summary or handoff the objective asks for. gnhf stops after this iteration whatever its outcome.`
        : `\n\n## Final Iteration\n\nThis is the final iteration of the run: ${params.finalIteration.reason}. Choose work you can finish and verify in this iteration, then post the final summary or handoff the objective asks for before you submit. gnhf stops after this iteration.`;

  const researchSection = research ? buildResearchSection(params.runId) : "";

  return `You are working autonomously towards an objective given below.
This is iteration ${params.n}. Each iteration aims to make an incremental step forward, not to complete the entire objective.

## Instructions

1. Read .gnhf/runs/${params.runId}/notes.md first to understand what has been done in previous iterations. Do NOT write to or modify notes.md - it is maintained automatically by the gnhf orchestrator
2. Identify the next smallest logical unit of work that's individually verifiable and would make incremental progress towards the objective, and treat that as the scope of this iteration
3. If you attempted a solution and it didn't end up moving the needle on the objective, document learnings and record success=false, then conclude the iteration rather than continuously pivoting
4. If you made code changes, run build/tests/linters/formatters if available to validate your work. Do NOT make any git commits - that will be handled automatically by the gnhf orchestrator
5. If you started any long-running background processes (dev servers, browsers, watchers, Electron, etc.), stop them before finishing the iteration
6. Only submit the final JSON object after the result is final: your work is complete, validation is done, and you have stopped any background processes you started

## Output

${outputFields.join("\n")}${researchSection}${stopConditionSection}${deadlineSection}${finalIterationSection}

## Objective

${params.prompt}`;
}
