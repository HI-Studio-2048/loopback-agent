# Loopback Agent

A **local** Chrome MV3 agent plus a tiny companion on **127.0.0.1 only**. An assistant queues **one** act. Navigation, click, and type can run in your already-logged-in Chrome profile. **Publish / Post / Send / Pay / Delete / Share always stop** for Confirm in the side panel.

This is not Claude-in-Chrome. See [What v1 can and cannot](#what-v1-can-and-cannot-vs-claude-in-chrome).

**Grok / assistants:** call `http://127.0.0.1:18741` on the machine that has Chrome. Playbook: [GROK.md](GROK.md). Never deploy the companion.

## First run (Mac)

### Prerequisites

- **Node 20+** (`node -v`)
- **Chrome** (the profile the agent will use)
- Already **logged into** the sites you care about (YouTube, Instagram, …) in that profile

### 1. Start the companion

From the **repo root**:

```bash
npm install && npm run companion
```

Leave that terminal running. You should see `listen 127.0.0.1:18741 up`.

### 2. Bind check

```bash
lsof -nP -iTCP:18741 -sTCP:LISTEN
```

Expect `127.0.0.1:18741`. Never `0.0.0.0`. Use **`http://127.0.0.1`**, not `localhost` (Mac `localhost` can be IPv6).

### 3. Load the extension unpacked

1. Open `chrome://extensions`
2. Developer mode → **Load unpacked**
3. Select the **`extension` folder** (the folder that contains `manifest.json`, not the repo root)
4. Open the **Loopback Agent** side panel

### 4. Grant site access

Default permission is **only** `http://127.0.0.1:18741`. The agent cannot snapshot or click a site until you grant it.

In the side panel, with that site focused in Chrome:

- **Allow this site** — origin of the active tab (unknown hosts are prompted here, never granted silently)
- **Revoke this site** — drop that origin grant
- **Allow all sites** — optional `<all_urls>` (never shipped as a silent default; requires this click)

Gated actions still require Confirm on an allowed host.

### 5. Example act that STOPS BEFORE Publish

```bash
curl -sS -X POST http://127.0.0.1:18741/v1/act -H 'Content-Type: application/json' -d '{"intent":"Open YouTube Studio and fill title Companion test and description Test from companion. Do not click Publish.","startUrl":"https://studio.youtube.com"}'
```

You should get **201** with `"status":"running"` (or `pending` if you sent `confirmToStart: true`). That curl **does not publish**. Keep the side panel open.

### Cursor overlay

While an act runs you **will see a cursor overlay** on the page (default **on**): a gold pointer that **glides** (~240ms ease, not a teleport), a highlight on the Runtime box-model hit box, a click ripple at that point, a type chip near the caret only while text is in flight, and a **compact HUD** at the bottom-left (verb · tab title/host · Confirm pending vs acting). It stays above the page with `pointer-events: none` so it does not cover the composer or steal clicks. The side panel is a separate document and still receives clicks.

Turn it off in the side panel: uncheck **Show cursor overlay (default on)**. Deny aborts and **clears the overlay**.

**You pick the file** appears in the HUD/highlight **only** when Runtime fail-closes with `file_chooser_user_pick`. A successful file set stays quiet and does not claim the file was set otherwise.

Chrome will likely show **“This extension started debugging this browser.”** That is the `debugger` permission (CDP). Dismissing the infobar detaches CDP. Ordinary click/type may fall back to in-page events; **gated** (Publish/Send/Pay/Delete/Share) and **file** steps retry attach or abort — they never silently use `click()` / `value=`.

### 6. Gated shortcut: `/v1/post-request`

Still works. Confirm-to-start is required, then the composer is filled, then **Publish/Share waits for a second Confirm**.

```bash
curl -sS -X POST http://127.0.0.1:18741/v1/post-request -H 'Content-Type: application/json' -d '{"platform":"youtube","caption":"Test from companion","title":"Companion test"}'
```

Then Confirm (start) in the side panel. When Publish appears, Confirm again — or Deny to abort.

## Confirm rules

Safer design, both layers:

1. **Optional Confirm-to-start** — `/v1/act` default is off (`confirmToStart: true` to enable). `/v1/post-request` always requires it.
2. **Hard gate at the moment of harm** — any click the agent thinks is Publish, Post, Send, Pay, Delete, or Share **stops** and the side panel names the **action + origin** (for example Confirm Publish on studio.youtube.com). Confirm and Deny are required. There is **no auto-approve** and **waiting is not a yes**. Deny aborts and clears the overlay. If the panel cannot render, gated actions do not run. This cannot be turned off with `"gated": false`.

## Agent API

All on `http://127.0.0.1:18741`. At most **one** act at a time (`409 already_pending`).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness + bind |
| `POST` | `/v1/act` | Queue an intent (`intent`, `startUrl?`, `confirmToStart?`) |
| `POST` | `/v1/post-request` | Gated YouTube/Instagram shortcut (compat) |
| `GET` | `/v1/pending` | Active act |
| `GET` | `/v1/snapshot` | DOM outline + compact AX tree (no screenshot bytes) |
| `GET` | `/v1/screenshot` | Last JPEG screenshot on loopback only |
| `POST` | `/v1/tool` | `snapshot`, `click`, `type`, `scroll`, `navigate`, `tabs.*`, `windows.*`, `attachFile`, `wait.load` |
| `POST` | `/v1/prepare-file` | Resolve a local path or download a URL into a temp file for CDP |
| `POST` | `/v1/confirm` | Confirm-to-start **or** confirm the gated click |
| `POST` | `/v1/deny` | Abort |
| `GET` | `/v1/status/:id` | Any act |

Click args: `{ "tool": "click", "ref": "e3" }` or `selector` / `role` + `name`. Type: `{ "tool": "type", "ref": "e2", "text": "..." }`. If that control is gated, the companion moves to `awaiting_gate` instead of clicking.

## Security

- Companion binds **127.0.0.1 only**. Never `0.0.0.0`. **Never deploy to Railway**, a VPS, Docker publish, or a tunnel.
- Confirm for publish / send / pay / delete / share.
- Snapshots stay in extension memory and the loopback companion. They are not logged.
- Never commit cookies, tokens, or Chrome sessions.
- CDP is used **on the tab we act on** only. No cookie export, no proxies, no headless profile theft.

## What v1 can and cannot vs Claude-in-Chrome

**Closer to parity now:** visible clicker overlay; `chrome.debugger` attach on the tab we act on (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`, fused `Accessibility.getFullAXTree` + box model + screenshot, OOPIF `Target.attachedToTarget`); file inputs via intercepted chooser (`Page.setInterceptFileChooserDialog` → `Page.fileChooserOpened` → `DOM.setFileInputFiles` with a `/v1/prepare-file` path); tabs/windows wait-for-complete then re-attach; 1–2 stale-node retries.

**Still impossible or weaker in MV3 / Chromium:** a hosted LLM brain (you call `/v1/act` and `/v1/tool`); always-on debugger across every tab without a grant; dismissing the debugger infobar detaches CDP; some OOPIF iframes stay opaque even with flatten auto-attach; companion cannot use Chrome cookies to download Drive URLs; perfect AX on every custom widget; Stories/Reels if Share isn’t found (fail closed); mass posting, scraping farms, DM bots, phone control.

**File inputs:** page scripts cannot set `<input type=file>`. Direct `DOM.setFileInputFiles` on a guessed node often returns **-32000 Not allowed** ([Chromium #928255](https://crbug.com/928255)). The legal path is intercept the chooser, trigger it, then set files on the `fileChooserOpened` `backendNodeId`. If intercept fails or the chooser never fires, the tool returns **`file_chooser_user_pick`** and does **not** claim the file was set — pick it in the highlighted picker. `/v1/prepare-file` copies the local path into a world-readable temp file so Chrome can read it.

Claude-in-Chrome pairs a cloud model with this kind of tab control. Loopback Agent is the **local hands** plus a visible cursor: least-privilege default, optional `<all_urls>` only after a side-panel gesture, hard Confirm on irreversible actions.

## Tests

```bash
npm test
```

The extension is unpacked; there is no build step.

## License

MIT. See `LICENSE`.
