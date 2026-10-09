import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { CommitMessageConfig } from "./commit-message.js";
import { normalizeCommitMessageConfig } from "./commit-message-config.js";
import { InvalidConfigError } from "./config-errors.js";
import {
  DEFAULT_EFFORT,
  EFFORT_LEVEL_LIST,
  isEffortLevel,
  type EffortLevel,
} from "./effort.js";

export const AGENT_NAMES = ["claude"] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

export interface Config {
  agentModel: Partial<Record<AgentName, string>>;
  agentPathOverride: Partial<Record<AgentName, string>>;
  agentArgsOverride: Partial<Record<AgentName, string[]>>;
  effort: EffortLevel;
  agents?: string;
  appendSystemPrompt?: string;
  commitMessage?: CommitMessageConfig;
  maxConsecutiveFailures: number;
  preventSleep: boolean;
}

const DEFAULT_CONFIG: Config = {
  agentModel: {},
  agentPathOverride: {},
  agentArgsOverride: {},
  effort: DEFAULT_EFFORT,
  maxConsecutiveFailures: 3,
  preventSleep: true,
};

function unsupportedAgentMessage(label: string, key: string): string {
  return `Invalid agent name in ${label}: "${key}". gnhf only supports "claude"; remove ${label}.${key} from ~/.gnhf/config.yml.`;
}

function describeLegacyAgent(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value)
    ? `"${value}"`
    : "a non-claude agent";
}

function normalizeLegacyAgent(value: unknown): void {
  if (value === "claude") return;
  throw new InvalidConfigError(
    `Unsupported config value for agent: ${describeLegacyAgent(value)}. gnhf only supports claude; remove the agent key from ~/.gnhf/config.yml.`,
  );
}

function normalizePreventSleep(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;

  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "on") return true;
  if (value === "off") return false;
  return undefined;
}

function isEffortArg(arg: string): boolean {
  return arg === "--effort" || arg.startsWith("--effort=");
}

function isReservedAgentArg(arg: string): boolean {
  return (
    arg === "-p" ||
    arg === "--print" ||
    arg === "--verbose" ||
    arg === "--output-format" ||
    arg.startsWith("--output-format=") ||
    arg === "--json-schema" ||
    arg.startsWith("--json-schema=") ||
    isEffortArg(arg)
  );
}

/**
 * Resolve a user-supplied path against the config directory (~/.gnhf).
 * Expands leading `~` or `~/` to the home directory, then resolves relative
 * paths against `baseDir` so that entries like `./bin/claude` work predictably
 * regardless of the repo's cwd. Bare executable names and absolute paths pass
 * through unchanged.
 */
function resolveConfigPath(raw: string, baseDir: string): string {
  if (
    raw !== "~" &&
    !raw.startsWith("~/") &&
    !raw.startsWith("~\\") &&
    !raw.includes("/") &&
    !raw.includes("\\")
  ) {
    return raw;
  }

  return resolve(baseDir, expandHome(raw));
}

function expandHome(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return join(homedir(), raw.slice(2));
  }
  return raw;
}

function normalizeAgentPathOverride(
  value: unknown,
  configDir: string,
): Partial<Record<AgentName, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigError(
      `Invalid config value for agentPathOverride: expected an object mapping agent names to paths`,
    );
  }

  const validNames = new Set<string>(AGENT_NAMES);
  const result: Partial<Record<AgentName, string>> = {};

  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (!validNames.has(key)) {
      throw new InvalidConfigError(
        unsupportedAgentMessage("agentPathOverride", key),
      );
    }
    if (typeof val !== "string") {
      throw new InvalidConfigError(
        `Invalid path for agentPathOverride.${key}: expected a string`,
      );
    }
    if (val.trim() === "") {
      throw new InvalidConfigError(
        `Invalid path for agentPathOverride.${key}: expected a non-empty string`,
      );
    }
    result[key as AgentName] = resolveConfigPath(val, configDir);
  }

  return result;
}

