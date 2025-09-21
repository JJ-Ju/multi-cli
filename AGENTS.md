# Repository Guidelines

## Project Structure & Module Organization

- NPM workspaces keep code under `packages/*`; start with `packages/cli/src` for the CLI entrypoint and `packages/core/src` for shared services.
- `packages/a2a-server` serves agent-to-agent workflows, while `packages/test-utils` and `packages/vscode-ide-companion` provide test harnesses and editor integrations.
- End-to-end suites live in `integration-tests/`; reusable scripts and build helpers sit in `scripts/`.
- Generated output belongs in `bundle/`; vendored resources stay in `third_party/`.

## Build, Test & Development Commands

- `npm run start` launches the CLI in watch mode; `npm run build` compiles all workspaces through `scripts/build.js`.
- Use `npm run build:all` before packaging to produce the CLI, sandbox image, and VS Code companion bundles.
- `npm run test` runs workspace vitest suites; `npm run test:integration:sandbox:none` exercises the CLI end-to-end without a sandbox.
- `npm run lint` enforces ESLint rules, `npm run typecheck` runs the workspace TypeScript compiler, and `npm run format` applies Prettier.

## Coding Style & Naming Conventions

- TypeScript modules use ES modules, 2-space indentation, single quotes, and required semicolons; rely on Prettier for formatting.
- Keep filenames lowercase with hyphens (e.g. `file-command-loader.ts`); tests colocate as `*.test.ts` next to the source under test.
- Apply copyright headers from existing files and honor lint rules defined in `eslint.config.js`.

## Testing Guidelines

- Vitest powers unit and integration tests; favor colocated unit specs and reserve `integration-tests/*.test.ts` for CLI flows.
- When touching command routing, add coverage using the helpers in `packages/test-utils`.
- Run `npm run test:ci` (which includes script tests) before opening a PR, and capture coverage via `vitest run --coverage` if logic changes are large.

## Commit & Pull Request Guidelines

- Follow the conventional commit pattern used in history (e.g. `feat(cli): add sandbox flag`) and keep subject lines under ~72 characters.
- Squash trivial work-in-progress commits locally; include linked issues or bug IDs in the body when applicable.
- PRs should describe motivation, testing performed (`npm run lint`, `npm run test:integration:sandbox:none`, etc.), and screenshots or logs for user-visible changes.

## Security & Configuration Tips

- Consult `SECURITY.md` for disclosure processes; never commit secrets or auth tokens.
- Prefer environment variables like `GEMINI_SANDBOX` and `CODER_AGENT_PORT` for local overrides, and document non-obvious values in the PR description.
- The Grok provider expects `GROK_API_KEY` to be set and requires a Python 3.10+
  runtime for the sidecar (`python -m grok_sidecar`); keep those secrets out of
  source control.
