<p align="center">Before I go to bed, I tell my agents:</p>
<h1 align="center">good night, have fun</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/gnhf"
    ><img
      alt="npm"
      src="https://img.shields.io/npm/v/gnhf?style=flat-square"
  /></a>
  <a href="https://github.com/kunchenguid/gnhf/actions/workflows/ci.yml"
    ><img
      alt="CI"
      src="https://img.shields.io/github/actions/workflow/status/kunchenguid/gnhf/ci.yml?style=flat-square&label=ci"
  /></a>
  <a href="https://github.com/kunchenguid/gnhf/actions/workflows/release-please.yml"
    ><img
      alt="Release"
      src="https://img.shields.io/github/actions/workflow/status/kunchenguid/gnhf/release-please.yml?style=flat-square&label=release"
  /></a>
  <a
    href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
    ><img
      alt="Platform"
      src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
  /></a>
  <a href="https://x.com/kunchenguid"
    ><img
      alt="X"
      src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square"
  /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"
    ><img
      alt="Discord"
      src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord"
  /></a>
</p>

<p align="center">
  <img src="docs/splash.png" alt="gnhf - Good Night, Have Fun" width="800">
</p>

Never wake up empty-handed.

gnhf is a [ralph](https://ghuntley.com/ralph/), [autoresearch](https://github.com/karpathy/autoresearch)-style orchestrator that keeps your agents running while you sleep - each iteration makes one small, committed, documented change towards an objective.
You wake up to a branch full of clean work and a log of everything that happened.

- **Dead simple** - one command starts an autonomous loop that runs until you request stop or a configured runtime cap is reached
- **Long running** - each iteration is committed on success and rolled back on failure, with sensible retries; [How It Works](#how-it-works) has the full failure-handling rules
- **Live terminal title** - interactive runs keep your terminal title updated with live status, token totals, and commit count, then clear or restore it on exit depending on terminal support; token totals prefixed with `~` are estimates
- **Exit summary** - every run ends with a permanent summary covering elapsed time, branch, iterations, tokens, branch diff stats, local notes/log paths, and review commands
- **Built on Claude Code** - drives Anthropic's `claude` CLI in non-interactive mode, defaulting to Opus 5.5 (`claude-opus-5-5`) at medium effort; see [Agents](#agents) for requirements

## Quick Start

```sh
$ gnhf "reduce complexity of the codebase without changing functionality"
# have a good sleep
```

```sh
$ gnhf "reduce complexity of the codebase without changing functionality" \
    --max-iterations 10 \
    --max-tokens 5000000
# have a good nap
```

```sh
# Run multiple agents on the same repo simultaneously using worktrees
$ gnhf --worktree "implement feature X" &
$ gnhf --worktree "add tests for module Y" &
$ gnhf --worktree "refactor the API layer" &
```

```sh
# Commit directly on the current branch and push after each successful iteration
$ gnhf --current-branch --push "keep improving this app"
```

Run `gnhf` from inside a Git repository with a clean working tree. If you are starting from a plain directory, run `git init` first.
`gnhf` supports macOS, Linux, and Windows.

## Install

**npm**

```sh
npm install -g gnhf
```

**From source**

```sh
git clone https://github.com/kunchenguid/gnhf.git
cd gnhf
corepack enable
pnpm install
pnpm run build
pnpm link --global
```

## Agent Skill

The npm package includes an agent-facing skill at `skills/gnhf/SKILL.md`. Agents that support local skills can copy or reference this file to learn how to run GNHF in Hands-Off mode for bounded overnight work, or Companion mode when the outer agent should steer and review a long-running GNHF run.

After installing from npm, the skill is available under the installed package directory. From a source checkout, use `skills/gnhf/SKILL.md` directly.

## How It Works

```
                    ┌─────────────┐
                    │  gnhf start │
                    └──────┬──────┘
                           ▼
                ┌──────────────────────┐
                │  validate clean git  │
                │  create or use branch │
                │  write prompt.md     │
                └──────────┬───────────┘
                           ▼
              ┌────────────────────────────┐
              │  build iteration prompt    │◄──────────────┐
              │  (inject notes.md context) │               │
              └────────────┬───────────────┘               │
                           ▼                               │
              ┌────────────────────────────┐               │
              │  invoke your agent         │               │
              │  (non-interactive mode)    │               │
              └────────────┬───────────────┘               │
                           ▼                               │
                    ┌─────────────┐                        │
                    │  success?   │                        │
                    └──┬──────┬───┘                        │
                  yes  │      │  no                        │
                       ▼      ▼                            │
              ┌──────────┐  ┌───────────┐                  │
              │  commit  │  │ reset or  │                  │
              │  append  │  │  repair   │                  │
              │ notes.md │  │           │                  │
              │maybe wait│  │ maybe wait│                  │
              └────┬─────┘  └─────┬─────┘                  │
                   │              │                        │
                   │   ┌──────────┘                        │
                   ▼   ▼                                   │
              ┌────────────┐    yes   ┌──────────┐         │
              │ 3 consec.  ├─────────►│  abort   │         │
              │ failures   │          └────▲─────┘         │
              │ or perm.   ├───────────────┘               │
              │ error?     │                               │
              └─────┬──────┘                               │
                 no │                                      │
                    └──────────────────────────────────────┘
```

- **Incremental commits** - each successful iteration is a separate unsigned git commit, so you can cherry-pick or revert individual changes without GPG or SSH signing prompts blocking the run; if `git commit` fails, gnhf preserves the uncommitted work and asks the next agent iteration to repair it
- **Failure handling** - failed iterations are rolled back with `git reset --hard` except commit failures, which preserve uncommitted work for repair; agent-reported failures proceed to the next iteration immediately, retryable hard agent errors use exponential backoff, and permanent agent errors such as Claude low credit balance abort immediately and print the run log path. Complete no-op iterations are reported as failures and count toward the consecutive-failure abort limit. If the run exits with a pending commit failure, the exit summary warns that uncommitted changes were left for repair.
- **Usage-limit waits** - gnhf waits out an exhausted usage window (e.g. the subscription 5-hour window) instead of running through it, in both forms it takes. When Claude rejects requests, the iteration is rolled back but not counted as a failure; gnhf reads the reset time from the agent's rate-limit event, waits until shortly after the window resets, then retries the same iteration automatically, so overnight runs resume on their own. Pass `--fallback-model <model>` to retry the first rejected iteration on that model instead; without the flag, gnhf never changes models. If no reset time is reported for a rejection, it retries on a bounded escalating interval instead. When usage credits are enabled the provider serves the request and bills the overage rather than rejecting it. A billed iteration that succeeded keeps its committed work and is counted normally; one that failed is rolled back and counted as a failure like any other. Either way gnhf then waits for the reset before starting the next iteration, so the run stops spending credits without throwing away finished work. If the reported reset time has already passed, the included window is back and the run simply continues - if the provider is still billing, the next iteration reports it again with a fresh reset time. If no reset time comes with it at all, or one so far out that gnhf cannot sleep through it in a single wait, gnhf aborts the run rather than keep buying iterations by probing. Use `--max-rate-limit-wait` to set a total wait leash for the run; if the next wait would exceed it, gnhf aborts cleanly. Ctrl+C during the wait works as usual.
- **Runtime caps** - `--max-iterations` stops before the next iteration begins, `--max-tokens` can abort mid-iteration once reported usage reaches the cap across input, output, cache-read, and cache-write tokens, and `--stop-when` ends the loop after an iteration whose agent output reports the natural-language condition is met unless a commit failure needs repair first; resumed runs reuse the saved stop condition unless you pass a new value, or `--stop-when ""` to clear it; pending commit-failure repair work is preserved and other uncommitted work is rolled back, and in the interactive TUI the final state remains visible until you press Ctrl+C to exit
- **Iteration progress** - with `--max-iterations`, the interactive stats line shows `completed/max` between the elapsed timer and token totals. The count includes finished iterations restored on resume and advances only after the active iteration finishes, whether it succeeds or fails. Runs without an iteration cap omit this segment. To fit crowded stats rows, separator spaces are removed and, if needed, token labels become `Σ` (total), `↓` (input), and `↑` (output).
- **Iteration finalization** - agents are expected to finish validation, stop any background processes they started, and only then emit the final JSON result for the iteration
- **Graceful interrupts** - in the interactive TUI, the first Ctrl+C requests a graceful stop and lets the current iteration finish (or ends backoff early), the second Ctrl+C force-stops immediately, and `SIGTERM` also force-stops immediately
- **Exit summary** - after shutdown cleanup, gnhf prints a permanent stdout summary with the final branch, elapsed time, iteration and token totals, branch diff stats, notes/debug-log paths, and review commands
- **Shared memory** - the agent reads `notes.md` (built up from prior iterations) to communicate across iterations
- **Local run metadata** - gnhf stores prompt, notes, stop conditions, commit-message convention metadata, and a final `end-state.json` sidecar with the exit status, stop condition, agent error, and counters under `.gnhf/runs/`, and ignores it locally, so your branch only contains intentional work
- **Resume support** - run `gnhf` while on an existing `gnhf/` branch to pick up where a previous run left off; if you provide a different prompt, gnhf asks whether to update the saved prompt and continue with the existing history, start a new branch, or quit. New runs whose generated branch already exists use a numeric suffix such as `gnhf/<slug>-1`. If gnhf was killed mid-iteration (crash, reboot, `SIGKILL`), resuming in any mode first commits every uncommitted change in the working tree as `gnhf <n>: wip from interrupted iteration, recovered on resume`, without running pre-commit hooks, and notes it in the run's `notes.md`. That includes edits you made after the crash. Iteration numbering then continues after it.

### Live Branch Mode

Pass `--current-branch` to run on the branch you are already on instead of creating a `gnhf/` branch.
Pass `--push` to push the current branch after each successful iteration.
Together, `--current-branch --push` is useful for loose projects where you want a deployed or locally watched branch to update throughout the run.

- Re-running the same prompt with `--current-branch` resumes the existing `.gnhf/runs/<runId>/` history on a clean working tree and continues iteration numbering.
- Push failures abort the run after preserving the successful local commit.
- gnhf never force-pushes or auto-pulls for this mode.
- `--push` also works with the default `gnhf/` branch mode.
- gnhf creates its branches without an upstream. Each push sends the current branch to the same-named branch on its push remote (`origin` unless `branch.<name>.pushRemote` or `remote.pushDefault` says otherwise). If the branch has no upstream, or its upstream on that remote is a different branch such as `origin/main`, gnhf sets the pushed branch as the new upstream. This stops a run branch created from `origin/main` from failing its first push or pushing to `main`.
- Do not combine `--current-branch` with `--worktree`; gnhf exits with an error because those modes choose different working directories.

### Worktree Mode

Pass `--worktree` to run each agent in an isolated [git worktree](https://git-scm.com/docs/git-worktree). This lets you launch multiple agents on the same repo simultaneously - each gets its own working directory and branch without interfering with the others or your main checkout.

```
<repo>/                              ← your repo (unchanged)
<repo>-gnhf-worktrees/
  ├── <run-slug-1>/                  ← worktree for agent 1
  └── <run-slug-2>/                  ← worktree for agent 2
```

- Worktrees with commits are **preserved** after the run so you can review, merge, or cherry-pick the work. gnhf prints the path and cleanup command.
- Re-running the same prompt with `--worktree` resumes a preserved matching worktree when possible; otherwise gnhf creates a suffixed worktree such as `<run-slug>-1` if the original name is unavailable.
- Worktrees with **no commits** are automatically removed on exit unless a pending commit failure left uncommitted work to inspect or repair.
- Known limitation: on Linux, when sleep prevention re-execs gnhf under `systemd-inhibit`, a worktree with no commits is left in place instead of being removed; remove it manually with `git worktree remove`. Tracked as `gnhf-reexec-worktree-leak-l1`.
- `--worktree` must be run from a non-gnhf branch (typically `main`).

## CLI Reference

| Command                   | Description                                     |
| ------------------------- | ----------------------------------------------- |
| `gnhf "<prompt>"`         | Start a new run with the given objective        |
| `gnhf`                    | Resume a run (when on an existing gnhf/ branch) |
| `echo "<prompt>" \| gnhf` | Pipe prompt via stdin                           |
| `cat prd.md \| gnhf`      | Pipe a large spec or PRD via stdin              |

If you run `gnhf` on an existing `gnhf/` branch with a different prompt, gnhf asks whether to update `prompt.md` and continue the existing run history, start a new branch, or quit. When the prompt came from stdin, that confirmation is read from the controlling terminal, so it must be available.

### Flags

| Flag                               | Description                                                                                                   | Default                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `--model <model>`                  | Claude model; overrides `agentModel.claude` from the config file                                              | config file, else `claude-opus-5-5` |
| `--effort <level>`                 | Claude reasoning effort (`low`, `medium`, `high`, `xhigh`, or `max`); overrides `effort` from the config file | config file (`medium`)              |
| `--max-iterations <n>`             | Abort after `n` total iterations                                                                              | unlimited                           |
| `--max-tokens <n>`                 | Abort after `n` total input+output+cache tokens                                                               | unlimited                           |
| `--max-rate-limit-wait <duration>` | Abort after this much total Claude usage-limit wait (`30m`, `2h`, or `0`)                                     | 24h safety cap                      |
| `--stop-when <cond>`               | End when the agent reports this condition, after any commit-failure repair; persists across resume            | unlimited                           |
| `--prevent-sleep <mode>`           | Prevent system sleep during the run (`on`/`off` or `true`/`false`)                                            | config file (`on`)                  |
| `--worktree`                       | Run in a separate git worktree (enables multiple agents concurrently)                                         | `false`                             |
| `--current-branch`                 | Run on the current branch instead of creating a `gnhf/` branch                                                | `false`                             |
| `--push`                           | Push the current branch after each successful iteration                                                       | `false`                             |
| `--meteor-frequency <n>`           | Set TUI meteor frequency from 0 to 5 (`0` disables meteors)                                                   | `3`                                 |
| `--version`                        | Show version                                                                                                  |                                     |

## Configuration

Config lives at `~/.gnhf/config.yml`.
If the file does not exist yet, `gnhf` creates it on first run with its defaults.
With the default configuration, it has this exact content:

<!-- This block mirrors src/core/bootstrap-config.golden.yml and is pinned to it by src/core/bootstrap-config.test.ts; update both together. -->

```yaml
# Custom path to the claude binary (optional)
# Paths may be absolute, bare executable names on PATH,
# ~-prefixed, or relative to this config directory.
# agentPathOverride:
#   claude: /path/to/custom-claude

# Extra claude CLI args (optional)
# agentArgsOverride:
#   claude:
#     - --add-dir
#     - ../shared-lib

# Claude model (optional, defaults to claude-opus-5-5)
# agentModel:
#   claude: sonnet

# Subagent definitions passed to claude --agents (optional)
# A JSON file mapping agent names to definitions.
# agents: ./agents.json

# Extra system prompt passed to claude --append-system-prompt-file (optional)
# appendSystemPrompt: ./system-prompt.md

# Commit message convention (optional)
# Defaults to: gnhf <iteration>: <summary>
# Use Conventional Commits semantic-release headers:
# commitMessage:
#   preset: conventional

# Claude reasoning effort: low, medium, high, xhigh, or max
effort: medium

# Abort after this many consecutive failures
maxConsecutiveFailures: 3

# Prevent the machine from sleeping during a run
preventSleep: true
```

CLI flags override config file values. `--prevent-sleep` accepts `on`/`off` as well as `true`/`false`; the config file always uses a boolean.
The iteration, token, and rate-limit-wait caps are runtime-only flags and are not persisted in `config.yml`; `--stop-when` is persisted per run for resume, but not in config.

`effort` sets Claude's reasoning effort for every iteration and is passed as `claude --effort <level>`. Valid levels are `low`, `medium`, `high`, `xhigh`, and `max`; the default is `medium`, and `--effort` overrides it for a single run without changing `config.yml`.

`agentArgsOverride.claude` passes extra flags through to the `claude` CLI.

- Use it for Claude settings that lack a dedicated `gnhf` config field. Set a model with `agentModel.claude` in config or `--model <model>` for a run; `--model` wins. With neither set, gnhf passes `--model claude-opus-5-5`, unless `agentArgsOverride.claude` sets `--model` itself.
- `gnhf` adds `--dangerously-skip-permissions` only when you do not provide your own permission flag (`--dangerously-skip-permissions`, `--permission-mode`, or `--permission-prompt-tool`). If you set one explicitly, `gnhf` treats that as user-managed and does not add its default on top.
- Flags that `gnhf` manages itself (`-p`/`--print`, `--verbose`, `--output-format`, `--json-schema`, and `--effort`) are rejected during config loading so you get a clear error instead of duplicate-argument ambiguity. Set effort with the `effort` key or `--effort` instead.
- Config files from earlier versions that name another agent (`agent: codex`, `agentModel.codex`, `acpRegistryOverrides`, and so on) are rejected with an error that names the key to remove. `agent: claude` is still accepted.

`commitMessage` controls the subject line that gnhf uses for each successful iteration commit.

- Omit it to keep the default `gnhf <iteration>: <summary>` format.
- Set `preset: conventional` to ask the agent for `type` and optional `scope`, then commit as `type(scope): summary` for semantic-release style workflows. Valid types are `build`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `test`, and `chore`; invalid or missing types fall back to `chore`, and empty scopes are omitted.
- The resolved commit-message convention is saved per run, so resuming keeps the original subject format even if `config.yml` changes later.

### Custom Claude Path

Use `agentPathOverride.claude` to point `gnhf` at a custom `claude` binary, such as a wrapper like Claude Code Switch that accepts the same flags and arguments as the original:

```yaml
agentPathOverride:
  claude: ~/bin/claude-code-switch
```

Paths may be absolute, bare executable names already on your `PATH`, `~`-prefixed, or relative to the config directory (`~/.gnhf/`). The override replaces only the binary name; all standard arguments are preserved, so the replacement must be CLI-compatible with `claude`. On Windows, `.cmd` and `.bat` wrappers are supported, including bare names resolved from `PATH`.

### Sleep Prevention

When sleep prevention is enabled, `gnhf` uses the native mechanism for your OS: `caffeinate` on macOS, `systemd-inhibit` on Linux, and a small PowerShell helper backed by `SetThreadExecutionState` on Windows.
A run is never aborted because that mechanism is unavailable; instead the exit summary adds a `sleep` line reporting either that prevention could not be started for the run, or that the helper started but never confirmed it was holding the machine awake, so the machine may have slept.

## Debug Logs

Every run writes a JSONL debug log to `.gnhf/runs/<runId>/gnhf.log` alongside `notes.md`. Lifecycle events for the orchestrator and agent are captured with elapsed timings and (for failures) the full `error.cause` chain. The agent's own streaming output still goes to the per-iteration `iteration-<n>.jsonl` file next to it.

Including a snippet of `gnhf.log` is the single most useful thing you can attach when filing an issue.

## Telemetry

`gnhf` sends anonymous usage telemetry to my self-hosted analytics so I can see what's actually getting used.
No prompts, repo paths, or branch names are sent.
Set `GNHF_TELEMETRY=0` to turn it off.

## Agents

`gnhf` runs Claude Code only.

| Agent       | Requirements                                        | Notes                                                                                                                                                                                                                                                                                                      |
| ----------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Install Anthropic's `claude` CLI and sign in first. | `gnhf` invokes `claude` directly in non-interactive mode with `--model claude-opus-5-5 --effort medium` unless you configure otherwise. After Claude emits a successful structured result, `gnhf` treats that result as final and shuts down any lingering Claude process tree after a short grace period. |

## Development

If you want to contribute changes back to this repo, see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the required workflow, dev commands, and repo conventions.

## Star History

<a href="https://www.star-history.com/?repos=kunchenguid%2Fgnhf&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=kunchenguid/gnhf&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=kunchenguid/gnhf&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=kunchenguid/gnhf&type=date&legend=top-left" />
 </picture>
</a>
