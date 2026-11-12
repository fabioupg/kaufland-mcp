// Cloudflare Worker: remote MCP server for the Kaufland Seller API, protected by OAuth 2.1.
// The OAuth server (dynamic client registration, PKCE, tokens in KV) comes from
// @cloudflare/workers-oauth-provider. The login is a single owner password (ACCESS_PASSWORD).

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createClient } from './kaufland-client.js';
import { handleMcp } from './mcp.js';

const MAX_FAILED_LOGINS = 10;       // per IP ...
const FAILED_LOGIN_WINDOW = 15 * 60; // ... per 15 minutes

const apiHandler = {
  async fetch(request, env) {
    const api = createClient({
      baseUrl: env.KAUFLAND_BASE_URL,
      clientKey: env.KAUFLAND_CLIENT_KEY,
      secretKey: env.KAUFLAND_SECRET_KEY,
      storefront: env.KAUFLAND_STOREFRONT,
      userAgent: env.KAUFLAND_USER_AGENT,
    });
    return handleMcp(request, api);
  },
};

// ---------------------------------------------------------------- login / consent page
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, inner, status = 200, headers) {
  const h = new Headers(headers);
  h.set('Content-Type', 'text/html; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  h.set('X-Frame-Options', 'DENY');
  h.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'");
  h.set('Referrer-Policy', 'no-referrer');
  return new Response(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,sans-serif;background:#f4f4f5;margin:0;display:grid;place-items:center;min-height:100vh;color:#18181b}
main{background:#fff;padding:2rem;border-radius:12px;max-width:420px;width:calc(100% - 3rem);box-shadow:0 1px 3px #0002}
h1{font-size:1.3rem;margin:0 0 1rem}p{line-height:1.45}code{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px;word-break:break-all}
input{width:100%;box-sizing:border-box;padding:.7rem;font-size:1rem;border:1px solid #d4d4d8;border-radius:8px;margin:.4rem 0 1rem}
.row{display:flex;gap:.6rem}button{flex:1;padding:.7rem;font-size:1rem;border-radius:8px;border:0;cursor:pointer}
.ok{background:#e10915;color:#fff}.no{background:#e4e4e7}.err{color:#b91c1c}.warn{background:#fef3c7;padding:.6rem;border-radius:8px}
</style></head><body><main>${inner}</main></body></html>`, { status, headers: h });
}

function consentForm(desc, handle, error) {
  return `<h1>Kaufland MCP – Zugriff erlauben</h1>
<p><b>${esc(desc.clientName)}</b> möchte auf dein Kaufland-Verkäuferkonto zugreifen (Bestellungen, Angebote, Preise, Retouren, Tickets).</p>
<p>Zugangsdaten werden gesendet an: <code>${esc(desc.redirectHost)}</code></p>
${desc.redirectIsLoopback ? '<p class="warn">Das Ziel ist eine lokale App auf deinem Computer. Erlaube das nur, wenn du gerade selbst z.&nbsp;B. Claude Code verbindest.</p>' : ''}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${esc(handle)}">
<label>Passwort<input type="password" name="password" autocomplete="current-password" autofocus></label>
<div class="row"><button class="no" name="action" value="deny">Ablehnen</button><button class="ok" name="action" value="approve">Erlauben</button></div>
</form>`;
}

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

// Constant-time comparison (both sides hashed to the same length first).
async function passwordMatches(given, expected) {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function redirectAllowed(desc, env) {
  if (desc.redirectIsLoopback) return env.ALLOW_LOOPBACK_REDIRECTS !== 'false';
  const hosts = (env.ALLOWED_REDIRECT_HOSTS || 'claude.ai,claude.com').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (hosts.includes('*')) return true;
  let url;
  try { url = new URL(desc.redirectUri); } catch { return false; }
  return url.protocol === 'https:' && hosts.includes(url.hostname.toLowerCase());
}

async function handleAuthorize(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  if (!env.ACCESS_PASSWORD || env.ACCESS_PASSWORD.length < 12) {
    return page('Nicht eingerichtet', '<h1>Server nicht eingerichtet</h1><p>Setze zuerst ein Passwort mit mindestens 12 Zeichen: <code>npx wrangler secret put ACCESS_PASSWORD</code></p>', 500);
  }

  if (request.method === 'GET') {
    let authReq, desc;
    try {
      authReq = await oauth.parseAuthRequest(request);
      desc = await oauth.describeConsent(authReq);
    } catch (e) {
      return page('Fehler', `<h1>Ungültige Anfrage</h1><p>${esc(e.message)}</p>`, 400);
    }
    if (!redirectAllowed(desc, env)) {
      return page('Nicht erlaubt', `<h1>Ziel nicht erlaubt</h1><p>Weiterleitung an <code>${esc(desc.redirectHost)}</code> ist nicht freigegeben. Erlaubt sind: <code>${esc(env.ALLOWED_REDIRECT_HOSTS || 'claude.ai,claude.com')}</code> (Variable <code>ALLOWED_REDIRECT_HOSTS</code>).</p>`, 403);
    }
    const tx = await oauth.beginConsent(authReq);
    return page('Anmelden', consentForm(desc, tx.handle), 200, tx.headers);
  }

  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const form = await request.formData();
  const handle = String(form.get('handle') || '');

  if (form.get('action') === 'deny') {
    try {
      const denied = await oauth.denyConsent(request, handle);
      const h = new Headers(denied.headers);
      h.set('Location', denied.redirectTo);
      return new Response(null, { status: 302, headers: h });
    } catch (e) {
      return page('Fehler', `<h1>Abgelaufen</h1><p>${esc(e.message)}</p><p>Starte die Verbindung in Claude neu.</p>`, 400);
    }
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const failKey = `login-fail:${ip}`;
  const fails = Number((await env.OAUTH_KV.get(failKey)) || 0);
  if (fails >= MAX_FAILED_LOGINS) {
    return page('Gesperrt', '<h1>Zu viele Versuche</h1><p>Bitte warte 15 Minuten.</p>', 429);
  }

  if (!(await passwordMatches(String(form.get('password') || ''), env.ACCESS_PASSWORD))) {
    await env.OAUTH_KV.put(failKey, String(fails + 1), { expirationTtl: FAILED_LOGIN_WINDOW });
    // The handle has not been consumed yet, so the same form can be shown again.
    return page('Falsches Passwort', `<h1>Falsches Passwort</h1><p>Gehe zurück und versuche es erneut, oder starte die Verbindung in Claude neu.</p>`, 401);
  }

  let approved;
  try {
    approved = await oauth.approveConsent(request, handle);
  } catch (e) {
    return page('Fehler', `<h1>Abgelaufen</h1><p>${esc(e.message)}</p><p>Starte die Verbindung in Claude neu.</p>`, 400);
  }
  // Check the redirect target again on the request the handle stood for.
  const desc = await oauth.describeConsent(approved.request);
  if (!redirectAllowed(desc, env)) return page('Nicht erlaubt', '<h1>Ziel nicht erlaubt</h1>', 403);

  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: 'owner',
    metadata: { label: desc.clientName, approvedAt: new Date().toISOString() },
    scope: approved.request.scope,
    props: { user: 'owner' },
  });
  const h = new Headers(approved.headers);
  h.set('Location', redirectTo);
  return new Response(null, { status: 302, headers: h });
}

const defaultHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/authorize') return handleAuthorize(request, env);
    if (url.pathname === '/') {
      return new Response(`Kaufland MCP server. Connect your MCP client to ${url.origin}/mcp\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return new Response('Not found', { status: 404 });
  },
};

// The provider needs the server's public URL (it is the token audience). It is taken from
// PUBLIC_URL, or else from the URL the Worker is reached at, so a fork works without editing.
const providers = new Map();
function providerFor(origin) {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider({
      apiRoute: '/mcp',
      apiHandler,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      accessTokenTTL: 3600,
      refreshTokenTTL: 60 * 60 * 24 * 30,
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        resource_name: 'Kaufland Marketplace',
      },
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch(request, env, ctx) {
    const origin = (env.PUBLIC_URL || new URL(request.url).origin).replace(/\/+$/, '');
    return providerFor(origin).fetch(request, env, ctx);
  },
};
