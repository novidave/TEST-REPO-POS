# Windows: development, startup, background operation and installer

## Development (PowerShell)

Requirements: Windows 10/11 x64 and Node.js 22.15+ (22 LTS) or 24.

```powershell
git clone https://github.com/novidave/TEST-REPO-POS.git
cd TEST-REPO-POS
npm ci
npm run build
npm test                    # core tests (Node, real SQLite, mocked APIs)
npm run native:electron     # SQLite inside the Electron runtime
npm start                   # opens the desktop app
npm run test:electron       # real app end-to-end (wizard, export, restart)
npm run test:electron:tray  # tray, --background start, single agent, close-to-tray
```

## Background agent

- **Closing the window** keeps the agent running in the notification-area (tray) icon. Scheduled exports, group syncs and the optional cloud heartbeat continue. **Quit** in the tray menu stops it.
- The setting is _Settings → Keep exporting in the background when the window is closed_. With it off, or when no tray is available, closing the window quits the app.
- The tray menu has: Open, Export all now, Start/Stop scheduled exports, Quit. Its tooltip shows the number of schedules and the last export time.
- **One agent per Windows user profile.** A second launch (for example, the sign-in entry plus a manual start) does not start another agent: it shows the window of the running one. Inside one agent, a connection never runs two exports at once.

## Start at sign-in

_Settings → Start the agent when I sign in to Windows_ registers the app for the current user with Electron's login-item API (the per-user `Run` registry entry). With _run in the background_, the entry passes `--background`, and the agent starts in the tray without opening a window.

Windows Task Scheduler is deliberately **not** used: a second registration could start a duplicate agent. Single-instance locking would stop it, but one mechanism is simpler to reason about. Automated tests never change the sign-in registration.

## What happens when Windows is…

| State                    | Behavior                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed in, window closed | Agent runs in the tray; exports continue on schedule.                                                                                                                                         |
| Locked screen            | Same as signed in: the user session keeps running.                                                                                                                                            |
| Signed out               | The agent is a user application and stops with the session. Nothing exports until the user signs in again; the sign-in entry then restarts it.                                                |
| Asleep / hibernated      | No process runs. On wake, overdue timers fire and the export runs, then follows its interval. Missed intervals are **not** replayed one by one: the next export is a fresh complete snapshot. |
| Powered off / restarted  | After the next sign-in the agent starts (if registered). Overdue exports run within about 35 seconds; an interrupted run is recorded as failed, and its previous export is still intact.      |
| Clock changed            | The schedule relies on elapsed time. If the PC clock is more than 2 minutes off CACADUU's time, Settings shows a warning (cloud only).                                                        |

To export while nobody is signed in, the agent would have to run as a Windows service under a service account with its own encrypted credentials. That is not implemented. DPAPI credentials are bound to the Windows user, so a service would also need its own credential setup.

## Credentials

Passwords, API keys and device tokens are encrypted with Electron `safeStorage` (DPAPI, current Windows user) and never stored in plain text, returned to the window or written to logs. Copying the profile to another Windows account does not make them readable; re-enter them there.

## Portable package and installer

```powershell
npm run package:win        # release\CACADUU-Inventory-win32-x64\ (portable, unsigned)
npm run test:packaged      # end-to-end test against the packaged exe
npm run installer:win      # requires Inno Setup 6; builds release\installer\TEST-REPO-POS-Setup-0.1.0.exe
```

The installer (`installer/windows/test-repo-pos.iss`):

- is a per-user install to `%LOCALAPPDATA%\Programs\TEST-REPO-POS`, so no administrator rights are needed
- adds a Start-menu shortcut and an optional desktop icon
- offers to launch after setup
- closes a running agent (including one in the tray) before replacing files
- on uninstall, runs `--unregister-login-item` to remove the sign-in entry

Settings, connections, encrypted credentials, history and exported folders in `%APPDATA%` are kept.

**Status:** the portable package cross-builds on Linux, which confirms a PE32+ x64 executable and an unpacked `win32-x64` SQLite binary. The installer script, real Windows startup, DPAPI round trip and sign-in behavior were **not** executed in this environment. They run in the Windows CI job (`.github/workflows/desktop.yml`: tests, Electron E2E, tray test, packaging, packaged E2E) or need a manual check on a Windows PC. Code signing is not configured; SmartScreen will warn about an unsigned installer.

## Updates

There is no automatic updater and no update server. Install a newer installer over the old one; data in `%APPDATA%` is preserved. Settings → Updates shows the installed version.
