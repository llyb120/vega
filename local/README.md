# vega-local

Run the updated client on each computer and sign in to the Vega website with the same account. Each **desktop website frontend** bridges its own `ws://127.0.0.1:47673/agent`; there is no API Key or server URL to configure. Keep both the client and its desktop website open. A phone or tablet never connects to its own loopback client; it selects an online computer through the server.

The first connection from a new website opens a small local permission page. Approve only your own trusted Vega origin: approval lets accounts signed in to that site read/write files and execute commands on this machine. Login is verified with a one-use, 15-second server ticket, not a reusable local secret. Windows tray → **连接授权** lists trusted sites and can revoke them.

The website lists online clients by computer name, platform and a short device ID, limited to the current account. A client is considered offline after its bridge disconnects or misses heartbeats for 15 seconds. Each successful website login grants a fresh **7-day** cookie; logout, revocation and password changes still invalidate it.

New conversations default to a client when any are online, otherwise the server. Beside the **服务端 / 客户端** switch, the device selector chooses the exact computer, including from a phone. Connections and disconnections never move an existing conversation automatically. Finish or stop the current turn (including Fire) before changing devices or modes. An offline selected client blocks new commands even if another client is online.

A manual switch validates the destination, remembers the server and **each device's** working directory separately and restores it when switching back. Missing remembered directories fall back to that side's root directory, never the other machine's path. Files are **not** copied or synchronized. Stage, fork and Fire inherit the original execution location. `read`, `write`, `edit`, `bash` and directory changes run on the selected side, including image reads. `sqlite:` archives, skills and Chrome remain server-side.

If a response is lost, work pauses and asks the user to inspect the actual result, repair the connection and explicitly continue. No command is replayed or silently rerun on the server. Closing the connection or cancelling the session cancels pending local shell processes.

The client only listens on loopback. Its stable non-secret device ID and trusted website origins are saved in the current user's config directory at `vega-local/trusted-sites.json`; no account password, login cookie or API Key is stored locally. Upgrades preserve trusted sites and add a device ID. Historical sessions without a device binding must explicitly select a client once; old binaries are identified only for their current bridge connection and should be upgraded. Use HTTPS for remote websites. Your browser may ask permission to connect to a local device.

## Build

Windows (system tray only, no console window):

```powershell
go test ./...
go build -ldflags="-H=windowsgui" -o vega-local.exe .
```

Use the rebuilt `.exe`, not an older download or `go run .`. Windows also detaches the client from any console at startup without closing the parent terminal, and shell commands are launched with `CREATE_NO_WINDOW`. A plain console-mode `go build` can still flash a window before startup; the GUI build above avoids that entirely.

CI builds Windows tray and Linux/macOS headless binaries. Linux/macOS use `go build -o vega-local .` and require a browser to approve a new site; when automatic opening is unavailable, the client prints the local permission-page address.
