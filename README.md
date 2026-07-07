# 👻 Ghost — an LLM-fronted Destiny 2 item manager

Type what you want in plain English; Claude drives the Bungie API to move, equip,
lock, and triage your Destiny 2 gear — the way [DIM](https://github.com/DestinyItemManager/DIM)
and [Destiny Recipes](https://destinyrecipes.com) do, but through conversation.

> **Safety by design:** the Bungie API exposes **no dismantle/delete endpoint**, so
> Ghost physically cannot destroy your gear. "Clean my vault" means *lock the keepers,
> unlock the rejects* — you do the actual dismantle in-game. Every write shows a plan
> you confirm before anything changes.

## What it does

- **Ask about your gear** — "what's my lowest-power slot", "where's my Fatebringer",
  "list my hunter's exotics". (`search_inventory`, `get_character_state`)
- **Grade rolls** — "score my hand cannons for PvP", "is this a keeper?" — using the
  DIM community god-roll wishlist (the same source Destiny Recipes uses). (`score_items`)
- **Act, behind confirmation** — move items between characters/vault, equip, lock/unlock,
  pull from the postmaster. (`transfer_item`, `equip_item`, `set_lock`, `pull_postmaster`)

## Architecture

```
Web chat UI  ──►  Express server  ──►  Agent loop (claude-opus-4-8, adaptive thinking)
                                          │  manual tool-use loop; writes gated
                        ┌─────────────────┼─────────────────────┐
                        ▼                 ▼                     ▼
                  READ tools         WRITE tools           Scoring
                  (inventory,        (transfer/equip/      (voltron
                   search, score)     lock/postmaster)      wishlist)
                        └──────── Bungie layer: OAuth · manifest cache · GetProfile ──────┘
```

- **`src/bungie/`** — OAuth2 (code + refresh), throttle-aware HTTP client (obeys
  `ThrottleSeconds`), manifest cache/resolver (hash→name, event-driven refresh),
  `GetProfile` → flattened inventory, and the write actions (with the char→char
  vault-hop planner + idempotent re-reads).
- **`src/scoring/`** — ingests the upstream DIM `voltron.txt` wishlist and scores a
  rolled weapon (S/A/B/C/D/F) per PvE/PvP.
- **`src/tools/`** — the tools exposed to Claude. Writes never mutate directly; they
  register a *pending action* (dry-run plan) the UI confirms.
- **`src/agent/`** — the manual tool-use loop: parallel reads, prompt-cached system +
  tool defs, confirmation gate around writes.
- **`src/server/` + `src/web/`** — Express API and the chat UI (with the confirm-plan dialog).

## Setup

```bash
npm install

# 1. Register a Bungie app at https://www.bungie.net/en/Application
#      OAuth Client Type: Confidential
#      Redirect URL:      https://127.0.0.1:7777/callback   (exact)
#      Scopes:            Read Destiny inventory/vault + Move or equip Destiny gear
cp .env.example .env        # paste API key, client id/secret, and ANTHROPIC_API_KEY

# 2. Log in to Bungie once (opens your browser; tokens saved to ~/.destiny-ghost/)
npm run auth

# 3. (optional) pre-download the manifest
npm run manifest

# 4. Start the app
npm run dev                 # http://localhost:8787
```

> **mkcert (optional):** the OAuth callback needs an HTTPS localhost cert. Without
> `mkcert` installed, Ghost mints a self-signed cert and your browser warns once
> during login — that's expected. `mkcert -install` silences it.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test — pure-logic unit tests (transfer planner, etc.)
```

## Status & caveats

- Read tools, scoring, all four write tools, the confirmation gate, and the web UI are
  implemented and typecheck clean; the UI is validated in a headless browser.
- **Not yet validated end-to-end against a live Bungie account** — that needs your OAuth
  login. Once authenticated, drive it from the chat box.
- Wishlist scoring is community-authored and advisory; verdicts surface the wishlist
  version. There is no first-class "PvP" flag in the game — "best for PvP" is the
  wishlist PvP ranking.
- Rate limits are mostly unpublished; Ghost obeys the API's `ThrottleSeconds` field
  rather than hardcoding a request rate. Review Bungie's API Terms before any public use.
