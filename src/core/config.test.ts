import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";

const mockMkdirSync = vi.mocked(mkdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

const HOME = "/mock-home";
const CONFIG_DIR = join(HOME, ".gnhf");
const CONFIG_PATH = join(CONFIG_DIR, "config.yml");
// Golden copy of the bootstrap template written on first run. Read via
// node:fs/promises because node:fs is mocked in this file. README's
// Configuration block is pinned to the same golden file by
// bootstrap-config.test.ts, so all three surfaces cannot drift apart.
const GOLDEN_BOOTSTRAP_CONFIG = (
  await readFile(
    new URL("./bootstrap-config.golden.yml", import.meta.url),
    "utf-8",
  )
).replace(/\r\n/g, "\n");

describe("loadConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns defaults when config file does not exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const config = loadConfig();

    expect(mockMkdirSync).toHaveBeenCalledWith(CONFIG_DIR, {
      recursive: true,
    });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      GOLDEN_BOOTSTRAP_CONFIG,
      "utf-8",
    );
    expect(config).toEqual({
      agentPathOverride: {},
      agentModel: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
    expect(config).not.toHaveProperty("commitMessage");
  });

  it("still returns defaults when default config creation fails", () => {
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });
    mockWriteFileSync.mockImplementation(() => {
      throw new Error("EPERM");
    });

    const config = loadConfig();

    expect(config).toEqual({
      agentPathOverride: {},
      agentModel: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("writes agentPathOverride values when bootstrapping a missing config file", () => {
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });

    const config = loadConfig({
      agentPathOverride: {
        claude: "./bin/claude-wrapper",
      },
    });

    const resolvedClaude = resolve(CONFIG_DIR, "bin", "claude-wrapper");

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      expect.stringContaining(`claude: ${resolvedClaude}`),
      "utf-8",
    );
    expect(config).toEqual({
      agentPathOverride: {
        claude: resolvedClaude,
      },
      agentModel: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("reads config from ~/.gnhf/config.yml", () => {
    mockReadFileSync.mockReturnValue("maxConsecutiveFailures: 7\n");

    const config = loadConfig();

    expect(mockReadFileSync).toHaveBeenCalledWith(CONFIG_PATH, "utf-8");
    expect(config.maxConsecutiveFailures).toBe(7);
  });

  it("accepts a legacy agent: claude key", () => {
    mockReadFileSync.mockReturnValue(
      "agent: claude\nmaxConsecutiveFailures: 5\n",
    );

    const config = loadConfig();

    expect(config).not.toHaveProperty("agent");
    expect(config.maxConsecutiveFailures).toBe(5);
  });

  it.each([
    ["codex", 'Unsupported config value for agent: "codex"'],
    ["acp:gemini", "Unsupported config value for agent: a non-claude agent"],
    [
      '"acp:./bin/dev-acp --token secret"',
      "Unsupported config value for agent: a non-claude agent",
    ],
  ])("rejects a legacy agent: %s key", (agent, expected) => {
    mockReadFileSync.mockReturnValue(`agent: ${agent}\n`);

    expect(() => loadConfig()).toThrow(expected);
    expect(() => loadConfig()).toThrow(
      "gnhf only supports claude; remove the agent key from ~/.gnhf/config.yml",
    );
    expect(() => loadConfig()).not.toThrow("secret");
  });

  it("rejects a legacy acpRegistryOverrides key", () => {
    mockReadFileSync.mockReturnValue(
      'acpRegistryOverrides:\n  my-fork: "node agent.mjs"\n',
    );

    expect(() => loadConfig()).toThrow(
      "Unsupported config key acpRegistryOverrides",
    );
  });

  it("reads the conventional commit message preset from config", () => {
    mockReadFileSync.mockReturnValue(
      "commitMessage:\n  preset: conventional\n",
    );

    const config = loadConfig();

    expect(config.commitMessage).toEqual({
      preset: "conventional",
    });
  });

  it("merges file config with defaults", () => {
    mockReadFileSync.mockReturnValue("maxConsecutiveFailures: 10\n");

    const config = loadConfig();
    expect(config).toEqual({
      agentPathOverride: {},
      agentModel: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 10,
      preventSleep: true,
    });
  });

  it('coerces quoted "false" for preventSleep to a boolean false', () => {
    mockReadFileSync.mockReturnValue('preventSleep: "false"\n');

    const config = loadConfig();

    expect(config).toEqual({
      agentPathOverride: {},
      agentModel: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: false,
    });
  });

  it('coerces "off" for preventSleep to a boolean false', () => {
    mockReadFileSync.mockReturnValue("preventSleep: off\n");

    const config = loadConfig();

    expect(config).toEqual({
      agentPathOverride: {},
      agentModel: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: false,
    });
  });

  it("overrides take precedence over file config and defaults", () => {
    mockReadFileSync.mockReturnValue(
      "maxConsecutiveFailures: 10\npreventSleep: false\n",
    );

    const config = loadConfig({
      agentPathOverride: {},
      agentModel: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
    expect(config).toEqual({
      agentPathOverride: {},
      agentModel: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("reads claude extra args", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  claude:\n    - --model\n    - sonnet\n",
    );

    const config = loadConfig();

    expect(config.agentArgsOverride).toEqual({
      claude: ["--model", "sonnet"],
    });
  });

  it.each(["agentArgsOverride", "agentModel", "agentPathOverride"])(
    "rejects non-claude agent names in %s",
    (key) => {
      const value =
        key === "agentArgsOverride" ? "\n    - --full-auto" : " gpt-5.4";
      mockReadFileSync.mockReturnValue(`${key}:\n  codex:${value}\n`);

      expect(() => loadConfig()).toThrow(
        `Invalid agent name in ${key}: "codex". gnhf only supports "claude"; remove ${key}.codex from ~/.gnhf/config.yml.`,
      );
    },
  );

  it.each([
    "-p",
    "--print",
    "--verbose",
    "--output-format",
    "--output-format=json",
    "--json-schema",
    "--json-schema={}",
  ])(
    "throws when agentArgsOverride.claude contains reserved flag %s",
    (flag) => {
      mockReadFileSync.mockReturnValue(
        `agentArgsOverride:\n  claude:\n    - "${flag}"\n`,
      );

      expect(() => loadConfig()).toThrow(
        /agentArgsOverride\.claude\[0\].*managed by gnhf/,
      );
    },
  );

  it("handles empty config file gracefully", () => {
    mockReadFileSync.mockReturnValue("");

    const config = loadConfig();
    expect(config).toEqual({
      agentPathOverride: {},
      agentModel: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("handles invalid YAML gracefully", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("invalid yaml");
    });

    const config = loadConfig();
    expect(config).toEqual({
      agentPathOverride: {},
      agentModel: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("resolves ~ in agentPathOverride to the home directory", () => {
    mockReadFileSync.mockReturnValue(
      "agentPathOverride:\n  claude: ~/bin/my-claude\n",
    );

    const config = loadConfig();
    expect(config.agentPathOverride.claude).toBe(
      resolve(join(HOME, "bin", "my-claude")),
    );
  });

  it("resolves relative paths in agentPathOverride against the config directory", () => {
    mockReadFileSync.mockReturnValue(
      "agentPathOverride:\n  claude: ./bin/my-claude\n",
    );

    const config = loadConfig();
    expect(config.agentPathOverride.claude).toBe(
      resolve(CONFIG_DIR, "bin", "my-claude"),
    );
  });

  it("passes absolute paths in agentPathOverride through unchanged", () => {
    mockReadFileSync.mockReturnValue(
      "agentPathOverride:\n  claude: /usr/local/bin/my-claude\n",
    );

    const config = loadConfig();
    expect(config.agentPathOverride.claude).toBe(
      resolve("/usr/local/bin/my-claude"),
    );
  });

  it("preserves bare executable names in agentPathOverride", () => {
    mockReadFileSync.mockReturnValue(
      "agentPathOverride:\n  claude: claude-code-switch\n",
    );

    const config = loadConfig();

    expect(config.agentPathOverride.claude).toBe("claude-code-switch");
  });

  it("allows agentArgsOverride.claude to set the dangerous permission flag explicitly", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  claude:\n    - --dangerously-skip-permissions\n",
    );

    const config = loadConfig();

    expect(config.agentArgsOverride).toEqual({
      claude: ["--dangerously-skip-permissions"],
    });
  });

  it("reads agentModel from config", () => {
    mockReadFileSync.mockReturnValue("agentModel:\n  claude: sonnet\n");

    const config = loadConfig();

    expect(config.agentModel).toEqual({ claude: "sonnet" });
  });

  it("rejects non-string values in agentModel", () => {
    mockReadFileSync.mockReturnValue("agentModel:\n  claude: 42\n");

    expect(() => loadConfig()).toThrow(
      /Invalid model for agentModel\.claude: expected a string/,
    );
  });
});
