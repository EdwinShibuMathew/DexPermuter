# DexPermuter

**Same digits. Different destiny.**

**[Try DexPermuter](https://edwinshibumathew.github.io/DexPermuter/)**

Enter a National Pokédex number from **1–1025** to find Pokémon whose numbers share the same shuffled digits. Compare their types, abilities, base stats, and evolution families, then copy any result as plain text for your team or stream.

For example, `100` finds **1, 10, 100, and 1000**.

## Run locally

Use **Node.js 22 or later** and npm:

```sh
npm run serve
```

Open [localhost:3000](http://localhost:3000). No install or build step is needed; the first run downloads the local server through npx.

Run tests with `npm test`.

## Build a team

Click **Add to team** on any result to create **My team** immediately. Keep searching different numbers to add more Pokémon. Members stay in selection order; use **Move up**, **Move down**, or **Remove** to edit the roster. There is no six-member cap, and each Pokémon can appear once per team.

Rename your team, add notes, or **Inspect** a member without changing your search. Use **Continue team** or **Saved teams → Open team** when you return. Existing saved challenges and old backups open as teams with their names, notes, and selections preserved.

Teams autosave in this browser. **Download backup** and **Restore backup** transfer them between devices; clearing site data removes local saves. If saving fails, keep editing, retry, or download your current team. Other-tab changes pause autosave until you reload or save a copy. Names allow 80 characters, notes 1,000, and the library/backup limit is 1 MiB. Pokémon details need a connection unless cached.

The app remains buildless and browser-only, with no accounts, application server, or API keys. Team saves do not expire with the seven-day Pokémon cache.

## Browser regression tests

The browser suite runs the real page in headless Chromium at desktop and mobile sizes, using local PokéAPI fixtures. Install the development tools and Chromium once:

```sh
npm ci
npx playwright install --with-deps chromium
npm run test:browser
```

The test runner starts and stops its own local server under `/DexPermuter/`, matching the GitHub Pages path. Tests cover validation, rendering, clipboard behavior, cache recovery, request cancellation, and team editing, migration, autosave, backups, and recovery. Fixture self-tests verify offline interception after failures and track real streamed response bodies through completion or cancellation. Test execution makes no requests to the live PokéAPI. The application itself still needs no install or build step.

Pull requests and pushes to `main` run the Node and browser suites as separate jobs. Both must succeed before Pages deployment. Browser failures retain an HTML report, screenshots, and traces as Actions artifacts for seven days. To view a local report, run `npx playwright show-report`.

---

Pokémon data from [PokéAPI](https://pokeapi.co/). Code released under the [MIT license](LICENSE). An unofficial Pokémon fan project.
