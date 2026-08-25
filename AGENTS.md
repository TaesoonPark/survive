# AGENTS.md — working rules for this repository

A top-down survival game. Authoritative Node simulation, Phaser 4 renderer, one
server binary for both single-player and multiplayer.

Read this before touching code. The architecture rules below are not style
preferences: breaking them breaks single-player/multiplayer parity, determinism, or
the headless test suite.

## Layer map

```
@survive/protocol      pure contracts: state, commands, events, messages, RNG, clock
      ↓
@survive/game-data     static content tables (items, recipes, creatures, loot)
      ↓
@survive/world         chunked tile world: terrain gen, collision, LOS, pathfinding
      ↓
@survive/simulation    ALL game rules. Fixed tick. Deterministic. Headless.
      ↓
apps/server            Colyseus rooms, AOI replication, persistence I/O, CLI
apps/client            Phaser 4: rendering, input, prediction, UI, audio
@survive/persistence   repository interfaces + filesystem/SQLite/in-memory backends
@survive/netcode       client-side networking: connection, prediction, interpolation
```

Dependencies only ever point _down_ this list. `protocol` depends on nothing at all.

## The twelve rules (from the spec's Architecture Guard)

1. Phaser is the rendering/client layer. Nothing else.
2. Game rules never import Phaser, and never depend on it indirectly.
3. No game logic in Electron. Electron only spawns processes and shows windows.
4. The server is authoritative. Clients send _intents_, never outcomes.
5. Single-player and multiplayer run the same `GameServer`. Differences are config.
6. Core gameplay state is plain JSON-serializable data. No class instances in state.
7. All randomness goes through the seeded `Rng`. `Math.random()` is lint-banned in
   `simulation`, `world` and `game-data`.
8. The simulation runs on a fixed tick and reads `SimulationClock`, never the wall
   clock. `Date.now()` is lint-banned in the same packages.
9. The world is chunked. Never hold the whole world in one state blob.
10. Networking is area-of-interest based from the start.
11. Persistence goes through `WorldRepository`; game logic never sees a DB.
12. The server runs headless — no Chromium, no Phaser, no DOM.

## Units and conventions

- **World space is pixels.** `TILE_SIZE = 32`. A chunk is 32×32 tiles = 1024 px.
- Speeds are px/second, durations are seconds in data and _ticks_ in state.
- Angles are radians, `0` = +X, increasing clockwise (+Y is down, screen space).
- **Needs use need semantics**: `hunger`, `thirst`, `fatigue` are `0` = satisfied,
  `100` = critical. They rise over time. `health`, `stamina` and body-part health run
  the other way (`0` = empty). The HUD renders `100 - hunger` as a food bar.
- Every replicated entity carries `rev`. **Bump it on every mutation** (`bump(entity)`
  from `@survive/simulation`) or the change never reaches clients.
- Ids: `z*` zombie, `a*` animal, `i*` item, `r*` projectile, `s*` structure, `n*` node.
  Players use their account id.

## Writing a system

```ts
export function createThingSystem(): System {
  return {
    id: 'thing',
    order: SystemOrder.Thing,
    init(ctx, router) {
      router.on('someCommand', (ctx, player, command) => {
        /* validate, then apply */
      });
    },
    update(ctx) {
      /* one fixed tick */
    },
  };
}
```

- A system may only read/write `ctx.state`, emit through `ctx.events`, and query
  `ctx.world` / `ctx.data`. No I/O, no timers, no globals.
- Validate everything that came from a client: distance, ownership, cooldowns,
  resources, line of sight. Assume the client is lying.
- On rejection, emit `commandRejected` or `notification` so the UI can explain itself.
- Use `ctx.rng.fork('label')` for a subsystem's own rolls so unrelated changes
  elsewhere do not shift its results.

## Testing

- `npm run test` — Vitest, all projects.
- Unit tests live next to the code as `*.test.ts`; cross-package tests live in
  `tests/{unit,integration,multiplayer}`.
- A headless simulation test is the default tool: build a `Simulation`, `step()` it,
  assert on state. No server, no renderer, no waiting on real time.
- `npm run typecheck` must be clean. `npm run lint` must be clean.

### Run every new test against the unfixed code

The single habit that earned the most on this codebase. Before trusting a regression test,
put the bug back and watch the test fail. A test that passes either way proves nothing, and
this project produces that outcome constantly - because the harness is a double, because
message types are terse strings, because a scenario turns out to be geometrically
impossible. Every one of those looks exactly like a green test.

Real examples from one session, all initially written as passing tests that proved nothing:

- A server-crash test sent to `'requestChunks'` instead of `ClientMessage.RequestChunks`.
  Nothing was listening. It passed against the crashing server, and I nearly filed the
  finding as overstated.
