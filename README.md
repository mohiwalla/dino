# Dino 3D

Chrome's offline T-Rex runner, rebuilt in 3D with a voxel look. The physics, obstacles, scoring and
night mode follow Chromium's original runner step for step, at 60 steps per second. The 2D pixel-art
sprites become sculpted voxel models, drawn in Chrome's monochrome palette (#535353 on #f7f7f7) with
soft shadows. Built with Vite, three.js and TypeScript.

## Controls

| Action | Keyboard | Touch | Gamepad |
| --- | --- | --- | --- |
| Start / jump (hold for a higher jump) | Space, Up, W | Tap | A, B, D-pad up, left stick up |
| Duck (speed-drop in the air) | Down, S | Swipe down and hold | D-pad down, left stick down |
| Restart after game over | Space, Enter | Tap | A, Start |
| Switch camera | C | Camera button | – |
| Mute | M | Speaker button | – |
| Dark mode | D | Moon / sun button | – |
| Pause / resume | P, Escape | Pause button | – |
| Debug view (collision boxes, FPS) | ` (backquote) | – | – |

The game also pauses on its own when the tab is hidden, and resumes when the tab comes back.

## Camera modes

- **cinematic** (default): a three-quarter view from the side, slightly behind and above.
- **side**: the classic square-on 2D framing, with a long lens from far away.
- **chase**: over the shoulder, looking down the track.

The game remembers the last mode you used. On the title screen the camera starts in a close-up and
swoops out to the play framing when the run starts.

## Query parameters

| Param | Effect |
| --- | --- |
| `?seed=N` | Deterministic obstacle RNG (mulberry32). |
| `?autoplay=1` | The built-in autopilot plays (and starts) the game. |
| `?debug=1` | Show collision boxes and an FPS counter. |
| `?cam=cinematic\|side\|chase` | Starting camera mode (takes priority over the saved one). |
| `?theme=dark|light` | Starting theme (otherwise the saved choice, then the OS setting). |
| `?replay=<run id>` | Play back a stored leaderboard run (signed in; see the admin page). |

For tests, `window.__dino` exposes `getSnapshot()`, `advance(n, input?)`, `setAutoplay(on)`,
`setCameraMode(mode)`, `freeze(on)` (stop real-time stepping, keep rendering), `info` (triangles,
draw calls) and `fps`.

## Scripts

```sh
bun install
bun run dev        # Vite dev server
bun run build      # type-check (tsc) + production build into dist/
bun run preview    # serve dist/
bun test           # simulation, autopilot, replay and run-verification tests
bun run dev:api    # the leaderboard Worker on :8787 (Vite proxies /api to it)
bun run deploy     # build, migrate D1, deploy the Worker
node scripts/playtest.mjs http://localhost:4173/   # headless playtest, screenshots in /tmp/dino-shots/playtest/
node scripts/shot.mjs <url> <out.png> [options]   # one-off headless screenshots
node scripts/offline-check.mjs http://localhost:4173/   # loads once, goes offline, reloads and plays
bun scripts/make-favicon.ts                       # regenerate public/favicon.ico from the T-Rex sprite
```

The `dev/` folder has standalone test pages for each module (`/dev/models.html`, `/dev/world.html`,
`/dev/entities.html`, `/dev/ui.html`, `/dev/sim-debug.html`, ...).

## Layout

- `src/types.ts`, `src/config.ts`: the shared contracts and every tunable constant.
- `src/sim/`: the deterministic game simulation and the autopilot.
- `src/render/`: voxel mesher, models, world (sky, ground, lights, night), entities, camera.
- `src/ui/`, `src/input/`, `src/audio/`: the pixel HUD, input and sound effects.
- `src/net/`: the leaderboard API client and ranked-run recording.
- `src/main.ts`: the fixed-step loop that wires everything together.
- `worker/`, `migrations/`, `wrangler.jsonc`: the leaderboard server (a Cloudflare Worker with D1).

## Offline

Production builds register a service worker (`sw/sw.js`, filled in by the plugin in `vite.config.ts`) that precaches every file of the build. After one online visit, the game loads and plays with no network. Each build gets a new cache version, and old caches are deleted. The dev server never registers it.

## Team leaderboard

The game is deployed as one Cloudflare Worker (`wrangler.jsonc`): `/api/*` is the leaderboard
server in `worker/`, everything else is the Vite build. Players sign in with Microsoft Entra ID.
The app registration "Dino 3D Leaderboard" is single-tenant, so only Sifars accounts get in.
The board shows each player's best verified run.

The browser never sends a score. A ranked run works like this:

1. When a run starts, `POST /api/runs` returns a fresh random obstacle seed from the server.
   The seed has to arrive before the first obstacle spawns (3 s in), or the run isn't ranked.
2. The browser records every step's input (`src/sim/replay.ts`). Every 10 s, and on pause and
   resume, it uploads what it has so far with the step count (a "beat").
3. At the crash it sends the rest. The server replays the whole log in a fresh sim and takes
   the score from that (`worker/verify.ts`).

The server also checks the run against its own clock and against the autopilot:

- A run that plays steps faster than real time is rejected.
- These runs go to an admin for review, and stay off the board until approved:
  - runs slower than real time (slow motion);
  - runs with more than 3 pauses;
  - runs whose jumps land on the autopilot's exact step;
  - runs whose jump holds are all the same length.

Admins (`ADMIN_EMAILS`) use `/admin` to watch runs (`?replay=`), approve or void them, and ban
players.

`SIM_VERSION` in `src/sim/replay.ts` must be bumped whenever a change alters how runs play out.
`test/sim-replay.test.ts` fails until it is. The server refuses runs from other versions.

Local development: put `ENTRA_CLIENT_SECRET`, `ORIGINS=http://localhost:5173` and `DEV_LOGIN=1`
in `.dev.vars` (gitignored), then run `bun run dev:api` next to `bun run dev`.
`/api/auth/dev?name=Alice` signs in a fake player, and only works when every origin is localhost.
