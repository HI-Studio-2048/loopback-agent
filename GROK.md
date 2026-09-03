# Grok / assistant playbook

Loopback Agent is **local hands** for the user’s already-logged-in Chrome. You call a companion on **127.0.0.1 only**. Do not deploy it, tunnel it, or bind `0.0.0.0`.

Repo: https://github.com/HI-Studio-2048/loopback-agent

## Preconditions (human)

1. `npm install && npm run companion` — expect `listen 127.0.0.1:18741 up`
2. Chrome → `chrome://extensions` → Load unpacked → select the `extension/` folder
3. Side panel: **Allow this site** for the origin you will operate (never silent)
4. Overlay default **on**. Confirm/Deny in the side panel for Publish/Send/Pay/Delete/Share

## How you use it

Base URL: `http://127.0.0.1:18741`

One act at a time. `409 already_pending` means deny or wait.

### Queue an intent (does not publish)

```bash
curl -sS -X POST http://127.0.0.1:18741/v1/act \
  -H 'Content-Type: application/json' \
  -d '{"intent":"Open YouTube Studio and fill title Companion test and description Test from companion. Do not click Publish.","startUrl":"https://studio.youtube.com"}'
```

`/v1/act` starts immediately unless `confirmToStart: true`. `/v1/post-request` always waits for Confirm-to-start.

### Poll

- `GET /health` — `{ ok, bind: "127.0.0.1", port, active }`
- `GET /v1/pending` — current act
- `GET /v1/snapshot` — DOM outline + compact AX (no screenshot bytes)
- `GET /v1/screenshot` — last JPEG, loopback only

### More steps

`POST /v1/tool` with `{ "id", "tool", ...args }`

Tools: `snapshot`, `screenshot`, `navigate`, `click`, `type`, `scroll`, `tabs.list`, `tabs.create`, `tabs.update`, `tabs.activate`, `tabs.close`, `windows.create`, `windows.list`, `attachFile`, `wait.load`

Click: `{ "tool": "click", "ref": "e3" }` or `selector` / `role` + `name`.  
Type: `{ "tool": "type", "ref": "e2", "text": "..." }` plus `key` / `press` / `submit` for Enter.

If the control is Publish/Post/Send/Pay/Delete/Share, the companion moves to `awaiting_gate`. **Do not treat that as done.**

### Hard gate (cannot disable)

You never click Publish / Post / Share / Send / Pay / Delete. The side panel must **Confirm**. `"gated": false` is ignored. Waiting is not a yes. Deny aborts and clears the overlay.

- `POST /v1/confirm` — start **or** one gated click
- `POST /v1/deny` — abort

After Confirm, status is `running` with `allowGatedOnce: true`, **not** `published` until the extension actually clicks.

### Files

`POST /v1/prepare-file` `{ "path": "/abs/local/file" }` then `POST /v1/tool` `{ "tool": "attachFile", "path": "..." }`.

- Success: stay quiet. Do not announce that the user must pick.
- `file_chooser_user_pick`: tell the user to pick the file in the highlighted picker. **Do not claim the file was set.**
- `file_unreadable`: path missing on disk. Did not set a file.

### Permissions

If you get `needs_permission`, tell the user to **Allow this site** in the side panel. Do not assume `<all_urls>`.

## Fail closed

- No cookie/token export
- No Railway / VPS / tunnel
- No second act until the first finishes or is denied
- Stale nodes: the extension re-snapshots; you re-issue the tool, you do not invent a click
