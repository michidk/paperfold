# Paperfold

Fold a paper plane, paint it, throw it off the tower and leave it in the
city for everyone to find.

Play it at <https://michidk.github.io/paperfold/>.

## Features

- **Workshop:** draw lengthwise folds and tail cuts on an A4 sheet, set
  each fold's angle per wing, mirror or design each half on its own, and
  paint both faces. The paper can't tear or fold through itself.
- **Physics:** every panel of the folded sheet is a flat plate with lift,
  drag and stall. The plane flies whatever shape you fold, with no preset
  flight characteristics.
- **Throwing:** pick a direction, then time the power and angle. Steer
  with the keyboard or by dragging on touch screens.
- **The city:** windy crossroads, thermals over the parks, and cars and
  people in the streets that planes collide with.
- **Multiplayer:** see who's playing and what they're doing, watch other
  flights live, and compare on the leaderboard. Landed planes stay in the
  city.
- **Lab:** test a design in still air, with the same throw every time,
  live telemetry, force arrows and flight profiles to compare runs.
- **Offline:** without a server the game still works, with flights and
  scores kept in the browser.

## How it works

The code is TypeScript in three parts:

- `client/`: the browser game, built with [Vite](https://vite.dev) and
  [three.js](https://threejs.org).
- `server/`: a [Bun](https://bun.sh) server that runs every flight and
  keeps landed planes in SQLite through [Drizzle](https://orm.drizzle.team).
- `shared/`: the plane model, physics and city, used by both.

The server is authoritative: it simulates each throw from the inputs the
player sends, so distances can't be faked. The thrower's browser runs the
same simulation ahead of it for instant steering, and corrects itself when
the two disagree. Wind, thermals and traffic move with a shared world
clock, so every machine sees the same city.

## Development

Requires [Bun](https://bun.sh) 1.4.

```sh
bun install
bun run dev:server   # game server on port 3001
bun run dev          # client with hot reload, proxying to the server
```

Before committing, run the same checks as CI:

```sh
bun run verify       # lint, types, tests, dead code and build
```

| Script | What it does |
| --- | --- |
| `bun run build` | Builds the client into `dist/` |
| `bun run start` | Runs the server, serving `dist/` |
| `bun run test` | Runs the tests |
| `bun run check` | Lints and checks formatting with Biome, and the docs |
| `bun run check:fix` | Fixes what Biome can |
| `bun run typecheck` | Type checks with `tsc` |
| `bun run lint:deadcode` | Finds unused files and exports with knip |
| `bun run db:generate` | Creates a migration after changing `server/db/schema.ts` |

## Configuration

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `PORT` | server | `3000` | Port to listen on |
| `DATA_DIR` | server | `./data` | Where the database and plane paint are kept |
| `PAPERFOLD_SERVER` | client build | empty | Game server URL for a client hosted elsewhere |

With `PAPERFOLD_SERVER` empty, the client talks to the server that served
it. Set it when hosting the client separately, for example on GitHub
Pages, to the server's `https://` address.

## Deployment

### Docker

Every push to `main` publishes an image to
`ghcr.io/michidk/paperfold`. It runs the server and serves the client.
Keep `/data` on a volume:

```sh
docker run -d -p 3000:3000 -v paperfold-data:/data ghcr.io/michidk/paperfold:latest
```

The container reports its health at `/healthz`.

### GitHub Pages

The `Deploy client to GitHub Pages` workflow publishes the client on every
push to `main`. Set the repository variable `PAPERFOLD_SERVER` to point it
at a game server. Without one, the Pages site plays offline.

## License

[MIT](LICENSE)