function normalizeAgentExtraArgs(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new InvalidConfigError(
      `Invalid config value for ${label}: expected an array of strings`,
    );
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: expected a string`,
      );
    }

    const trimmed = entry.trim();
    if (trimmed === "") {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: expected a non-empty string`,
      );
    }

    if (isEffortArg(trimmed)) {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: "${trimmed}" is managed by gnhf. Set effort in ~/.gnhf/config.yml or pass --effort instead.`,
      );
    }

    if (isReservedAgentArg(trimmed)) {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: "${trimmed}" is managed by gnhf and cannot be overridden`,
      );
    }

    return trimmed;
  });
}

function normalizeAgentArgsOverride(
  value: unknown,
): Partial<Record<AgentName, string[]>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigError(
      `Invalid config value for agentArgsOverride: expected an object`,
    );
  }

  const validNames = new Set<string>(AGENT_NAMES);
  const result: Partial<Record<AgentName, string[]>> = {};

  for (const [key, rawConfig] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!validNames.has(key)) {
      throw new InvalidConfigError(
        unsupportedAgentMessage("agentArgsOverride", key),
      );
    }
    const args = normalizeAgentExtraArgs(rawConfig, `agentArgsOverride.${key}`);
    if (args !== undefined) {
      result[key as AgentName] = args;
    }
  }

  return Object.keys(result).length === 0 ? undefined : result;
}

function normalizeAgentModel(
  value: unknown,
): Partial<Record<AgentName, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigError(
      `Invalid config value for agentModel: expected an object mapping agent names to models`,
    );
  }

  const validNames = new Set<string>(AGENT_NAMES);
  const result: Partial<Record<AgentName, string>> = {};

  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (!validNames.has(key)) {
      throw new InvalidConfigError(unsupportedAgentMessage("agentModel", key));
    }
    if (typeof val !== "string") {
      throw new InvalidConfigError(
        `Invalid model for agentModel.${key}: expected a string`,
      );
    }
    if (val.trim() === "") {
      throw new InvalidConfigError(
        `Invalid model for agentModel.${key}: expected a non-empty string`,
      );
    }
    result[key as AgentName] = val.trim();
  }

  return Object.keys(result).length === 0 ? undefined : result;
}

type ClaudeFileSetting = "agents" | "appendSystemPrompt";

const CLAUDE_FILE_SETTING_FLAGS: Record<ClaudeFileSetting, string[]> = {
  agents: ["--agents"],
  appendSystemPrompt: ["--append-system-prompt", "--append-system-prompt-file"],
};

function readSettingFile(key: ClaudeFileSetting, path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    throw new InvalidConfigError(
      `Invalid config value for ${key}: cannot read ${path}`,
    );
  }
}

function isJsonObject(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    return (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    );
  } catch {
    return false;
  }
}

function normalizeClaudeFileSetting(
  key: ClaudeFileSetting,
  value: unknown,
  configDir: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidConfigError(
      `Invalid config value for ${key}: expected a path to a file`,
    );
  }
  const path = resolve(configDir, expandHome(value.trim()));
  const content = readSettingFile(key, path);
  if (key === "agents" && !isJsonObject(content)) {
    throw new InvalidConfigError(
      `Invalid config value for agents: ${path} must contain a JSON object mapping agent names to definitions`,
    );
  }
  return path;
}

function matchesFlag(arg: string, flag: string): boolean {
  return arg === flag || arg.startsWith(`${flag}=`);
}

function assertNoClaudeFileSettingConflicts(config: Config): void {
  const args = config.agentArgsOverride.claude ?? [];
  for (const key of Object.keys(
    CLAUDE_FILE_SETTING_FLAGS,
  ) as ClaudeFileSetting[]) {
    if (config[key] === undefined) continue;
    const index = args.findIndex((arg) =>
      CLAUDE_FILE_SETTING_FLAGS[key].some((flag) => matchesFlag(arg, flag)),
    );
    if (index !== -1) {
      throw new InvalidConfigError(
        `Invalid config value for agentArgsOverride.claude[${index}]: "${args[index]}" conflicts with ${key} in ~/.gnhf/config.yml. Remove one of them.`,
      );
    }
  }
}

function normalizeEffort(value: unknown): EffortLevel {
  if (isEffortLevel(value)) return value;
  throw new InvalidConfigError(
    `Invalid config value for effort: ${JSON.stringify(value)}. Use ${EFFORT_LEVEL_LIST}.`,
  );
}

