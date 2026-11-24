# Strip Title Version

Local Obsidian plugin. Removes the ` - Obsidian X.Y.Z` suffix from the window title by default, or formats the title your way (see **Custom format**).

| Before | After |
|---|---|
| `My Note - MyVault - Obsidian 1.15.1` | `My Note - MyVault` |
| `MyVault - Obsidian 1.15.1` (no note open) | `MyVault` |

Older builds used ` - Obsidian vX.Y.Z`; the plugin handles both.

## Custom format (Settings → Community plugins → Strip Title Version ⚙)

| Field | Default | Used when |
|---|---|---|
| With a note open | `{note} - {vault}` | A note or tab is open |
| With nothing open | `{vault}` | Empty tab |

| Placeholder | Value |
|---|---|
| `{note}` | Open note or tab name (e.g. `Graph view`) |
| `{vault}` | Vault name |
| `{version}` | Obsidian version, e.g. `1.15.1` |
| `{app}` | `Obsidian` |

- Everything outside `{…}` is literal text: `{note} | {vault} ({version})`, `📝 {note}`, `{vault} › {note}`.
- Placeholders are lowercase; unknown ones are left as-is.
- An empty format falls back to the default.
- The settings page shows a live preview; changes apply to all open windows immediately.
- Settings are per vault (`.obsidian/plugins/strip-title-version/data.json`).

## Requirements

- **Settings → Appearance → Window frame style = "Obsidian frame"** — required to see the result in Obsidian's in-app title bar. (With other frame styles there is no in-app title bar; the OS window/taskbar title is still trimmed.)
- **Minimal theme users:** leave Style Settings → Minimal → Window frame → **"Hide window frame title"** OFF, or Minimal hides the title bar text entirely.
- Desktop only.

## How it works

Obsidian sets `document.title` to `<note> - <app title>`, where `app.title` = `<vault> - Obsidian <version>` (captured before plugins load). Its title bar copies `document.title` via a `MutationObserver` on `<title>`. This plugin observes the same `<title>` element; each time Obsidian writes a title, it parses the note name out (using `app.title` as the exact suffix) and rewrites the title from your format. Titles that don't match Obsidian's format are left alone. Pop-out windows: already-open ones are picked up on load, new ones via the `window-open` / `window-close` workspace events.

## Limitations

- The OS window/taskbar title changes too, so outside tools that match on " - Obsidian" (time trackers, AutoHotkey scripts) will stop matching.
- If another plugin also rewrites the window title, the two will fight; changing settings or disabling this plugin reapplies/restores the last title Obsidian wrote.
- The Settings / community-browser pop-out windows (when opened as pop-outs) keep the version; they aren't workspace windows, so the plugin doesn't see them.

No build step: `main.js` is plain CommonJS.

## Install (per vault)

1. Copy `manifest.json` and `main.js` into `<vault>/.obsidian/plugins/strip-title-version/`.
2. Settings → Community plugins → enable **Strip Title Version** (Restricted mode must be off).

## Uninstall

Disable it in Community plugins. Each watched window gets Obsidian's original title (with version) back immediately.
