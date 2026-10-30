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

## Save a challenge

Search for a number and choose **Save challenge**, or shortlist a card to name a new challenge. Saved searches keep their starting number, shortlisted candidates, and an episode note. Shortlist changes save immediately; notes save after a 300 ms pause. Use **Continue challenge** or **View saved challenges → Resume** on your next visit. A different starting number begins a new draft; it does not overwrite your saved challenge.

Challenges stay in this browser until you delete them or clear site data. They do not expire with the Pokémon cache. **Download backup** exports JSON; **Restore backup** lets you transfer it to another browser. Identical records are skipped and conflicting records become copies. Restore validates the entire file before importing and reports partial storage failures. Backups and the saved library are limited to 1 MiB; names allow 80 characters and notes allow 1,000.

If storage is blocked or full, the page keeps your current edits in memory and marks them unsaved. Retry saving, download a backup, or use **Download current challenge** to export just those edits. Other-tab changes pause autosaving until you reload or save a copy. Pokémon details still require a connection unless they are already cached; a saved challenge is not an offline copy of the page or API data.

## Architecture

DexPermuter will remain a **JAMstack application**: static files, browser-side behavior, and external APIs. It requires no application server, accounts, API keys, or browser dependencies. GitHub Pages serves the site without a build step. User records use `dexpermuter:challenges:v1:` storage keys, separate from the seven-day PokéAPI cache.

For the creator pilot, have five creators save a named search, shortlist candidates, and write a note. In a second session, ask each to resume their challenge without re-entering it, then download and restore a backup. Record whether the number, shortlist, and note are recovered, any assistance required, and whether this replaces their current preparation workflow. This pilot requires real participants; automated tests do not establish retention gains.

## Browser regression tests

The browser suite runs the real page in headless Chromium at desktop and mobile sizes, using local PokéAPI fixtures. Install the development tools and Chromium once:

```sh
npm ci
npx playwright install --with-deps chromium
npm run test:browser
```

The test runner starts and stops its own local server under `/DexPermuter/`, matching the GitHub Pages path. Tests cover validation, rendering, clipboard behavior, cache recovery, request cancellation, and challenge saving, autosave, backups, and recovery. Fixture self-tests verify offline interception after failures and track real streamed response bodies through completion or cancellation. Test execution makes no requests to the live PokéAPI. The application itself still needs no install or build step.

Pull requests and pushes to `main` run the Node and browser suites as separate jobs. Both must succeed before Pages deployment. Browser failures retain an HTML report, screenshots, and traces as Actions artifacts for seven days. To view a local report, run `npx playwright show-report`.

---

Pokémon data from [PokéAPI](https://pokeapi.co/). Code released under the [MIT license](LICENSE). An unofficial Pokémon fan project.
