# @survive/desktop

The Electron shell. It does two things and deliberately nothing else:

1. Opens a window that hosts the Phaser client.
2. For single-player, spawns the headless `GameServer` as a child process on loopback
   and hands the renderer the port and one-shot token.

```
Game.exe
  ├─ Electron ── Phaser client (renderer)
  └─ child_process ── GameServer  ← 127.0.0.1
```

No game rules live here (Architecture Guard rule 3). The renderer talks to the server
over the same protocol it would use for a remote dedicated server, so single-player and
multiplayer are the same code path with a different address.

## Development

```bash
npm run dev:client        # Vite serves the Phaser client on :5173
npm run dev:desktop       # builds main/preload, starts Electron against it
```

`SURVIVE_CLIENT_URL` overrides where the window loads from.

## Packaging

```bash
npm run build:client
npm run build:server
npm run package --workspace @survive/desktop
```

The client and server bundles are copied in as extra resources; the packaged app
launches `resources/server/server.cjs` with Electron's own binary running as Node.