type RawConfig = Partial<Config> & {
  agent?: unknown;
  acpRegistryOverrides?: unknown;
};

function normalizeConfig(
  config: RawConfig,
  configDir?: string,
): Partial<Config> {
  const { agent, acpRegistryOverrides, ...rest } = config;
  if (Object.prototype.hasOwnProperty.call(config, "agent")) {
    normalizeLegacyAgent(agent);
  }
  if (acpRegistryOverrides !== undefined && acpRegistryOverrides !== null) {
    throw new InvalidConfigError(
      "Unsupported config key acpRegistryOverrides: gnhf only supports claude; remove acpRegistryOverrides from ~/.gnhf/config.yml.",
    );
  }
  const normalized: Partial<Config> = { ...rest };
  const hasPreventSleep = Object.prototype.hasOwnProperty.call(
    config,
    "preventSleep",
  );
  const preventSleep = normalizePreventSleep(config.preventSleep);

  if (preventSleep === undefined) {
    if (hasPreventSleep && config.preventSleep !== undefined) {
      throw new InvalidConfigError(
        `Invalid config value for preventSleep: ${String(config.preventSleep)}`,
      );
    }
    delete normalized.preventSleep;
  } else {
    normalized.preventSleep = preventSleep;
  }

  const hasAgentPathOverride = Object.prototype.hasOwnProperty.call(
    config,
    "agentPathOverride",
  );
  if (hasAgentPathOverride) {
    const resolveDir = configDir ?? join(homedir(), ".gnhf");
    const agentPathOverride = normalizeAgentPathOverride(
      config.agentPathOverride,
      resolveDir,
    );
    if (agentPathOverride === undefined) {
      delete normalized.agentPathOverride;
    } else {
      normalized.agentPathOverride = agentPathOverride;
    }
  } else {
    delete normalized.agentPathOverride;
  }

  const hasAgentArgsOverride = Object.prototype.hasOwnProperty.call(
    config,
    "agentArgsOverride",
  );
  if (hasAgentArgsOverride) {
    const agentArgsOverride = normalizeAgentArgsOverride(
      config.agentArgsOverride,
    );
    if (agentArgsOverride === undefined) {
      delete normalized.agentArgsOverride;
    } else {
      normalized.agentArgsOverride = agentArgsOverride;
    }
  } else {
    delete normalized.agentArgsOverride;
  }

  const hasAgentModel = Object.prototype.hasOwnProperty.call(
    config,
    "agentModel",
  );
  if (hasAgentModel) {
    const agentModel = normalizeAgentModel(config.agentModel);
    if (agentModel === undefined) {
      delete normalized.agentModel;
    } else {
      normalized.agentModel = agentModel;
    }
  } else {
    delete normalized.agentModel;
  }

  if (Object.prototype.hasOwnProperty.call(config, "effort")) {
    normalized.effort = normalizeEffort(config.effort);
  }

  for (const key of ["agents", "appendSystemPrompt"] as const) {
    if (config[key] === undefined || config[key] === null) {
      delete normalized[key];
    } else {
      normalized[key] = normalizeClaudeFileSetting(
        key,
        config[key],
        configDir ?? join(homedir(), ".gnhf"),
      );
    }
  }

  const hasCommitMessage = Object.prototype.hasOwnProperty.call(
    config,
    "commitMessage",
  );
  if (hasCommitMessage) {
    const commitMessage = normalizeCommitMessageConfig(config.commitMessage);
    if (commitMessage === undefined) {
      delete normalized.commitMessage;
    } else {
      normalized.commitMessage = commitMessage;
    }
  } else {
    delete normalized.commitMessage;
  }

  return normalized;
}

function isMissingConfigError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return "code" in error
    ? error.code === "ENOENT"
    : error.message.includes("ENOENT");
}

function serializeAgentPathOverride(
  agentPathOverride: Partial<Record<AgentName, string>>,
): string {
  const serializedOverrides = Object.fromEntries(
    AGENT_NAMES.flatMap((name) => {
      const value = agentPathOverride[name];
      return value === undefined ? [] : [[name, value] as const];
    }),
  );

  if (Object.keys(serializedOverrides).length === 0) {
    return "";
  }

  return yaml
    .dump(
      { agentPathOverride: serializedOverrides },
      { lineWidth: -1, noRefs: true, sortKeys: false },
    )
    .trimEnd();
}

