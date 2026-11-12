// Kaufland Marketplace Seller API v2 client for Cloudflare Workers (and Node >= 18).
// Uses only fetch + Web Crypto, no dependencies. Docs: https://sellerapi.kaufland.com/?page=rest-api

export class KauflandError extends Error {
  constructor(status, body) {
    const msg = body && typeof body === 'object'
      ? `${status} ${body.type || ''} ${body.message || ''}`.trim() +
        (body.errors && body.errors.length ? ' :: ' + body.errors.map((e) => `${e.field}: ${e.message}`).join('; ') : '')
      : `${status} ${body || ''}`;
    super(msg);
    this.status = status;
    this.body = body;
  }
}

const enc = new TextEncoder();
const keyCache = new Map();

/** HMAC-SHA256 over METHOD\nURL\nBODY\nTIMESTAMP, hex encoded (Kaufland signature scheme). */
export async function sign(method, url, body, timestamp, secret) {
  let key = keyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, key);
  }
  const data = [method.toUpperCase(), url, body || '', String(timestamp)].join('\n');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Path segments come from the model: never let them escape the intended endpoint.
const seg = (v) => encodeURIComponent(String(v));

export function createClient(cfg) {
  const CFG = {
    baseUrl: (cfg.baseUrl || 'https://sellerapi.kaufland.com/v2').replace(/\/+$/, ''),
    clientKey: cfg.clientKey || '',
    secretKey: cfg.secretKey || '',
    storefront: cfg.storefront || 'de',
    userAgent: cfg.userAgent || 'Inhouse_development',
    maxRetries: cfg.maxRetries ?? 3,
  };

  function buildUrl(p, query) {
    let url = CFG.baseUrl + (p.startsWith('/') ? p : '/' + p);
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
        else qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    return url;
  }

  async function request(method, p, { query, body } = {}, attempt = 0) {
    method = method.toUpperCase();
    if (!CFG.clientKey || !CFG.secretKey) {
      throw new Error('KAUFLAND_CLIENT_KEY / KAUFLAND_SECRET_KEY are not configured on the server.');
    }
    const url = buildUrl(p, query);
    const bodyStr = body === undefined || body === null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const ts = Math.floor(Date.now() / 1000);
    const headers = {
      Accept: 'application/json',
      'Shop-Client-Key': CFG.clientKey,
      'Shop-Timestamp': String(ts),
      'Shop-Signature': await sign(method, url, bodyStr, ts, CFG.secretKey),
      'User-Agent': CFG.userAgent,
    };
    if (bodyStr) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, { method, headers, body: bodyStr || undefined });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if ((res.status === 429 || res.status === 503) && attempt < CFG.maxRetries) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      return request(method, p, { query, body }, attempt + 1);
    }
    if (!res.ok) throw new KauflandError(res.status, data);
    return data === null ? { status: res.status, location: res.headers.get('location') } : data;
  }

  // Fetches pages until `max` items are collected or the endpoint runs out.
  async function paginate(p, query = {}, { pageSize = 100, max = 100 } = {}) {
    const out = [];
    let offset = Number(query.offset || 0);
    let total;
    for (;;) {
      const limit = Math.min(pageSize, max - out.length);
      const r = await request('GET', p, { query: { ...query, limit, offset } });
      const items = Array.isArray(r) ? r : (r && r.data) || [];
      out.push(...items);
      if (r && r.pagination) total = r.pagination.total;
      offset += items.length;
      if (!items.length || items.length < limit || out.length >= max || (total !== undefined && offset >= total)) break;
    }
    return { items: out.slice(0, max), total, next_offset: total !== undefined && offset < total ? offset : null };
  }

  const sf = (storefront, o = {}) => ({ storefront: storefront || CFG.storefront, ...o });

  return {
    CFG, request, paginate, sf,
    // Info
    ping: () => request('GET', '/status/ping'),
    storefronts: () => request('GET', '/info/storefront'),
    locales: () => request('GET', '/info/locale'),
    vatIndicators: () => request('GET', '/info/vat-indicators'),
    // Products & categories
    productByEan: (ean, q, s) => request('GET', `/products/ean/${seg(ean)}`, { query: sf(s, q) }),
    product: (id, q, s) => request('GET', `/products/${seg(id)}`, { query: sf(s, q) }),
    searchProducts: (q, s) => request('GET', '/products/search', { query: sf(s, { q }) }),
    categories: (q, s) => request('GET', '/categories/', { query: sf(s, q) }),
    category: (id, q, s) => request('GET', `/categories/${seg(id)}`, { query: sf(s, q) }),
    decideCategory: (item, price, s) => request('POST', '/categories/decide/', { query: sf(s), body: { item, price } }),
    // Offers (units)
    units: (q, opts, s) => paginate('/units/', sf(s, q), opts),
    unit: (id, s) => request('GET', `/units/${seg(id)}/`, { query: sf(s) }),
    createUnit: (u, s) => request('POST', '/units/', { query: sf(s), body: u }),
    updateUnit: (id, u, s) => request('PATCH', `/units/${seg(id)}/`, { query: sf(s), body: u }),
    deleteUnit: (id, s) => request('DELETE', `/units/${seg(id)}/`, { query: sf(s) }),
    bulkUnits: (arr, s) => request('POST', '/units/bulk', { query: sf(s), body: arr }),
    unitStatus: (ids, s) => request('POST', '/units/status', { query: sf(s), body: { unit_ids: ids } }),
    // Product data
    putProductData: (d, s) => request('PUT', '/product-data/', { query: sf(s), body: d }),
    patchProductData: (d, s) => request('PATCH', '/product-data/', { query: sf(s), body: d }),
    productDataStatus: (ean, s) => request('GET', `/product-data/status/${seg(ean)}`, { query: sf(s) }),
    importProductFile: (url, s) => request('POST', '/product-data/import-file', { query: sf(s), body: { url } }),
    // Orders
    orders: (q, opts, s) => paginate('/orders', sf(s, q), opts),
    order: (id, s) => request('GET', `/orders/${seg(id)}`, { query: sf(s) }),
    orderUnits: (q, opts, s) => paginate('/order-units', sf(s, q), opts),
    orderUnit: (id, q) => request('GET', `/order-units/${seg(id)}`, { query: q }),
    sendUnit: (id, carrier_code, tracking_numbers) =>
      request('PATCH', `/order-units/${seg(id)}/send`, { body: { carrier_code, tracking_numbers } }),
    cancelUnit: (id, reason) => request('PATCH', `/order-units/${seg(id)}/cancel`, { body: { reason } }),
    fulfilUnit: (id) => request('PATCH', `/order-units/${seg(id)}/fulfil`),
    refundUnit: (id, amount, reason) => request('PATCH', `/order-units/${seg(id)}/refund`, { body: { amount, reason } }),
    shippingAddresses: (q) => request('GET', '/shipping-addresses', { query: q }),
    // Returns
    returns: (q, opts, s) => paginate('/returns', sf(s, q), opts),
    return: (id) => request('GET', `/returns/${seg(id)}`, { query: { embedded: ['return_units', 'buyer'] } }),
    acceptReturnUnit: (id) => request('PATCH', `/return-units/${seg(id)}/accept`),
    rejectReturnUnit: (id, message) => request('PATCH', `/return-units/${seg(id)}/reject`, { body: { message } }),
    clarifyReturnUnit: (id, message) => request('PATCH', `/return-units/${seg(id)}/clarify`, { body: { message } }),
    repairReturnUnit: (id) => request('PATCH', `/return-units/${seg(id)}/repair`),
    // Tickets
    tickets: (q, opts, s) => paginate('/tickets', sf(s, q), opts),
    ticket: (id) => request('GET', `/tickets/${seg(id)}`),
    ticketMessage: (id, text, interim_notice = false) =>
      request('POST', `/tickets/${seg(id)}/messages`, { body: { text, interim_notice } }),
    closeTicket: (id) => request('PATCH', `/tickets/${seg(id)}/close`),
    // Invoices
    invoices: (q, opts, s) => paginate('/order-invoices', sf(s, q), opts),
    uploadInvoice: (id_order, original_name, base64) => request('POST', `/order-invoices/${seg(id_order)}`, {
      body: { original_name, mime_type: 'application/pdf', data: base64 },
    }),
    deleteInvoice: (id_order, id_invoice) => request('DELETE', `/order-invoices/${seg(id_order)}/${seg(id_invoice)}/`),
    // Reports
    requestReport: (type, body, s) => request('POST', `/reports/${seg(type)}`, { query: sf(s), body: body || {} }),
    reports: () => request('GET', '/reports'),
    report: (id) => request('GET', `/reports/${seg(id)}`),
    // Webhooks
    subscriptions: (q) => request('GET', '/subscriptions', { query: q }),
    subscribe: (event_name, callback_url, fallback_email, s) =>
      request('POST', '/subscriptions', { query: sf(s), body: { event_name, callback_url, fallback_email } }),
    unsubscribe: (id) => request('DELETE', `/subscriptions/${seg(id)}/`),
  };
}
