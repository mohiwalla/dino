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

For tests, `window.__dino` exposes `getSnapshot()`, `advance(n, input?)`, `setAutoplay(on)`,
`setCameraMode(mode)`, `freeze(on)` (stop real-time stepping, keep rendering), `info` (triangles,
draw calls) and `fps`.

## Scripts

```sh
bun install
bun run dev        # Vite dev server
bun run build      # type-check (tsc) + production build into dist/
bun run preview    # serve dist/
bun test           # simulation + autopilot tests
node scripts/playtest.mjs http://localhost:4173/   # headless playtest, screenshots in /tmp/dino-shots/playtest/
node scripts/shot.mjs <url> <out.png> [options]   # one-off headless screenshots
bun scripts/make-favicon.ts                       # regenerate public/favicon.ico from the T-Rex sprite
```

The `dev/` folder has standalone test pages for each module (`/dev/models.html`, `/dev/world.html`,
`/dev/entities.html`, `/dev/ui.html`, `/dev/sim-debug.html`, ...).

## Layout

- `src/types.ts`, `src/config.ts`: the shared contracts and every tunable constant.
- `src/sim/`: the deterministic game simulation and the autopilot.
- `src/render/`: voxel mesher, models, world (sky, ground, lights, night), entities, camera.
- `src/ui/`, `src/input/`, `src/audio/`: the pixel HUD, input and sound effects.
- `src/main.ts`: the fixed-step loop that wires everything together.
