# Terminal

The integrated terminal provides a full-featured terminal emulator within Pegasus, powered by xterm.js.

## Configuration

Configure the terminal via environment variables in `apps/server/.env`:

### Disable Terminal Completely

```
TERMINAL_ENABLED=false
```

Set to `false` to completely disable the terminal feature.

### Password Protection

```
TERMINAL_PASSWORD=yourpassword
```

By default, the terminal is **not password protected**. Add this variable to require a password.

When password protection is enabled:

- Enter the password in **Settings > Terminal** to unlock
- The terminal remains unlocked for the session
- You can toggle password requirement on/off in settings after unlocking

### Session Limit

```
TERMINAL_MAX_SESSIONS=1000
```

Controls how many concurrent PTY sessions the server will allow. Defaults to `1000` (effectively unlimited for most use cases). Valid range is `1`–`1000`. When the limit is reached, `POST /sessions` returns `429 Too Many Requests`.

## Keyboard Shortcuts

When the terminal is focused, the following shortcuts are available:

| Shortcut | Action                                  |
| -------- | --------------------------------------- |
| `Alt+T`  | Open new terminal tab                   |
| `Alt+D`  | Split terminal right (horizontal split) |
| `Alt+S`  | Split terminal down (vertical split)    |
| `Alt+W`  | Close current terminal                  |

These shortcuts are customizable via the keyboard shortcuts settings (Settings > Keyboard Shortcuts).

### Split Pane Navigation

Navigate between terminal panes using directional shortcuts:

| Shortcut                          | Action                               |
| --------------------------------- | ------------------------------------ |
| `Ctrl+Alt+ArrowUp` (or `Cmd+Alt`) | Move focus to terminal pane above    |
| `Ctrl+Alt+ArrowDown`              | Move focus to terminal pane below    |
| `Ctrl+Alt+ArrowLeft`              | Move focus to terminal pane on left  |
| `Ctrl+Alt+ArrowRight`             | Move focus to terminal pane on right |

The navigation is spatially aware - pressing Down will move to the terminal below your current one, not just cycle through terminals in order.

Global shortcut (works anywhere in the app):
| Shortcut | Action |
|----------|--------|
| `Cmd+`` (Mac) / `Ctrl+`` (Windows/Linux) | Toggle terminal view |

## Features

### Multiple Terminals

- Create multiple terminal tabs using the `+` button
- Split terminals horizontally or vertically within a tab
- Drag terminals to rearrange them

### Theming

The terminal automatically matches your app theme. Supported themes include:

- Light / Dark / System
- Retro, Dracula, Nord, Monokai
- Tokyo Night, Solarized, Gruvbox
- Catppuccin, One Dark, Synthwave, Red

### Font Size

- Use the zoom controls (`+`/`-` buttons) in each terminal panel
- Or use `Cmd/Ctrl + Scroll` to zoom

### Scrollback

- The terminal maintains a scrollback buffer of recent output
- Scroll up to view previous output
- Output is preserved when reconnecting

### Custom Terminal Configurations

Pegasus can inject a fully custom shell configuration (prompt, aliases, env vars) that stays in sync with the active app theme. This is an **opt-in** feature that creates files in `.pegasus/terminal/` without touching your existing RC files.

Enable it in **Settings > Terminal** (global) or in per-project settings. Once enabled you can configure:

- **Prompt format** — `standard`, `minimal`, `powerline`, or `starship`-inspired
- **Git info** — show/hide branch name and dirty status in the prompt
- **User/host and path display** — toggle visibility and path depth/style (`full`, `short`, `basename`)
- **Timestamp and exit status** — optional prompt decorations
- **Custom aliases** — a freeform block of alias definitions injected into every shell
- **Custom env vars** — key-value pairs set in every new terminal session
- **Prompt theme** — pick from any of the 40 app themes or use a custom Oh-My-Posh theme

Configuration is stored in `GlobalSettings.terminalConfig` (global) and `ProjectSettings.terminalConfig` (per-project, overrides global for project-specific fields). The RC files are stored in `.pegasus/terminal/` inside each project worktree and regenerated automatically when the theme changes.

## Architecture

The terminal uses a client-server architecture:

1. **Frontend** (`apps/ui`): xterm.js terminal emulator with WebGL rendering
2. **Backend** (`apps/server`): node-pty for PTY (pseudo-terminal) sessions

Communication happens over WebSocket for real-time bidirectional data flow.

### Shell Detection

The server automatically detects the best shell:

- **WSL**: User's shell or `/bin/bash`
- **macOS**: User's shell, zsh, or bash
- **Linux**: User's shell, bash, or sh
- **Windows**: PowerShell 7, PowerShell, or cmd.exe

## REST API

