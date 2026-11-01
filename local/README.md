# vega-local

Local execution agent for Vega. No UI, system-tray icon only (headless on
Linux/macOS). When it runs, cloud sessions on the same machine delegate
`read`/`write`/`edit`/`bash`/`change_working_directory` to this computer
instead of the server. `chrome` and `sqlite:` paths always stay on the server.

## Run

Double-click `vega-local.exe` (Windows) or run the binary. No configuration:
it registers with the Vega server at `VEGA_LOCAL_URL` (default
`http://127.0.0.1:8080`), so it must run on the same machine as Vega.

- **On** = tray icon appears → cloud tools run locally within ~1s.
- **Off** = icon quits → tools fall back to the server immediately (3.5s max
  if killed hard). Brief network loss is tolerated; a real call that can't
  reach the agent falls back to the server for that turn.

Files/commands run in the session's `cwd` on this machine. The agent binds
`127.0.0.1` only and requires a per-start secret for every request.

## Build

```powershell
cd local
go build -o vega-local.exe .   # Windows (tray)
GOOS=linux go build .           # headless
```

CI (`.github/workflows/build-local-agent.yml`) builds Windows (tray),
Linux and macOS binaries on every push that touches `local/`.
