// End-to-end test: runs the Worker locally (wrangler dev) against a mock Kaufland API,
// walks through the whole OAuth flow like Claude does, then calls MCP tools.
// Run: npm run test:e2e   (needs .dev.vars with ACCESS_PASSWORD=local-test-password-123)
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const MOCK_PORT = 8799, WORKER_PORT = 8788;
const BASE = `http://127.0.0.1:${WORKER_PORT}`;
const SECRET = 'test-secret-key', PASSWORD = 'local-test-password-123';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const seen = [];

// ---------------------------------------------------------------- mock Kaufland API
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = `http://127.0.0.1:${MOCK_PORT}${req.url}`;
    const expected = crypto.createHmac('sha256', SECRET)
      .update([req.method, url, body, req.headers['shop-timestamp']].join('\n')).digest('hex');
    seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers['shop-signature'] !== expected || req.headers['shop-client-key'] !== 'test-client-key') {
      return send(401, { type: 'unauthorized', message: 'bad signature' });
    }
    const u = new URL(url);
    if (u.pathname === '/v2/status/ping') return send(200, { message: 'pong' });
    if (u.pathname === '/v2/units/' && req.method === 'GET') {
      const all = Array.from({ length: 7 }, (_, i) => ({ id_unit: 100 + i, id_product: 5, amount: i, listing_price: 1999, status: 'available', storefront: 'de' }));
      const off = Number(u.searchParams.get('offset')), lim = Number(u.searchParams.get('limit'));
      return send(200, { data: all.slice(off, off + lim), pagination: { offset: off, limit: lim, total: all.length } });
    }
    if (u.pathname.startsWith('/v2/units/') && req.method === 'PATCH') return send(200, { data: { id_unit: 101, ...JSON.parse(body) } });
    if (u.pathname === '/v2/order-units') {
      const all = [
        { id_order_unit: 1, id_order: 'A', status: 'sent', price: 2000, revenue_net: 1500, ts_created_iso: '2026-10-05T10:00:00Z' },
        { id_order_unit: 2, id_order: 'B', status: 'cancelled', price: 999, revenue_net: 0, ts_created_iso: '2026-10-06T10:00:00Z' },
        { id_order_unit: 3, id_order: 'C', status: 'need_to_be_sent', price: 1050, revenue_net: 800, ts_created_iso: '2026-11-02T10:00:00Z' },
      ];
      const st = u.searchParams.get('status');
      const items = st ? all.filter((x) => x.status === st) : all;
      return send(200, { data: items, pagination: { total: items.length } });
    }
    return send(404, { type: 'not_found', message: u.pathname });
  });
});

// ---------------------------------------------------------------- helpers
const b64url = (buf) => Buffer.from(buf).toString('base64url');
async function waitFor(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('worker did not start');
}
let rpcId = 0;
async function rpc(token, method, params) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  assert.equal(r.status, 200, `${method} -> ${r.status} ${await r.clone().text()}`);
  return r.json();
}
const toolText = (r) => JSON.parse(r.result.content[0].text);

// ---------------------------------------------------------------- run
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
const worker = spawn('npx', ['wrangler', 'dev', '--port', String(WORKER_PORT), '--ip', '127.0.0.1',
  '--var', `KAUFLAND_BASE_URL:http://127.0.0.1:${MOCK_PORT}/v2`], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
worker.stdout.on('data', (d) => (log += d));
worker.stderr.on('data', (d) => (log += d));

let failed = false;
const step = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); } catch (e) { failed = true; console.log('FAIL', name, '\n     ', e.message); }
};

