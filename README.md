# DexPermuter

**Same digits. Different destiny.** A fast, static tool for content creators running Shuffled Digit Pokédex Challenges.

Enter a National Pokédex number from **1–1025**. DexPermuter finds every valid digit shuffle and displays Pokémon types, abilities, base stats, and evolution families. Copy any card as plain text for your stream overlay.

## How shuffling works

The input is padded separately to a minimum of three and four characters, then every distinct permutation is generated. Leading zeros disappear when parsed as numbers. Results outside 1–1025 are discarded; the remaining results are merged, deduplicated, and sorted numerically. Your original number is included. Four-digit inputs are never truncated.

| Input | Three-character padding | Four-character padding | Combined results |
| --- | --- | --- | --- |
| 1 | `001` | `0001` | 1, 10, 100, 1000 |
| 100 | `100` | `0100` | 1, 10, 100, 1000 |
| 1025 | `1025` | `1025` | 125, 152, 215, 251, 512, 521, 1025 |

## Run locally

Use **Node.js 22 or later** and npm:

```sh
npm run serve
```

Open **http://localhost:3000**. The command downloads the pinned `serve` CLI through npx on first use. No `npm install` or build is required. Alternatively, use any static HTTP server. Opening `index.html` through `file://` is insufficient for browser ES modules.

Enter digits only; decimals, scientific notation, and values outside the supported range are rejected. Results update after 250 ms, or immediately on Enter or Shuffle.

## Tests

```sh
npm test
```

Tests use Node’s built-in runner and have no dependencies or network requirement. They cover the requested permutation examples and invalid inputs, exhaustive digit-signature comparisons across 1–1025, API caching and concurrency, timeouts, partial failures, evolution formatting, stale UI responses, and clipboard behavior. Controller tests use a minimal DOM harness; check visual layout and browser behavior separately when making UI changes.

## Project layout

```text
index.html                    Accessible application shell
css/styles.css                Responsive dark theme and type/stat colors
js/permute.js                 Pure permutation logic and validation
js/api.js                     PokéAPI requests, caching, and evolution summaries
js/app.js                     Debounced UI, cards, and clipboard handling
tests/                        Node test suites
.github/workflows/deploy.yml   Test and GitHub Pages deployment workflow
```

The browser loads native ES modules directly. There is no framework, bundler, backend, API key, or browser dependency. All asset URLs are relative so project sites work under a repository path.

## Data and reliability

Data comes from [PokéAPI](https://pokeapi.co/docs/v2). Requests use a shared four-request concurrency limit and ten-second timeout. Identical in-flight URLs share a request. Successful responses are cached by URL in localStorage for seven days, following PokéAPI’s fair-use guidance. When browser storage is blocked, corrupt, or full, memory caching keeps the tool usable. Clear site data in your browser to reset the persistent cache.

Cards fail independently and offer retry buttons. Core Pokémon information remains visible if species or evolution data fails. Changes to the input prevent stale responses from updating the current results.

The displayed stats, types, and abilities belong to the default Pokémon form. English species names preserve punctuation where available. Evolution summaries describe the complete species family, including branches, alternatives, and reported regional/form requirements. These are **general PokéAPI summaries**, not a version-specific rules engine; requirements can vary by game. Unrecognized or unavailable conditions are identified rather than guessed. Type badges use a consistent modern 18-type palette, with Electric yellow; bar lengths share a 255-point scale.

Clipboard access works best on HTTPS or localhost. A legacy copy fallback is attempted when the Clipboard API is unavailable or denied. Failure is shown on the affected card.

## Deploy to GitHub Pages

1. Push this project to a GitHub repository with a `main` branch.
2. In **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source.
3. Push to `main` or manually run **Deploy DexPermuter** from the Actions tab.

The workflow runs tests, stages only `index.html`, `css/`, and `js/`, then uploads and deploys the Pages artifact. Deployment uses the `github-pages` environment and the required `pages: write` and `id-token: write` permissions. Pull requests run the same tests without deploying. The deployment job reports the published URL. This repository does not require secrets or a committed dependency lockfile.

## Contributing

Use two spaces, single quotes in JavaScript, semicolons, and descriptive camelCase names; keep file names lowercase. Keep permutation logic independent of the browser. Use `textContent` for API-derived text, preserve visible focus states, and label information in addition to using color.

Run `npm test` before opening a pull request. Add regression tests for changed logic or API behavior. Describe the problem, resulting behavior, and validation; link a related issue when relevant and include screenshots for visual changes. Check narrow and wide layouts, keyboard use, failed requests, and copy behavior. Prefer imperative commit subjects such as `Fix repeated-digit permutation handling`. There is no established Git history or configured formatter/linter in this initial project.

## License and attribution

Application code is available under the [MIT license](LICENSE). Pokémon names and related intellectual property belong to their respective owners. DexPermuter is an unofficial fan project and is not affiliated with Nintendo, Game Freak, The Pokémon Company, or PokéAPI. The application license does not grant rights to third-party Pokémon content.
