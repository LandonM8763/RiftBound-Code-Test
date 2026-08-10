# CLAUDE.md

Guidance for Claude Code and other AI assistants working in this repository.

> **STATUS: STUB — the repository contains no source code yet.**
>
> This file was generated on 2026-08-10, when the repository had zero commits and
> no files. Everything below is either a verified fact about the repo itself or an
> explicitly marked placeholder. **Nothing here describes real application code,
> because none exists yet.**
>
> **If you are an AI assistant reading this:** do not treat the `TODO` sections as
> descriptions of reality, and do not infer a tech stack, directory layout, or
> command set from this file. Inspect the working tree first. Once real code lands,
> replace the placeholders with what you actually observe.

## Repository facts

These are verified, not assumed:

| | |
|---|---|
| Repository | `LandonM8763/RiftBound-Code-Test` |
| Remote | `https://github.com/LandonM8763/RiftBound-Code-Test` |
| Default branch | `main` |
| Created | 2026-08-10 |
| State at time of writing | Empty — no commits, no branches, no files |

There is no repository description, and there are no issues or pull requests that
describe the project's intent.

## Git workflow

- The default branch is `main`.
- Claude-authored work is developed on a dedicated branch (this file was committed
  on `claude/claude-md-docs-2mqw7b`), not directly on `main`.
- Push with `git push -u origin <branch-name>`.
- Do not open a pull request unless it was explicitly requested.
- Check for a PR template (`.github/pull_request_template.md`,
  `.github/PULL_REQUEST_TEMPLATE.md`, root `PULL_REQUEST_TEMPLATE.md`, or
  `docs/PULL_REQUEST_TEMPLATE.md`) before opening a PR; none exists today.

## TODO: Project overview

_Not yet known._ Record here, once the code exists:

- What this project is and what problem it solves.
- Who or what consumes it (CLI, service, library, game client, etc.).
- Any domain vocabulary a newcomer would need. The repository name references
  "RiftBound," but the repo carries no description, so the meaning of that term is
  currently undocumented — do not guess it.

## TODO: Codebase structure

_Not yet known._ Document the top-level directory layout and the responsibility of
each significant module, plus where the entry points live.

## TODO: Development workflow

_Not yet known._ Record the actual, verified commands — run them before writing
them down:

- Install dependencies
- Build
- Run locally
- Run tests (and how to run a single test)
- Lint / format
- Type-check

Note the toolchain and any required runtime versions or environment variables.

## TODO: Conventions

_Not yet known._ Capture the conventions that are actually visible in the code
rather than generic best practices — naming, error handling, module boundaries,
test layout and style, commit message format, and anything a contributor would
otherwise get wrong.

## Maintaining this file

When real code is added, rewrite this file to describe it and delete the stub
banner and any `TODO` sections that have been filled in. Prefer specifics that are
hard to infer from a quick skim; omit anything you have not verified. A short,
accurate CLAUDE.md is more useful than a long, speculative one.
