# DexPermuter

**Same digits. Different destiny.**

**[Try DexPermuter](https://edwinshibumathew.github.io/DexPermuter/)**

Enter a National Pokédex number from **1–1025** to find Pokémon whose numbers share the same shuffled digits. Compare their types, abilities, base stats, and evolution families, then copy any result as plain text for your next challenge or stream.

For example, `100` finds **1, 10, 100, and 1000**.

## Run locally

Use **Node.js 22 or later** and npm:

```sh
npm run serve
```

Open [localhost:3000](http://localhost:3000). No install or build step is needed; the first run downloads the local server through npx.

Run tests with `npm test`.

## Browser regression tests

The browser suite runs the real page in headless Chromium at desktop and mobile sizes, using local PokéAPI fixtures. Install the development tools and Chromium once:

```sh
npm ci
npx playwright install --with-deps chromium
npm run test:browser
```

The test runner starts and stops its own local server under `/DexPermuter/`, matching the GitHub Pages path. Tests cover validation, rendering, clipboard behavior, cache recovery, and request cancellation across searches. Fixture self-tests verify offline interception after failures and track real streamed response bodies through completion or cancellation. Test execution makes no requests to the live PokéAPI. The application itself still needs no install or build step.

Pull requests and pushes to `main` run the Node and browser suites as separate jobs. Both must succeed before Pages deployment. Browser failures retain an HTML report, screenshots, and traces as Actions artifacts for seven days. To view a local report, run `npx playwright show-report`.

---

Pokémon data from [PokéAPI](https://pokeapi.co/). Code released under the [MIT license](LICENSE). An unofficial Pokémon fan project.
