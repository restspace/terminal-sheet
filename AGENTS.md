# Repository Guidelines

## Project Structure & Module Organization
`src/` is split by runtime boundary: `src/web/` contains the React + Vite client, `src/server/` contains the Fastify server, PTY integration, routes, persistence, and WebSocket wiring, `src/shared/` holds schemas and shared domain types, `src/cli/` is the `terminal-canvas` entrypoint, and `src/dev/` contains local development launch helpers. Tests are co-located as `src/**/*.test.ts`. Build output goes to `dist/`. Local workspace state is written to `.terminal-canvas/workspace.json` and should not be committed.

## Build, Test, and Development Commands
Use Node `>=20.11.0`.

- `npm run dev`: starts the full local stack for active development.
- `npm run dev:web`: runs the Vite frontend on `127.0.0.1:4313`.
- `npm run dev:server`: runs the server in watch mode on `127.0.0.1:4312`.
- `npm run build`: creates production output in `dist/`.
- `npm run start`: serves the built app from `dist/server/index.js`.
- `npm run typecheck`: runs strict TypeScript checks.
- `npm run lint`: runs ESLint across source and config files.
- `npm run test`: runs the Vitest suite once.
- `npm run test:watch`: runs tests in watch mode.

## Coding Style & Naming Conventions
This repo uses TypeScript with strict compiler settings. Follow Prettier defaults from `.prettierrc.json`: 2-space indentation, semicolons, single quotes, and trailing commas. Prefer named exports for modules and keep filenames descriptive and case-matched to their primary symbol: React components in `PascalCase.tsx`, utilities and state modules in `camelCase.ts`. Keep shared schemas and transport types in `src/shared/` so both server and client use the same contracts.

## Testing Guidelines
Vitest is configured with a Node test environment and includes `src/**/*.test.ts`. Add tests beside the code you change, for example `src/server/app.test.ts` or `src/web/terminals/presentation.test.ts`. Cover both schema/state changes and user-visible behavior. There is no enforced coverage threshold in the repo yet, so contributors should add targeted regression tests for every bug fix. Run a focused file with `npx vitest run src/shared/workspace.test.ts`.

## Commit & Pull Request Guidelines
Recent history uses short, imperative commit subjects such as `Fix focused terminal viewport sizing` and `Implement milestone 4 terminal canvas UI`. Keep commits narrowly scoped and explain behavior, not implementation trivia. PRs should include a concise summary, testing notes (`npm run test`, `npm run lint`, `npm run typecheck`), linked issues when relevant, and screenshots or recordings for visible canvas or terminal UI changes.

## Configuration & Safety Tips
The app binds to localhost by default and accepts `--port`, `--workspace`, and `--no-open` from the CLI. Prefer custom workspace files for experiments instead of editing `.terminal-canvas/workspace.json` by hand.

## Terminal Preview Requirement
Unfocused terminal windows must keep the same live-preview rendering style as focused terminal windows while background output is streaming. Do not replace background terminal previews with simplified text-only fallbacks or otherwise deviate from the focused-window visual behavior unless the user explicitly asks for that tradeoff.
