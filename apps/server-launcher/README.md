# @survive/server-launcher

A GUI for running a dedicated server. It configures and supervises a `GameServer`
child process — it never hosts the simulation itself (spec section 16).

```
ServerLauncher.exe
      └── GameServer.exe
```

- Form fields map one-to-one onto the server's command-line flags, so anything the
  launcher can do is also doable from a terminal.
- Telemetry comes from the server's own `/status` endpoint on `port + 1`; CPU percent is
  derived by differentiating two absolute CPU-time samples.
- Settings persist to `launcher-settings.json` in the app's user-data folder, merged
  over defaults so an older file still loads.

Closing the launcher stops the server it started. To run a server that outlives the
GUI, launch `GameServer` directly — which is exactly why they are separate processes.

## Development

```bash
npm run dev:launcher
```