- A "zombie cannot swing through a wall" test placed the zombie _inside_ the wall and
  passed only because the double froze bodies embedded in geometry. The scenario is
  unreachable: reach is 41 px and a wall is 32 px thick.
- A stale-animal-bite test let the animal pass through states that expire the bite
  normally, so the frozen-bite path was never entered.
- A gathering test counted `wood_plank` from a tree that drops `wood_log`, comparing 0 to 0.

When the negative check refuses to fail, the test is wrong until proven otherwise. Fix the
test, not the claim.

### A test double may not survive less than the real thing

`createTestSimulation` runs on `createFlatWorld`, not on `createWorld`. The flat world is
a real implementation - it slides, raycasts, paths and integrates flow fields - and that
is exactly why it is dangerous when it drifts: it is trusted like the real grid.

`flatWorld.moveCircle` once lacked the non-finite guard that `collision.ts` has. A test
that fed the movement system an infinite impulse - defending a guard that _works_ - hit
`Math.ceil(Infinity / 16)` sub-steps inside the double and spun the worker forever
instead of failing. The whole unit project hung, so **no unit numbers could be collected
at all**, and every attempt left an orphaned process pegging a core, which then made
unrelated timing assertions flaky. One missing guard in a double cost the entire suite.

It was not one gap but a family. An adversarial audit later found three more in the same
file, and all three reproduced: `traverse` (behind `raycast` and `hasLineOfSight`) lacked
both of `raycast.ts`'s guards and spun forever on a non-finite endpoint; `moveCircle` had
no "already embedded in geometry" escape, so it pinned a body the real grid frees;
`getFlowField` never expired a cached field, so harness steering followed a route computed
before the test carved its wall. Each of those turns a harness defect into what looks like
a bug in the code under test - or into another silent, uninterruptible hang.

When you change a contract in `packages/world`, change the double in the same commit, and
prefer importing the real constant (`MAX_SWEEP_SUBSTEPS`,
`DEFAULT_FLOW_FIELD_MAX_AGE_TICKS`) over restating its value. `tests/unit/harness.test.ts`
holds the contract tests; add to them rather than trusting the double by inspection.

### A flag that does not fit its store is dropped in silence

`CollisionFlag` filled exactly eight bits and the grid stored a `Uint8Array` per chunk.
Adding a ninth (`NodeOpaque`, `1 << 8`) truncated it to zero on the way into storage - no
error, no warning, and the bit read back as absent.

Every test still passed, because the simulation suite runs against `createFlatWorld`, whose
store is a plain array where a ninth bit is fine. The shipping grid dropped it. The fix
would have stopped trees blocking sight altogether: strictly worse than the bug it was
meant to fix, and invisible from the test suite.

The store is now a `Uint16Array`, and `collision.test.ts` asserts that every member of
`CollisionFlag` round-trips through the _real_ grid. Add a flag and that test tells you
immediately whether it fits.

### When a suite hangs, bisect by file with an OS-level kill

A synchronous infinite loop cannot be interrupted by Vitest's `testTimeout`: the event
loop never gets a turn, so the timeout never fires and the run has no failure to report.
Symptoms are a worker at ~80% CPU and a log that stops mid-file. Reporter output is
batched, so the last test printed is _not_ the one that hung.

Run each file in turn with a hard `kill -9` after a fixed budget and record which one
never exits, then narrow to the `describe` and the `it` the same way. `ps -eo pid,etime`
finds orphans from earlier attempts - kill them before measuring anything, or they will
skew every number you collect afterwards.

### Verifying the client

Use Playwright (`npm run test:gameplay`). It drives real Chromium against a real server
and asserts on authoritative state through the `window.__survive` hook, so a test says
"the player moved east" rather than "some pixels changed".

Do **not** judge the client from an embedded or backgrounded preview browser. A hidden or
throttled tab does not run `requestAnimationFrame`, so no scene steps: the camera never
follows the player and the world renders as a black screen even though nothing is wrong.
`actualFps` keeps reporting a stale number, which makes it look like a performance
problem. The symptom is indistinguishable from a real frame-loop bug and costs an hour to
chase. Authoritative performance numbers come from `tools/simulate.ts` (server ticks) and
the gameplay suite (client frames).

Two things about that suite are worth knowing before you add to it.

**All the gameplay tests share one server and one save**, and several of them move the
player. A test that walks in a fixed direction and asserts it found something therefore
passes or fails on where the _previous_ test left the player - it looks like flake and is
actually order dependence. Aim instead: `__survive.nearest(kind)` reports the closest
replicated entity, and `walkTowards` in `tests/gameplay/helpers.ts` closes on a point.

**The preview server is reused between runs** (`reuseExistingServer: !CI`), so a change to
client source is _not_ picked up until the bundle is rebuilt. A new `window.__survive`
method failing with "is not a function" means a stale `dist`, not a broken hook - run
`npm run build --workspace @survive/client` and retry.

