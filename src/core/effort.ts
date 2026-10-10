export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const DEFAULT_EFFORT: EffortLevel = "medium";

export const EFFORT_LEVEL_LIST = `${EFFORT_LEVELS.slice(0, -1).join(", ")}, or ${EFFORT_LEVELS[EFFORT_LEVELS.length - 1]}`;

export function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(value)
  );
}