function serializeAgentArgsOverride(
  agentArgsOverride: Partial<Record<AgentName, string[]>>,
): string {
  if (Object.keys(agentArgsOverride).length === 0) {
    return "";
  }

  return yaml
    .dump(
      { agentArgsOverride },
      { lineWidth: -1, noRefs: true, sortKeys: false },
    )
    .trimEnd();
}

function serializeAgentModel(
  agentModel: Partial<Record<AgentName, string>>,
): string {
  if (Object.keys(agentModel).length === 0) {
    return "";
  }

  return yaml
    .dump({ agentModel }, { lineWidth: -1, noRefs: true, sortKeys: false })
    .trimEnd();
}

function serializeConfig(config: Config): string {
  const agentPathOverrideSection = serializeAgentPathOverride(
    config.agentPathOverride,
  );
  const agentArgsOverrideSection = serializeAgentArgsOverride(
    config.agentArgsOverride,
  );
  const agentModelSection = serializeAgentModel(config.agentModel);
  const lines = [
    "# Custom path to the claude binary (optional)",
    "# Paths may be absolute, bare executable names on PATH,",
    "# ~-prefixed, or relative to this config directory.",
    "# agentPathOverride:",
    "#   claude: /path/to/custom-claude",
    "",
    "# Extra claude CLI args (optional)",
    "# agentArgsOverride:",
    "#   claude:",
    "#     - --add-dir",
    "#     - ../shared-lib",
    "",
    "# Claude model (optional, defaults to claude-opus-5-5)",
    "# agentModel:",
    "#   claude: sonnet",
    "",
    "# Subagent definitions passed to claude --agents (optional)",
    "# A JSON file mapping agent names to definitions.",
    "# agents: ./agents.json",
    "",
    "# Extra system prompt passed to claude --append-system-prompt-file (optional)",
    "# appendSystemPrompt: ./system-prompt.md",
    "",
    "# Commit message convention (optional)",
    "# Defaults to: gnhf <iteration>: <summary>",
    "# Use Conventional Commits semantic-release headers:",
    "# commitMessage:",
    "#   preset: conventional",
  ];

  if (agentPathOverrideSection) {
    lines.push(...agentPathOverrideSection.split("\n"));
  }

  if (agentArgsOverrideSection) {
    lines.push(...agentArgsOverrideSection.split("\n"));
  }

  if (agentModelSection) {
    lines.push(...agentModelSection.split("\n"));
  }

  lines.push(
    "",
    `# Claude reasoning effort: ${EFFORT_LEVEL_LIST}`,
    `effort: ${config.effort}`,
    "",
    "# Abort after this many consecutive failures",
    `maxConsecutiveFailures: ${config.maxConsecutiveFailures}`,
    "",
    "# Prevent the machine from sleeping during a run",
    `preventSleep: ${config.preventSleep}`,
    "",
  );

  return lines.join("\n");
}

export function loadConfig(overrides?: Partial<Config>): Config {
  const configDir = join(homedir(), ".gnhf");
  const configPath = join(configDir, "config.yml");
  let fileConfig: Partial<Config> = {};
  let shouldBootstrapConfig = false;

  try {
    const raw = readFileSync(configPath, "utf-8");
    fileConfig = normalizeConfig(
      (yaml.load(raw) as RawConfig) ?? {},
      configDir,
    );
  } catch (error) {
    if (error instanceof InvalidConfigError) {
      throw error;
    }
    if (isMissingConfigError(error)) {
      shouldBootstrapConfig = true;
    }

    // Config file doesn't exist or is invalid -- use defaults
  }

  const resolvedConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...normalizeConfig(overrides ?? {}),
  };
  assertNoClaudeFileSettingConflicts(resolvedConfig);

  if (shouldBootstrapConfig) {
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, serializeConfig(resolvedConfig), "utf-8");
    } catch {
      // Best-effort only. Startup should still fall back to in-memory defaults.
    }
  }

  return resolvedConfig;
}