All terminal REST endpoints are mounted at `/api/terminal`. Endpoints that require authentication check for a valid session token in the `X-Terminal-Token` request header (or a `token` query parameter on the WebSocket URL). Tokens are only required when `TERMINAL_PASSWORD` is set.

### Authentication

#### `GET /api/terminal/status`

Returns terminal status. No authentication required.

**Response:**
```json
{
  "success": true,
  "data": {
    "enabled": true,
    "passwordRequired": false,
    "platform": {
      "platform": "linux",
      "isWSL": false,
      "defaultShell": "/bin/bash",
      "arch": "x64"
    }
  }
}
```

#### `POST /api/terminal/auth`

Authenticate with the terminal password to receive a session token. No authentication required.

**Request body:**
```json
{ "password": "yourpassword" }
```

**Response (success):**
```json
{
  "success": true,
  "data": {
    "authenticated": true,
    "token": "term-<base64url>",
    "expiresIn": 86400000
  }
}
```

Tokens are valid for **24 hours**. If no password is configured the response omits `token` and returns `"passwordRequired": false`.

#### `POST /api/terminal/logout`

Invalidate a session token. Pass the token in the `X-Terminal-Token` header or in the request body as `{ "token": "..." }`.

**Response:**
```json
{ "success": true }
```

### Sessions

All session endpoints require a valid token when password protection is enabled.

#### `GET /api/terminal/sessions`

List all active PTY sessions.

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": "term-...", "cwd": "/home/user/project", "shell": "/bin/bash", "createdAt": "..." }
  ]
}
```

#### `POST /api/terminal/sessions`

Create a new PTY session.

**Request body (all fields optional):**
```json
{ "cwd": "/home/user/project", "cols": 80, "rows": 24, "shell": "/bin/zsh" }
```

**Response (success):**
```json
{
  "success": true,
  "data": { "id": "term-...", "cwd": "/home/user/project", "shell": "/bin/bash", "createdAt": "..." }
}
```

**Response (session limit reached — `429`):**
```json
{
  "success": false,
  "error": "Maximum terminal sessions reached",
  "details": "Server limit is 1000 concurrent sessions. Please close unused terminals.",
  "currentSessions": 1000,
  "maxSessions": 1000
}
```

#### `DELETE /api/terminal/sessions/:id`

Kill a PTY session. Sends `SIGTERM` first, then `SIGKILL` after 1 second if the process is still alive.

**Response (success):**
```json
{ "success": true }
```

**Response (not found — `404`):**
```json
{ "success": false, "error": "Session not found" }
```

#### `POST /api/terminal/sessions/:id/resize`

Resize a PTY session.

**Request body:**
```json
{ "cols": 120, "rows": 40 }
```

**Response (success):**
```json
{ "success": true }
```

### Settings

#### `GET /api/terminal/settings`

Get current terminal server settings.

**Response:**
```json
{
  "success": true,
  "data": { "maxSessions": 1000, "currentSessions": 3 }
}
```

#### `PUT /api/terminal/settings`

Update terminal server settings at runtime (no restart required). Valid `maxSessions` range is `1`–`1000`.

**Request body:**
```json
{ "maxSessions": 50 }
```

**Response:**
```json
{
  "success": true,
  "data": { "maxSessions": 50, "currentSessions": 3 }
}
```

### WebSocket

#### `ws://HOST:PORT/api/terminal/ws?sessionId=<id>&token=<token>`

Connect to a PTY session for real-time I/O. The `token` query parameter is only required when password protection is enabled.

Once connected, the server immediately replays the scrollback buffer (up to ~50 KB of recent output). After that, data flows bidirectionally:

- **Server → Client**: raw terminal output bytes (UTF-8 string frames)
- **Client → Server**: JSON messages

**Client message types:**

```jsonc
// Send input to the PTY
{ "type": "input", "data": "ls -la\n" }

// Resize the PTY (deduplication and 100 ms rate-limiting applied server-side)
{ "type": "resize", "cols": 120, "rows": 40 }
```

WebSocket close codes:
- `4001` — Authentication required (invalid or missing token)
- `4002` — Session ID required
- `4003` — Terminal access is disabled

## Troubleshooting

### Terminal not connecting

1. Ensure the server is running (`pnpm dev:server`)
2. Check that port 3008 is available
3. Verify the terminal is unlocked

### Slow performance with heavy output

The terminal throttles output at ~250fps (`OUTPUT_THROTTLE_MS = 4`) to prevent UI lockup while keeping input latency low. Very fast output (like `cat` on large files) will be batched into chunks of up to 4096 bytes.

### Shortcuts not working

- Ensure the terminal is focused (click inside it)
- Some system shortcuts may conflict (especially Alt+Shift combinations on Windows)
