# vega-local

Run the updated client and sign in to Vega **once on that computer**. The desktop webpage passes a one-use, 15-second ticket to `ws://127.0.0.1:47673/agent`. After you approve the local site permission, the native client exchanges that ticket directly with the backend for a revocable device credential. The credential never enters the webpage.

After pairing, the client connects directly to `/api/local-agent/socket` with its device credential. **You may close the webpage, let the browser sleep, or use Vega from a phone.** As long as the computer, client and network remain available, it stays usable. Client and server restarts reconnect automatically without a new website login; network reconnects never replay jobs. HTTPS/WSS is required except for local loopback development.

The website lists online clients by computer name, platform and short device ID, scoped to the current account. A client becomes offline when its native socket closes or its heartbeats expire. Phones/tablets do not connect to a loopback client; they select an authorized online computer through the server.

New conversations default to a client when any are online, otherwise the server. The **服务端 / 客户端** switch and device selector choose the exact computer. Existing conversations never move automatically when devices connect/disconnect. Finish or stop the current turn (including Fire) before changing devices or modes. An offline selected client blocks new commands even if another client is online.

A manual switch validates the destination, remembers the server and **each device's** working directory separately and restores it when switching back. Missing remembered directories fall back to that side's root, never another computer's path. Files are **not** synchronized. Stage, fork and Fire inherit the selected device. `read`, `write`, `edit`, `bash` and directory changes run there; `sqlite:` archives, skills and Chrome remain server-side.

If a response is lost, work pauses so you can inspect the actual result, repair the connection and explicitly continue. No command is replayed or silently rerun on another device or the server. Disconnecting or cancelling a session cancels pending native shell processes. Closing the webpage does **not** disconnect the native client or cancel its work.

## Device credentials and revocation

The per-user config directory contains `vega-local/trusted-sites.json`: the stable device ID, trusted origins and paired credentials. Windows protects tokens with current-user DPAPI; Unix stores them in a mode-0600 file under the user's config directory. The server stores only token hashes, bound to one account/device; these tokens cannot log into the website or call general APIs. No website password or login cookie is stored by the client.

Windows tray → **连接授权** can revoke a trusted site: it removes its local credentials and stops its native connections. Account password/role changes and disabling access revoke the backend's device credentials too. A logged-in user can revoke one of their own devices with `POST /api/local-agent/revoke` and `{clientId}` (normal cookie/CSRF protection). Revoked clients require a fresh website handshake; repeated authorization while a healthy token exists reuses it without interrupting work. Website logout and the 7-day website cookie expiry do not revoke an independently authorized device.

Upgrade the server, webpage and native binary together. Old webpage job relays are no longer used. Existing stable device IDs and trusted origins are preserved; open the desktop website once after upgrading to obtain a device credential. Historical sessions without a device binding still require choosing a device once.

Reverse proxies must forward WebSocket Upgrade/Connection and the Authorization header for `/api/local-agent/socket`, in addition to `/api/events` and `/api/chrome/live`. No extra public port is needed; never expose the client's loopback port.

## Build

Windows (system tray only, no console window):

```powershell
go test ./...
go build -ldflags="-H=windowsgui" -o vega-local.exe .
```

Use the rebuilt `.exe`, not an older download or `go run .`. Windows detaches the client from any console at startup without closing the parent terminal, and shell commands use `CREATE_NO_WINDOW`. A plain console-mode build may still flash before startup; the GUI build avoids that entirely.

CI builds Windows tray and Linux/macOS headless binaries. Linux/macOS use `go build -o vega-local .` and require a browser only for first-time authorization; when automatic opening is unavailable, the client prints the local permission-page address.
