# vega-local

Run the updated client and sign in to Vega **once on that computer**. The desktop webpage passes a one-use, 15-second ticket to `ws://127.0.0.1:47673/agent`. After you approve the local site permission, the native client exchanges that ticket directly with the backend for a revocable device credential. The credential never enters the webpage.

After pairing, the client connects directly to `/api/local-agent/socket` with its device credential. The website shows **waiting for site permission → verifying login → connecting to backend**, and only confirms success after the native backend sends `ready`. Failures show a sanitized stage/reason and HTTP status (when available), with **重新检测** for a fresh handshake. No token, upstream response body or jobs are relayed through this diagnostic channel. An old client that cannot confirm backend readiness prompts you to upgrade.

**You may close the webpage, let the browser sleep, or use Vega from a phone.** As long as the computer, client and network remain available, it stays usable. Client and server restarts reconnect automatically without a new website login; network reconnects never replay jobs. Both HTTP/WS and HTTPS/WSS origins are supported, including remote HTTP sites. HTTP sends website logins, device credentials and commands in plaintext and permits network tampering; HTTPS remains recommended, but is not required. HTTPS certificates are still verified.

The website lists online clients by computer name, platform and short device ID, scoped to the current account. A client becomes offline when its native socket closes or its heartbeats expire. Phones/tablets do not connect to a loopback client; they select an authorized online computer through the server.

New conversations default to a client when any are online, otherwise the server. The **服务端 / 客户端** switch and device selector choose the exact computer. Existing conversations never move automatically when devices connect/disconnect. Finish or stop the current turn (including Fire) before changing devices or modes. An offline selected client blocks new commands even if another client is online.

A manual switch validates the destination, remembers the server and **each device's** working directory separately and restores it when switching back. Missing remembered directories fall back to that side's root, never another computer's path. Files are **not** synchronized. Stage, fork and Fire inherit the selected device. `read`, `write`, `edit`, `bash`, directory changes and the `chrome` tool run on that client; `sqlite:` archives and skill storage remain server-side.

Load/reload the bundled **Nova Chrome** extension in the selected computer's Chrome. It discovers the native client's authenticated loopback bridge on ports `47653–47662`, using the existing extension protocol without modifying the vendored extension. The existing Chrome tool (including screenshots, DOM, DevTools and uploads) uses that computer's browser/login state and validates upload paths on that computer. The native client grants an exclusive lease to one session for its entire active turn, across users and server connections; competing sessions pause without input and can continue after the holder finishes or is stopped. A native backend disconnect also releases its lease. A missing extension, an old/offline client or a busy browser never falls back to the server or another computer. Administrator server-browser management pages remain separate from the conversation's browser tool.

If a response is lost, work pauses so you can inspect the actual result, repair the connection and explicitly continue. No command is replayed or silently rerun on another device or the server. Disconnecting or cancelling a session cancels pending native shell processes. Closing the webpage does **not** disconnect the native client or cancel its work.

## Device credentials and revocation

The per-user config directory contains `vega-local/trusted-sites.json`: the stable device ID, trusted origins and paired credentials. Windows protects tokens with current-user DPAPI; Unix stores them in a mode-0600 file under the user's config directory. The server stores only token hashes, bound to one account/device; these tokens cannot log into the website or call general APIs. No website password or login cookie is stored by the client.

Windows tray → **连接授权** can revoke a trusted site: it removes its local credentials and stops its native connections. Account password/role changes and disabling access revoke the backend's device credentials too. A logged-in user can revoke one of their own devices with `POST /api/local-agent/revoke` and `{clientId}` (normal cookie/CSRF protection). Revoked clients require a fresh website handshake; repeated authorization while a healthy token exists reuses it without interrupting work. Website logout and the 7-day website cookie expiry do not revoke an independently authorized device.

Upgrade the server, webpage and native binary together. Stop any old process before launching the rebuilt binary; the local port belongs to one running process, so starting another copy does not replace an old client. The permission page confirms that the site permission was saved and directs you back to the website for the backend result. Revoking permission while the website is open will trigger a new authorization request on its next detection attempt; close that page to stop requesting. Old webpage job relays are no longer used. Existing stable device IDs and trusted origins are preserved; open the desktop website once after upgrading to obtain a device credential. Historical sessions without a device binding still require choosing a device once.

Reverse proxies must forward WebSocket Upgrade/Connection and the Authorization header for `/api/local-agent/socket`, in addition to `/api/events` and `/api/chrome/live`. No extra public port is needed; never expose the client's loopback port.

## Build

Docker builds all five clients from the same source as the server: Windows x64 (tray), Linux x64/ARM64 and macOS Intel/Apple Silicon (headless). After deploying the image, sign in and open **资源 → 客户端下载**; files are served by that deployment at `/clients/`, not fetched from an external release. The Go toolchain is only in the build stage, not the runtime image.

For non-Docker deployments, build the matching binaries below and place them in `web/public/clients/` **before** `npm run build`, using the filenames `vega-local-windows-amd64.exe`, `vega-local-linux-amd64`, `vega-local-linux-arm64`, `vega-local-darwin-amd64` and `vega-local-darwin-arm64`. A plain frontend/server build does not compile the clients.

Windows (system tray only, no console window):

```powershell
go test ./...
go build -ldflags="-H=windowsgui" -o vega-local.exe .
```

Use the rebuilt `.exe`, not an older download or `go run .`. Windows detaches the client from any console at startup without closing the parent terminal, and shell commands use `CREATE_NO_WINDOW`. A plain console-mode build may still flash before startup; the GUI build avoids that entirely.

CI builds Windows tray and Linux/macOS headless binaries. Linux/macOS use `go build -o vega-local .` and require a browser only for first-time authorization; when automatic opening is unavailable, the client prints the local permission-page address.