try {
  await waitFor(BASE + '/');
  let client, cookie, handle, code, token;
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

  await step('MCP endpoint rejects requests without a token', async () => {
    const r = await fetch(`${BASE}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate') || '', /Bearer/);
  });

  await step('OAuth metadata is published', async () => {
    const m = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    assert.equal(m.registration_endpoint, `${BASE}/register`);
    assert.ok(m.code_challenge_methods_supported.includes('S256'));
  });

  await step('dynamic client registration', async () => {
    const r = await fetch(`${BASE}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT, 'https://evil.example/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    });
    assert.equal(r.status, 201, await r.clone().text());
    client = await r.json();
  });

  const authUrl = (redirect) => `${BASE}/authorize?` + new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: redirect, state: 'xyz',
    code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp`,
  });

  await step('redirect to a non-allowed host is refused', async () => {
    const r = await fetch(authUrl('https://evil.example/cb'));
    assert.equal(r.status, 403);
  });

  await step('login page is shown', async () => {
    const r = await fetch(authUrl(REDIRECT));
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /claude\.ai/);
    handle = html.match(/name="handle" value="([^"]+)"/)[1];
    cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    assert.ok(handle && cookie);
  });

  const post = (fields) => fetch(`${BASE}/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Origin: BASE },
    body: new URLSearchParams(fields),
  });

  await step('wrong password is rejected', async () => {
    const r = await post({ handle, password: 'wrong-password!', action: 'approve' });
    assert.equal(r.status, 401);
  });

  await step('right password redirects back to Claude with a code', async () => {
    const r = await post({ handle, password: PASSWORD, action: 'approve' });
    assert.equal(r.status, 302, await r.text());
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, REDIRECT);
    assert.equal(loc.searchParams.get('state'), 'xyz');
    code = loc.searchParams.get('code');
    assert.ok(code);
  });

  await step('handle cannot be reused', async () => {
    const r = await post({ handle, password: PASSWORD, action: 'approve' });
    assert.notEqual(r.status, 302);
  });

  await step('code is exchanged for tokens (PKCE)', async () => {
    const r = await fetch(`${BASE}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    const t = await r.json();
    assert.ok(t.access_token && t.refresh_token);
    token = t.access_token;
  });

  await step('initialize + tools/list', async () => {
    const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'kaufland-mcp');
    const list = await rpc(token, 'tools/list', {});
    assert.ok(list.result.tools.length > 30);
    assert.ok(list.result.tools.find((t) => t.name === 'kaufland_delete_unit').annotations.destructiveHint);
  });

  await step('notification gets 202', async () => {
    const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(r.status, 202);
  });

  await step('kaufland_ping is signed correctly', async () => {
    const r = await rpc(token, 'tools/call', { name: 'kaufland_ping', arguments: {} });
    assert.ok(!r.result.isError, r.result.content[0].text);
    assert.deepEqual(toolText(r), { message: 'pong' });
  });

  await step('kaufland_list_units pages and converts prices', async () => {
    const r = toolText(await rpc(token, 'tools/call', { name: 'kaufland_list_units', arguments: { limit: 5 } }));
    assert.equal(r.returned, 5);
    assert.equal(r.total, 7);
    assert.equal(r.next_offset, 5);
    assert.equal(r.items[0].listing_price_eur, 19.99);
  });

  await step('kaufland_update_unit sends cents', async () => {
    const r = await rpc(token, 'tools/call', { name: 'kaufland_update_unit', arguments: { id_unit: 101, price_eur: 17.49, amount: 3 } });
    assert.ok(!r.result.isError, r.result.content[0].text);
    const last = seen.filter((s) => s.method === 'PATCH').pop();
    assert.deepEqual(last.body, { listing_price: 1749, amount: 3 });
    assert.match(last.url, /^\/v2\/units\/101\/\?storefront=de$/);
  });

  await step('kaufland_sales_summary filters by date and skips cancellations', async () => {
    const r = toolText(await rpc(token, 'tools/call', { name: 'kaufland_sales_summary', arguments: { from: '2026-10-01', to: '2026-10-31' } }));
    assert.equal(r.positions, 2);
    assert.equal(r.gross_sales_eur, 20);
    assert.equal(r.revenue_net_eur, 15);
  });

  await step('kaufland_open_orders', async () => {
    const r = toolText(await rpc(token, 'tools/call', { name: 'kaufland_open_orders', arguments: {} }));
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].id_order_unit, 3);
  });

  await step('bad arguments give a tool error, not a crash', async () => {
    const r = await rpc(token, 'tools/call', { name: 'kaufland_update_unit', arguments: {} });
    assert.equal(r.result.isError, true);
    const r2 = await rpc(token, 'tools/call', { name: 'kaufland_raw_request', arguments: { method: 'GET', path: '/../../etc' } });
    assert.equal(r2.result.isError, true);
  });

  await step('API errors are reported as tool errors', async () => {
    const r = await rpc(token, 'tools/call', { name: 'kaufland_get_unit', arguments: { id_unit: 999 } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /404/);
  });
} catch (e) {
  failed = true;
  console.error(e, '\n--- wrangler log ---\n', log.slice(-3000));
} finally {
  mock.close();
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(worker.pid), '/T', '/F']);
  else worker.kill();
}
console.log(failed ? '\nE2E FAILED' : '\nE2E PASSED');
process.exitCode = failed ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 1500);
