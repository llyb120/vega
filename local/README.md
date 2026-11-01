# vega-local

Run the local client, then sign in to the Vega website. The **website frontend** connects to `ws://127.0.0.1:47673/agent`; there is no API Key or server URL to configure. Keep the website open while local work is running.

The first connection from a new website opens a small local permission page. Approve only your own trusted Vega origin: approval lets accounts signed in to that site read/write files and execute commands on this machine. Login is verified with a one-use, 15-second server ticket, not a reusable local secret. Windows tray → **连接授权** lists trusted sites and can revoke them.

Once the website shows **本机已连接**, newly created conversations default to this client; without a client they default to the server. The **服务端 / 客户端** switch beside the message box can override the default or change an idle conversation. Connections and disconnections never move an existing conversation automatically. Finish or stop the current turn (including Fire) before switching.

A manual switch validates the destination, remembers each side's working directory and restores it when switching back. Missing remembered directories fall back to that side's root directory, never the other machine's path. Files are **not** copied or synchronized. Stage, fork and Fire inherit the original execution location. `read`, `write`, `edit`, `bash` and directory changes run on the selected side, including image reads. `sqlite:` archives, skills and Chrome remain server-side.

If a response is lost, work pauses and asks the user to inspect the actual result, repair the connection and explicitly continue. No command is replayed or silently rerun on the server. Closing the connection or cancelling the session cancels pending local shell processes.

The client only listens on loopback. Trusted website origins are saved in the current user's config directory at `vega-local/trusted-sites.json`; no account password, login cookie or API Key is stored locally. Use HTTPS for remote websites. Your browser may ask permission to connect to a local device.

## Build

Windows (system tray only, no console window):

```powershell
go test ./...
go build -ldflags="-H=windowsgui" -o vega-local.exe .
```

CI builds Windows tray and Linux/macOS headless binaries. Linux/macOS use `go build -o vega-local .` and require a browser to approve a new site; when automatic opening is unavailable, the client prints the local permission-page address.
