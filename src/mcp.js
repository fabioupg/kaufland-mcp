// Minimal, stateless MCP server over Streamable HTTP (JSON responses, no SSE).
// Spec: https://modelcontextprotocol.io/specification

import { tools, toolsByName } from './tools.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'kaufland-mcp', title: 'Kaufland Marketplace', version: '1.0.0' };
const MAX_OUTPUT_CHARS = 150_000;

const INSTRUCTIONS = `Tools for the Kaufland Marketplace Seller API v2 (your own seller account).
Prices in tool inputs and compact outputs are in EUR; raw API objects and kaufland_bulk_units / kaufland_raw_request use CENTS.
Lists are paged: pass offset=next_offset to continue.
Tools marked destructive (delete, cancel, refund, return decisions, raw requests) act on the live account: confirm with the user first.`;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function checkArgs(tool, args) {
  const s = tool.inputSchema;
  for (const k of s.required || []) {
    if (args[k] === undefined || args[k] === null || args[k] === '') return `Missing required argument "${k}".`;
  }
  for (const [k, v] of Object.entries(args)) {
    const p = s.properties[k];
    if (!p) return `Unknown argument "${k}".`;
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of: ${p.enum.join(', ')}.`;
    const t = Array.isArray(v) ? 'array' : typeof v;
    const ok = { string: t === 'string', integer: Number.isInteger(v), number: t === 'number', boolean: t === 'boolean', object: t === 'object' && !Array.isArray(v), array: t === 'array' }[p.type];
    if (ok === false) return `"${k}" must be of type ${p.type}.`;
  }
  return null;
}

async function callTool(params, api) {
  const tool = toolsByName.get(params && params.name);
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${params && params.name}` } };
  const args = (params.arguments && typeof params.arguments === 'object') ? params.arguments : {};
  const bad = checkArgs(tool, args);
  if (bad) return { result: { content: [{ type: 'text', text: bad }], isError: true } };
  try {
    const out = await tool.run(args, api);
    let text = typeof out === 'string' ? out : JSON.stringify(out ?? { ok: true }, null, 1);
    if (text.length > MAX_OUTPUT_CHARS) {
      text = text.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated: ${text.length} chars total. Use limit/offset or compact=true.]`;
    }
    return { result: { content: [{ type: 'text', text }] } };
  } catch (e) {
    const detail = e.body && typeof e.body === 'object' ? '\n' + JSON.stringify(e.body) : '';
    return { result: { content: [{ type: 'text', text: `Kaufland API error: ${e.message}${detail}` }], isError: true } };
  }
}

async function handleMessage(msg, api) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return msg && msg.id !== undefined ? rpcError(msg.id, -32600, 'Invalid request') : null;
  }
  const isNotification = msg.id === undefined;
  if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...

  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0', id,
        result: { tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations: { title, ...annotations } })) },
      };
    case 'tools/call': {
      const r = await callTool(params, api);
      return r.error ? { jsonrpc: '2.0', id, error: r.error } : { jsonrpc: '2.0', id, result: r.result };
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handles a request to the MCP endpoint. `api` is a Kaufland client from createClient(). */
export async function handleMcp(request, api) {
  if (request.method === 'GET' || request.method === 'DELETE') {
    return new Response('This server does not offer an SSE stream or sessions.', { status: 405, headers: { Allow: 'POST' } });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });

  let body;
  try { body = await request.json(); } catch { return json(rpcError(null, -32700, 'Parse error'), 400); }

  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleMessage(m, api)))).filter(Boolean);
    return replies.length ? json(replies) : new Response(null, { status: 202 });
  }
  const reply = await handleMessage(body, api);
  return reply ? json(reply) : new Response(null, { status: 202 });
}
