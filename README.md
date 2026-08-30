# scinote-mcp

MCP (Model Context Protocol) server that exposes SciNote ELN bench workflows as tools, so an AI assistant (e.g. Ozwell hands-free chat) can drive them by voice: *"tick 'stain mixture combined'"*, *"consume 20 mils from A1 aliquot 2"*, *"what's my next step?"*.

**Architecture** (see also `docs/setup-gingaguard.md` in scinote-web):

```
Ozwell HandsFreeChat (tablet) → chat backend (LLM) → scinote-mcp (this) → SciNote REST API
```

**Hard rule:** every write goes through the SciNote REST API with the *tech's own* credentials. Never write to the SciNote database directly — API writes are what produce the audit trail, stock ledger, and permission checks. That property is the whole point of this server.

## Setup

```bash
cd sidecar/scinote-mcp
npm install
cp .env.example .env    # then fill in values
npm run dev             # starts on stdio
npm run inspect         # opens MCP Inspector UI to poke at tools
```

### Authentication

Two options (see `TokenAuthentication` concern in scinote-web):

- **Api-Key header** (recommended to start): requires `CORE_API_KEY_ENABLED=true` on the SciNote server; each user has an API key (`users.api_key`). Set `SCINOTE_API_KEY`.
- **JWT Bearer**: a token whose `iss` matches the server's `core_api_token_iss`. Set `SCINOTE_JWT`.

Both are gated by server-side flags. On the dev instance these are set on the
`scinote-web` systemd user unit:

```
Environment=CORE_API_V1_ENABLED=true
Environment=CORE_API_KEY_ENABLED=true
```

Without `CORE_API_V1_ENABLED`, `/api/v1/*` returns 404 while `/api/status`
still answers 200 — that combination means the routes were never mounted.

Mint a key for a user with:

```bash
bundle exec rails runner "puts User.find_by(email: 'admin@scinote.net').regenerate_api_key!"
```

### Trying it out

`npm run smoke` drives the server the same way an MCP client does:

```bash
npm run smoke                                        # list registered tools
npm run smoke -- list_tasks
npm run smoke -- get_task_steps '{"taskId":"970"}'
```

Sanity check your credentials:

```bash
curl -s -H "Api-Key: $SCINOTE_API_KEY" $SCINOTE_BASE_URL/api/v1/teams | head -c 400
```

### Useful references

- Route map: `scinote-web/config/routes.rb` (search `namespace :v1`)
- Controllers (payload shapes + permitted params): `scinote-web/app/controllers/api/v1/*.rb`
- Serializers (response shapes): `scinote-web/app/serializers/api/v1/*.rb`
- Test data on the dev instance: team 14 / project 16 / experiment 166, task "Arm A1 - Run 1 (TEST)", inventory "GingiGuard Assay Reagents" (repository 2)

The API speaks [JSON:API](https://jsonapi.org): collections are `{ data: [{ id, type, attributes, relationships }] }`; writes send the same envelope.

---

## Milestones

M0–M4 are done — all ten tools are implemented and verified against the dev
instance. M5 is the remaining work. The notes below record what each milestone
required and how it was accepted.

### M0 — Environment (half a day) — **done**

- [x] `npm install && npm run typecheck` pass
- [x] `.env` filled in; `curl` auth sanity check returns JSON, not 401
- [x] `npm run inspect` opens and `scinote_status` returns versions

**Accept:** screenshot of MCP Inspector showing a successful `scinote_status` call.

### M1 — Read the world (1 day) — **done**

- [x] `list_tasks` returns the test task(s) of experiment 166
- [x] `get_task_steps` returns the 21 checkpoints with `completed` flags
- [x] Extend `get_task_steps` to also surface checklists and their items (ids + `checked`) — the `include=checklists,checklists.checklist_items` data arrives in the JSON:API `included` array

**Accept:** `get_task_steps` output shows step P3.1 with its Actions checklist items and ids.

### M2 — Execute a protocol (2 days) — **done**

- [x] Implement `tick_checklist_item` and `complete_step`
- [x] Return human confirmations ("Ticked 'Blower on, 5 min' — 2 of 3 actions done on P1.1"), not raw JSON
- [x] Error mapping: 403 → "you don't have permission", 404 → "that step doesn't exist", stale id → suggest re-running `get_task_steps`

**Accept:** from MCP Inspector, tick all actions on a step and complete it; the change is visible in the SciNote web UI and in the task's Activities feed **attributed to your user**.

### M3 — Inventory + stock (2 days) — **done**

- [x] Implement `list_task_items`, `assign_item`, `consume_stock`
- [x] `consume_stock` echoes item name, amount, and resulting stock in its confirmation; the tool description instructs the LLM to confirm with the user first — keep it that way
- [x] Verify in SciNote: stock decrements, ledger row appears (item card → stock export), low-stock warning shows when you cross the threshold

> **Gotcha:** the API's `stock_consumption` is the *cumulative* total for that
> task assignment; the ledger derives the delta. A tech saying "log another
> 20 mL" means a delta, so `consume_stock` reads the current total and sends
> the sum. Sending the raw amount would silently rewrite history.

**Accept:** full P3.1 flow via Inspector — assign "A1 - Aliquot 2", consume 20 mL, item shows 30 mL in SciNote with a ledger entry.

### M4 — Search + results (1–2 days) — **done**

- [x] `find_inventory_item`: name match over inventory items ("a1 aliquot two" → row 63), reports stock. Voice input is sloppy, so the query and the item name are both normalized (lowercased, punctuation dropped, number words mapped to digits) before matching
- [x] `add_result_note`: create a text result on the task (results controller, v1; v2 has richer result elements if needed)

**Accept:** "find A1 aliquot 2" round-trips to the right row id; a result note appears on the task.

### M5 — Ozwell wiring (separate app, 3–5 days)

Not in this repo. Stand up a small chat backend that:

- [ ] Mounts `HeyOzwell/HandsFreeChat` from [@mieweb/ui](https://ui.mieweb.org/?path=/docs/product-feature-modules-ai-hey-ozwell-hands-free-chat--docs) (start with `reviewBeforeSend: true`, `transcription: "browser"`)
- [ ] Connects an LLM to this MCP server (any MCP-capable client/orchestrator)
- [ ] Carries the logged-in tech's SciNote credential per session (swap the static `.env` credential for a per-request header — small refactor of `src/config.ts`/`src/scinote.ts`)
- [ ] System prompt: confirm before any `consume_stock` or `complete_step`; always answer with the checkpoint name, not ids

**Accept:** on a tablet, say "hey ozwell — disk stained and rinsed, done" and watch the step complete in SciNote.

### Later / hardening

- Per-user credential passthrough end-to-end (no shared service account)
- Task-scoped sessions ("I'm working Arm A1 Run 2" pins taskId so the tech never says ids)
- Idempotency: repeating "consume 20 mL" must not double-log — read `stock_consumption` first and set, don't add
- Rate limiting, retries with backoff, structured logging

## Testing tips

- MCP Inspector (`npm run inspect`) is your main harness — no LLM needed
- Watch the Rails log on the dev box (`tail -f ~/scinote-web/log/development.log`) to see your requests hit controllers
- Every write should be visible in three places: the SciNote UI, the task Activities feed, and (for stock) the item ledger. If any of the three is missing, something is wrong.
