# Kaufland MCP – Kaufland Seller API for Claude

Remote **MCP server** and **CLI** for the [Kaufland Marketplace Seller API v2](https://sellerapi.kaufland.com/?page=rest-api).
Connect your Kaufland seller account to Claude (claude.ai, Desktop, mobile, Claude Code) as a custom connector, like the Shopify connector:
"What do I need to ship today?", "Set the price of SKU-1 to 17,49 €", "How much did I sell in October?".

- Runs on **Cloudflare Workers** (the free plan is enough). No server to maintain.
- **OAuth 2.1 login** with your own password: dynamic client registration, PKCE and tokens via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider). Only redirects to `claude.ai` / `claude.com` (and localhost for Claude Code) are accepted.
- Your Kaufland API keys are stored as **Cloudflare secrets**, never in the code.
- **46 tools**: offers (create, price, stock, delete, bulk), orders, shipping with tracking, cancellations, refunds, returns, customer tickets, invoices, reports, webhooks, sales summary and a raw request tool for every other endpoint. Write and destructive tools are marked as such, so Claude asks before it acts.
- No runtime dependency apart from the OAuth library. Requests are HMAC-signed as Kaufland requires; 429/503 are retried.

> **Deutsch:** Eine deutsche Anleitung findest du weiter unten unter [Anleitung auf Deutsch](#anleitung-auf-deutsch).

## Deploy (10 minutes)

You need Node.js ≥ 18, a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and your Kaufland API keys (Seller Portal → Settings → API).

```bash
git clone https://github.com/fabioupg/kaufland-mcp.git
cd kaufland-mcp
npm install
npx wrangler login
npx wrangler secret put KAUFLAND_CLIENT_KEY
npx wrangler secret put KAUFLAND_SECRET_KEY
npx wrangler secret put ACCESS_PASSWORD     # your login password for the connector, at least 12 characters
npx wrangler deploy
```

On the first deploy Wrangler creates the `OAUTH_KV` namespace. It prints your URL, e.g. `https://kaufland-mcp.<your-subdomain>.workers.dev`.
If `secret put` asks to create the Worker first, confirm with **yes**.

### Connect Claude

1. claude.ai → **Settings → Connectors → Add custom connector**
2. Name: `Kaufland`, URL: `https://kaufland-mcp.<your-subdomain>.workers.dev/mcp`
3. **Connect**: a login page opens. Enter your `ACCESS_PASSWORD` and click **Erlauben** (Allow).

The connector is then available in claude.ai, the Desktop app and the mobile apps.
Claude Code: `claude mcp add --transport http kaufland https://kaufland-mcp.<your-subdomain>.workers.dev/mcp`

### Configuration (`wrangler.jsonc` → `vars`)

| Variable | Default | Meaning |
|---|---|---|
| `KAUFLAND_STOREFRONT` | `de` | Default storefront (every tool also takes `storefront`) |
| `KAUFLAND_USER_AGENT` | `Inhouse_development` | User agent Kaufland expects |
| `KAUFLAND_BASE_URL` | live API | e.g. `https://sellerapi-playground.kaufland.com/v2` for the playground |
| `ALLOWED_REDIRECT_HOSTS` | `claude.ai,claude.com` | Hosts the OAuth login may redirect to |
| `ALLOW_LOOPBACK_REDIRECTS` | allowed | `false` blocks localhost redirects (Claude Code) |
| `PUBLIC_URL` | request origin | Set when you use a custom domain |

Secrets: `KAUFLAND_CLIENT_KEY`, `KAUFLAND_SECRET_KEY`, `ACCESS_PASSWORD`.

### Security notes

- Anyone with the URL can register an OAuth client, but nobody gets a token without your password. After 10 wrong passwords an IP is blocked for 15 minutes.
- Access tokens live 1 hour, refresh tokens 30 days. To lock everyone out: change `ACCESS_PASSWORD` and delete the keys in the `OAUTH_KV` namespace (Cloudflare dashboard → Storage → KV).
- The tools act on your **live** seller account. Use `KAUFLAND_BASE_URL` with the playground to try things out.

## CLI

`kaufland.js` is the same API as a command line tool and a Node library, without dependencies.

```bash
cp .env.example .env        # enter KAUFLAND_CLIENT_KEY and KAUFLAND_SECRET_KEY
node kaufland.js ping
node kaufland.js units --csv angebote.csv
node kaufland.js price <id_unit> 17,49
node kaufland.js open-orders
node kaufland.js ship <id_order_unit> DHL <tracking>
node kaufland.js sales-export 2026-10-01 2026-10-31
node kaufland.js help
```

Add `--dry-run` to any write command to see what would be sent. As a library: `const { api } = require('./kaufland'); await api.units();`

## Development

```bash
npm test            # unit tests (signature matches the CLI, tool schemas)
npm run test:e2e    # runs the Worker locally against a mock Kaufland API: full OAuth flow + MCP tool calls
npm run dev         # wrangler dev, needs a .dev.vars file (see below)
```

`.dev.vars` for local development (never commit it):

```
KAUFLAND_CLIENT_KEY=test-client-key
KAUFLAND_SECRET_KEY=test-secret-key
ACCESS_PASSWORD=local-test-password-123
```

Files: `src/index.js` (Worker, OAuth, login page), `src/mcp.js` (MCP over Streamable HTTP, stateless JSON), `src/tools.js` (tool definitions), `src/kaufland-client.js` (signed API client, Web Crypto).

---

## Anleitung auf Deutsch

Damit verbindest du dein Kaufland-Verkäuferkonto mit Claude, genau wie den Shopify-Konnektor. Danach kannst du Claude überall fragen (Web, Desktop, Handy): „Was muss heute raus?“, „Setz den Preis von SKU-1 auf 17,49 €“, „Wie viel Umsatz hatte ich im Oktober?“.

1. Installiere Node.js (≥ 18) und lege ein kostenloses Cloudflare-Konto an.
2. Führe im Projektordner die Befehle aus dem Abschnitt [Deploy](#deploy-10-minutes) aus. Bei `secret put` fragt das Terminal nach dem Wert. Den tippst oder fügst du dort ein, er wird nicht angezeigt.
   - `KAUFLAND_CLIENT_KEY` und `KAUFLAND_SECRET_KEY` findest du im Seller Portal unter Einstellungen → API.
   - `ACCESS_PASSWORD` denkst du dir selbst aus, mindestens 12 Zeichen. Mit diesem Passwort meldest du Claude später an.
3. `npx wrangler deploy` zeigt dir am Ende deine Adresse an, z. B. `https://kaufland-mcp.dein-name.workers.dev`.
4. In claude.ai: **Einstellungen → Konnektoren → Eigenen Konnektor hinzufügen**. Als URL gibst du deine Adresse mit `/mcp` am Ende ein. Danach klickst du auf **Verbinden**, gibst dein Passwort ein und klickst auf **Erlauben**.

Schreibende Aktionen wie Löschen, Stornieren oder Erstatten markiert der Server als „destruktiv“. Claude fragt deshalb vorher nach.

## License

MIT. Not affiliated with Kaufland. "Kaufland" is a trademark of its owner.
