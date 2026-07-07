# 👻 Ghost — a talk-in-chat Destiny 2 item manager

Manage your Destiny 2 gear by talking to your LLM. Ghost is an **MCP server** that
exposes the Bungie API as tools — inspect inventory, grade weapon rolls, and
move/equip/lock items — the way [DIM](https://github.com/DestinyItemManager/DIM)
and [Destiny Recipes](https://destinyrecipes.com) do, but conversational.

**No Anthropic API key, no web server, no agent loop.** Your chat model *is* the
intelligence; Ghost just gives it hands.

> **Safety by design:** the Bungie API exposes **no dismantle/delete endpoint**, so
> Ghost physically cannot destroy your gear. "Clean my vault" means *lock the keepers,
> unlock the rejects* — you do the actual dismantle in-game. Write tools default to
> `dry_run: true`, so the model previews a plan and you confirm before anything changes.

## What it does

- **Ask about your gear** — "what's my lowest-power slot", "where's my Fatebringer".
  (`get_character_state`, `search_inventory`)
- **Grade rolls** — "score my hand cannons for PvP", "is this a keeper?" — via the DIM
  community god-roll wishlist (the source Destiny Recipes uses). (`score_items`)
- **Act, behind confirmation** — move between characters/vault, equip, lock/unlock, pull
  from the postmaster. (`transfer_item`, `equip_item`, `set_lock`, `pull_postmaster`)

## How it fits together

```
You ⇄ chat ⇄ your LLM ⇄ destiny-ghost MCP server ⇄ Bungie API
                          │  (OAuth token stays on your disk)
              OAuth · manifest cache · GetProfile · write actions · roll scoring
```

- **`src/bungie/`** — OAuth2 (code + refresh; tokens at `~/.destiny-ghost/`, mode 0600),
  throttle-aware HTTP client (obeys `ThrottleSeconds`), manifest cache/resolver,
  `GetProfile` → flattened inventory, write actions (char→char vault-hop planner +
  idempotent re-reads).
- **`src/scoring/`** — ingests the upstream DIM `voltron.txt` wishlist; scores rolls S–F.
- **`src/mcp/server.ts`** — the MCP stdio server: 7 tools; writes default `dry_run: true`.

The confirmation gate lives in the model (guided by the Skill): preview → your explicit
yes → execute. See `~/.claude/skills/destiny-ghost/SKILL.md`.

## Setup (one-time)

```bash
npm install

# 1. Register a Bungie app at https://www.bungie.net/en/Application
#      OAuth Client Type: Confidential
#      Redirect URL:      https://127.0.0.1:7777/callback   (exact)
#      Scopes:            Read Destiny inventory/vault + Move or equip Destiny gear
cp .env.example .env        # paste API key + client id/secret (no Anthropic key needed)

# 2. Log in to Bungie once (opens your browser; tokens saved to ~/.destiny-ghost/)
npm run auth

# 3. (optional) pre-download the manifest
npm run manifest

# 4. Register the MCP server with your client (Claude Code shown)
claude mcp add destiny-ghost -- npx tsx "$(pwd)/src/mcp/server.ts"
```

Then just talk: *"score my hand cannons for PvP"*, *"clean my vault, keep PvE god rolls"*,
*"move Fatebringer to my Warlock and equip it."*

> **mkcert (optional):** the OAuth callback needs an HTTPS localhost cert. Without
> `mkcert`, Ghost mints a self-signed cert and your browser warns once during login —
> that's expected. `mkcert -install` silences it.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test — pure-logic unit tests (transfer planner)
npm run mcp         # run the server standalone on stdio
```

## Status & caveats

- All 7 tools, scoring, OAuth, manifest, and the Skill are implemented; typecheck clean,
  unit tests pass, the MCP server is verified to boot and list its tools over stdio.
- **Not yet exercised against a live Bungie account** — that needs your one-time OAuth
  login (`npm run auth`).
- Wishlist scoring is community-authored and advisory; verdicts surface the wishlist
  version. There is no first-class "PvP" flag in the game — "best for PvP" is the
  wishlist PvP ranking.
- Rate limits are mostly unpublished; Ghost obeys the API's `ThrottleSeconds` rather than
  hardcoding a rate. Review Bungie's API Terms before any public use.
