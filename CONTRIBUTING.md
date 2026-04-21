# Contributing

Thanks for considering a contribution to Terminal Sheet. Contributions are welcome, including bug reports, documentation improvements, tests, and code changes.

This project is still finding its long-term direction. Some well-made pull requests may not fit the direction I choose for the project, so please be prepared for feedback that asks for a different approach or for a PR to be closed even if the implementation is technically sound.

## Development Setup

Use Node.js `>=20.11.0`.

Install dependencies:

```sh
npm install
```

Start the full local development stack:

```sh
npm run dev
```

Useful development commands:

```sh
npm run dev:web
npm run dev:server
npm run build
npm run typecheck
npm run lint
npm run test
```

## Before Opening a Pull Request

Please keep changes focused and aligned with the existing structure:

- `src/web/` for the React and Vite client.
- `src/server/` for the Fastify server, PTY integration, routes, persistence, and WebSocket wiring.
- `src/shared/` for schemas and shared domain types.
- `src/cli/` for the `terminal-canvas` entrypoint.
- `src/dev/` for local development helpers.

Run the relevant checks before submitting:

```sh
npm run typecheck
npm run lint
npm run test
```

For UI changes, include screenshots or a short recording when it helps reviewers understand the behavior.

## Tests

Tests use Vitest and are co-located under `src/**/*.test.ts`. Add targeted regression tests for bug fixes and cover shared schemas, state changes, and user-visible behavior where relevant.

To run a focused test file:

```sh
npx vitest run src/shared/workspace.test.ts
```

## Coding Style

This repository uses TypeScript with strict compiler settings. Follow the existing style and Prettier configuration:

- 2-space indentation.
- Semicolons.
- Single quotes.
- Trailing commas.
- Named exports where practical.
- Descriptive, case-matched filenames.

Keep unrelated refactors out of feature or bug-fix PRs.

## AI-Generated Contributions

AI-generated submissions are permitted. If you use AI tools to create or modify a contribution, you are responsible for reviewing and testing the result before submitting it.

Please make sure AI-assisted changes:

- Match the repository's architecture and coding style.
- Do not introduce copied code without compatible licensing.
- Include tests for meaningful behavior changes.
- Avoid broad rewrites unless the PR is specifically about that rewrite.
- Are described honestly in the PR when AI assistance was substantial.

## Pull Request Expectations

PRs should include:

- A concise summary of the change.
- Testing notes, including commands run.
- Linked issues when relevant.
- Screenshots or recordings for visible canvas or terminal UI changes.

Commit messages should be short and imperative, such as `Fix focused terminal viewport sizing`.

## Local State

Local workspace state is written to `.terminal-canvas/workspace.json` and should not be committed. Prefer custom workspace files for experiments instead of editing that file by hand.