### A refund must give back what was taken

Crafting reserves its inputs at queue time - they leave the pack and the job holds them.
The refund used to rebuild them from their definitions with `createStack`, which returns
full durability and full freshness. Since `removeFromInventory` deliberately consumes the
_worst_ stacks first, queue-then-cancel was a spoilage cure and the only item-repair
mechanic in a game that has none.

`CraftJobState.reserved` now records the exact stacks a job took, worst-first, and the
refund hands those back (the better tail, on a partial cancel). The field is optional so a
save written before it existed still refunds by minting.

The general shape: whenever state leaves one place to be held somewhere else, the holder
has to hold the _thing_, not a description of it. Anything reconstructed from a definition
has lost whatever made that instance different.

### Wire names are short; a message to an unregistered type vanishes

`ClientMessage` values are terse strings - `in`, `cmd`, `ping`, `reqchunk` - not the
readable channel names. Colyseus drops a message whose type has no handler, silently, so a
test that sends `room.send('requestChunks', ...)` proves nothing at all: no handler runs,
nothing throws, everything passes.

That cost real time. An adversarial audit reported that one malformed chunk key shuts the
server down; two of my tests "failed to reproduce" it and I was ready to write the finding
off as overstated. Both were sending to types that did not exist. With the real constants
the same probe shows `exitCode: 0` and `uncaught exception` in the log - the report was
right and my tests were wrong.

Always send through `ClientMessage.*`, and when a negative check refuses to reproduce a
plausible bug, suspect the harness before concluding the bug is not real.

### An in-process server cannot show you a crash

`main.ts` installs an `uncaughtException` handler that shuts the server down. A test using
`createLiveServer` runs the room inside the test process, which has no such handler, so an
exception escaping a message handler is merely reported and every assertion still passes.
Verifying "a client cannot kill the server" therefore needs the real binary as a child
process - see `tests/multiplayer/processResilience.test.ts`, which asserts on
`child.exitCode` and then makes a fresh client join.

### Snapshots replicating is not the same as the game working

`GameServer.tick()` _drains_ the event sink and returns what it drained. `pump()` used to
call it as `void this.tick()`, and the room then drained the sink a second time - always
empty. Every client received zero `SimEvent`s: no damage numbers, no hit flashes, no
notifications, no level-ups. Single player included, because it runs the same room over
loopback.

Nothing caught it. Snapshots carried state perfectly, so the world looked completely
correct; only the feedback layer was gone, and no test asserted a client had _received an
event_ as opposed to seen the resulting state. `Bot.events` and `Bot.waitForEvent` existed
the whole time and nothing used them.

When you add a replication path, test the path and not just its consequences - and when
one function's contract is "returns what it consumed", make sure every caller keeps the
return value, because a second read finds nothing.

### Packaging is a second, unchecked statement about layout

Electron Forge's `extraResource` copies each path into `resources/` under its own
**basename** and cannot rename. So `forge.config.cjs` and the `join(process.resourcesPath,
...)` calls in `main.ts` are two independent descriptions of the same layout, and nothing
about building or testing compares them.

They had drifted. Both apps shipped `apps/*/dist`, which lands as `resources/dist` - so
the desktop app shipped two directories that collided on one name and then looked for
`resources/client/index.html` and `resources/server/server.cjs`, finding neither. The app
still starts and shows its "client bundle missing" fallback, so nothing fails anywhere: a
packaged build was simply incapable of running the game. `scripts/stage.mjs` now makes
correctly named copies from a `prePackage` hook, and `tests/unit/packaging.test.ts` asserts
the contract from both sides.

The general lesson: a bundle that builds is not a bundle that runs. There is no display in
this environment, so the GUIs cannot be launched - but the built main process _can_ be
booted against a stubbed `electron` module, which is enough to check window security flags
(`contextIsolation`, `nodeIntegration`, preload) and which resource paths it resolves in
dev versus packaged mode. That is how the bug above was found.

## Order of work (spec section 38)

Requirement → simulation → unit test → server integration → multiplayer test →
client → Playwright gameplay test → visual check. Never build UI first and bolt the
rules on afterwards.

## Known deviation: Colyseus version pairing

`colyseus@0.17` (server) and `colyseus.js@0.16` (client) are the newest published
pair, and their matchmaking payloads differ: 0.17 returns a flat seat reservation
where the 0.16 client expects `{ room: {...}, sessionId }`. `@survive/netcode`
re-nests it and then calls `client.consumeSeatReservation`, which the WebSocket
protocol accepts unchanged. Do not "fix" this by downgrading the server:
`@colyseus/core@0.16.x` is published with unresolvable `workspace:^` dependency
ranges and cannot be installed from npm.
