# Repository Guidelines

## Project Structure & Module Organization

DexPermuter is a buildless static application. `index.html` contains the accessible page shell; `css/styles.css` provides the responsive dark theme. Keep pure validation and permutation logic in `js/permute.js`, PokéAPI requests and enrichment in `js/api.js`, and DOM interactions in `js/app.js`. There is no separate asset directory or browser dependency. Node tests live in `tests/`; GitHub Pages deployment lives in `.github/workflows/deploy.yml`.

## Build, Test, and Development Commands

- `npm run serve`: serve the repository at `http://localhost:3000` using a pinned npx `serve` CLI. The first invocation needs network access.
- `npm test`: run all tests with Node’s built-in test runner; no installation or network access is required.
- `node --check js/app.js`: check JavaScript syntax without running the UI.

Use Node.js 22 or later. There is no build command. Load modules through HTTP rather than opening the HTML file directly.

## Coding Style & Naming Conventions

Use two-space indentation, single-quoted JavaScript strings, semicolons, camelCase functions and variables, and uppercase constants. File names are lowercase; tests use `*.test.js`. No formatter or linter is configured. Keep browser code dependency-free and use native ES modules. Render API-derived text through `textContent`; preserve semantic markup, visible focus states, and non-color labels.

## Testing Guidelines

Use `node:test` with `node:assert/strict`. Test changed permutation or enrichment behavior with meaningful regression cases. API tests inject fetch and storage substitutes and must remain offline. No percentage coverage threshold is configured. Check mobile and wide layouts, keyboard navigation, independent card failures, and clipboard fallback when changing the UI.

## Commit & Pull Request Guidelines

No established Git history is available in this initial workspace. Use concise imperative subjects, such as `Fix repeated-digit permutation handling`. Pull requests should explain the problem, resulting behavior, and validation. Link related issues when relevant and include screenshots for visual changes. Run `npm test` before requesting review; pull requests also run tests in Actions.

## Configuration & Deployment

No API keys or secrets are needed. Keep asset paths relative for repository-scoped GitHub Pages hosting. Successful API responses are cached locally for seven days; requests share a four-request limit. Preserve those safeguards when modifying data fetching.
