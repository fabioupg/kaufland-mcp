#!/usr/bin/env node
// Kaufland Marketplace Seller API v2 – Client + CLI (keine Abhängigkeiten, Node >= 18)
// Doku: https://sellerapi.kaufland.com/?page=rest-api
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- config
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv(path.join(__dirname, '.env'));

const CFG = {
  baseUrl: (process.env.KAUFLAND_BASE_URL || 'https://sellerapi.kaufland.com/v2').replace(/\/+$/, ''),
  clientKey: process.env.KAUFLAND_CLIENT_KEY || '',
  secretKey: process.env.KAUFLAND_SECRET_KEY || '',
  storefront: process.env.KAUFLAND_STOREFRONT || 'de',
  userAgent: process.env.KAUFLAND_USER_AGENT || 'Inhouse_development',
};

// ---------------------------------------------------------------- core client
function sign(method, uri, body, timestamp, secret) {
  const s = [method.toUpperCase(), uri, body || '', String(timestamp)].join('\n');
  return crypto.createHmac('sha256', secret).update(s).digest('hex');
}

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

class KauflandError extends Error {
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

let DRY_RUN = false;

async function request(method, p, { query, body } = {}, attempt = 0) {
  method = method.toUpperCase();
  const url = buildUrl(p, query);
  const bodyStr = body === undefined || body === null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));

  if (DRY_RUN && method !== 'GET') {
    console.error(`[dry-run] ${method} ${url}`);
    if (bodyStr) console.error(bodyStr);
    return { dryRun: true };
  }
  if (!CFG.clientKey || !CFG.secretKey) {
    throw new Error('KAUFLAND_CLIENT_KEY / KAUFLAND_SECRET_KEY fehlen. Trage sie in kaufland/.env ein (siehe .env.example).');
  }

  const ts = Math.floor(Date.now() / 1000);
  const headers = {
    Accept: 'application/json',
    'Shop-Client-Key': CFG.clientKey,
    'Shop-Timestamp': String(ts),
    'Shop-Signature': sign(method, url, bodyStr, ts, CFG.secretKey),
    'User-Agent': CFG.userAgent,
  };
  if (bodyStr) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, { method, headers, body: bodyStr || undefined });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if ((res.status === 429 || res.status === 503) && attempt < 5) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return request(method, p, { query, body }, attempt + 1);
  }
  if (!res.ok) throw new KauflandError(res.status, data);
  return data === null ? { status: res.status, location: res.headers.get('location') } : data;
}

// Holt alle Seiten eines paginierten Endpoints
async function paginate(p, query = {}, { pageSize = 100, max = Infinity } = {}) {
  const out = [];
  let offset = Number(query.offset || 0);
  for (;;) {
    const r = await request('GET', p, { query: { ...query, limit: pageSize, offset } });
    const items = Array.isArray(r) ? r : (r && r.data) || [];
    out.push(...items);
    const total = r && r.pagination ? r.pagination.total : undefined;
    offset += items.length;
    if (!items.length || items.length < pageSize || out.length >= max || (total !== undefined && offset >= total)) break;
  }
  return out.slice(0, max);
}

const sf = (o = {}) => ({ storefront: CFG.storefront, ...o });

// ---------------------------------------------------------------- API wrapper
const api = {
  request, paginate, sign,
  // Info
  ping: () => request('GET', '/status/ping'),
  storefronts: () => request('GET', '/info/storefront'),
  locales: () => request('GET', '/info/locale'),
  vatIndicators: () => request('GET', '/info/vat-indicators'),
  // Produkte & Kategorien
  productByEan: (ean, q = {}) => request('GET', `/products/ean/${ean}`, { query: sf(q) }),
  product: (id, q = {}) => request('GET', `/products/${id}`, { query: sf(q) }),
  searchProducts: (q, extra = {}) => request('GET', '/products/search', { query: sf({ q, ...extra }) }),
  categories: (q = {}) => request('GET', '/categories/', { query: sf(q) }),
  category: (id, q = {}) => request('GET', `/categories/${id}`, { query: sf(q) }),
  decideCategory: (item, price) => request('POST', '/categories/decide/', { query: sf(), body: { item, price } }),
  // Angebote (Units)
  units: (q = {}, opts) => paginate('/units/', sf(q), opts),
  unit: (id) => request('GET', `/units/${id}/`, { query: sf() }),
  createUnit: (u) => request('POST', '/units/', { query: sf(), body: u }),
  updateUnit: (id, u) => request('PATCH', `/units/${id}/`, { query: sf(), body: u }),
  deleteUnit: (id) => request('DELETE', `/units/${id}/`, { query: sf() }),
  bulkUnits: (arr) => request('POST', '/units/bulk', { query: sf(), body: arr }),
  unitStatus: (ids) => request('POST', '/units/status', { query: sf(), body: { unit_ids: ids } }),
  // Produktdaten
  putProductData: (d) => request('PUT', '/product-data/', { query: sf(), body: d }),
  patchProductData: (d) => request('PATCH', '/product-data/', { query: sf(), body: d }),
  productDataStatus: (ean) => request('GET', `/product-data/status/${ean}`, { query: sf() }),
  importProductFile: (url) => request('POST', '/product-data/import-file', { query: sf(), body: { url } }),
  // Bestellungen
  orders: (q = {}, opts) => paginate('/orders', sf(q), opts),
  order: (id) => request('GET', `/orders/${id}`, { query: sf() }),
  orderUnits: (q = {}, opts) => paginate('/order-units', sf(q), opts),
  orderUnit: (id, q = {}) => request('GET', `/order-units/${id}`, { query: q }),
  sendUnit: (id, carrier_code, tracking_numbers) =>
    request('PATCH', `/order-units/${id}/send`, { body: { carrier_code, tracking_numbers } }),
  cancelUnit: (id, reason) => request('PATCH', `/order-units/${id}/cancel`, { body: { reason } }),
  fulfilUnit: (id) => request('PATCH', `/order-units/${id}/fulfil`),
  refundUnit: (id, amount, reason) => request('PATCH', `/order-units/${id}/refund`, { body: { amount, reason } }),
  shippingAddresses: (q) => request('GET', '/shipping-addresses', { query: q }),
  // Retouren
  returns: (q = {}, opts) => paginate('/returns', sf(q), opts),
  return: (id) => request('GET', `/returns/${id}`, { query: { embedded: ['return_units', 'buyer'] } }),
  acceptReturnUnit: (id) => request('PATCH', `/return-units/${id}/accept`),
  rejectReturnUnit: (id, message) => request('PATCH', `/return-units/${id}/reject`, { body: { message } }),
  clarifyReturnUnit: (id, message) => request('PATCH', `/return-units/${id}/clarify`, { body: { message } }),
  repairReturnUnit: (id) => request('PATCH', `/return-units/${id}/repair`),
  // Tickets
  tickets: (q = {}, opts) => paginate('/tickets', sf(q), opts),
  ticket: (id) => request('GET', `/tickets/${id}`),
  ticketMessage: (id, text, interim_notice = false) =>
    request('POST', `/tickets/${id}/messages`, { body: { text, interim_notice } }),
  closeTicket: (id) => request('PATCH', `/tickets/${id}/close`),
  // Rechnungen
  invoices: (q = {}, opts) => paginate('/order-invoices', sf(q), opts),
  uploadInvoice: (id_order, file) => request('POST', `/order-invoices/${id_order}`, {
    body: { original_name: path.basename(file), mime_type: 'application/pdf', data: fs.readFileSync(file).toString('base64') },
  }),
  deleteInvoice: (id_order, id_invoice) => request('DELETE', `/order-invoices/${id_order}/${id_invoice}/`),
  // Reports
  requestReport: (type, body = {}) => request('POST', `/reports/${type}`, { query: sf(), body }),
  reports: () => request('GET', '/reports'),
  report: (id) => request('GET', `/reports/${id}`),
  // Webhooks
  subscriptions: (q = {}) => request('GET', '/subscriptions', { query: q }),
  subscribe: (event_name, callback_url, fallback_email) =>
    request('POST', '/subscriptions', { query: sf(), body: { event_name, callback_url, fallback_email } }),
  unsubscribe: (id) => request('DELETE', `/subscriptions/${id}/`),
};

module.exports = { api, CFG, sign, KauflandError };

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, ...rest] = a.slice(2).split('=');
      if (rest.length) opt[k] = rest.join('=');
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

function jsonArg(opt) {
  if (opt.file) return JSON.parse(fs.readFileSync(opt.file, 'utf8'));
  if (opt.json) return JSON.parse(opt.json);
  return undefined;
}

// Euro-String ("19,99" / "19.99") -> Cent
const cents = (v) => (v === undefined ? undefined : Math.round(parseFloat(String(v).replace(',', '.')) * 100));
const euro = (c) => (c === undefined || c === null ? '' : (c / 100).toFixed(2).replace('.', ','));

function csvEscape(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function writeCsv(file, rows, cols) {
  const lines = [cols.join(';'), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(';'))];
  fs.writeFileSync(file, '﻿' + lines.join('\r\n'), 'utf8'); // BOM für Excel
}

function unitFromOpts(opt) {
  const u = jsonArg(opt) || {};
  if (opt.ean) u.ean = String(opt.ean);
  if (opt.price) u.listing_price = cents(opt.price);
  if (opt['min-price']) u.minimum_price = cents(opt['min-price']);
  if (opt.amount !== undefined) u.amount = Number(opt.amount);
  if (opt.condition) u.condition = opt.condition;
  if (opt['handling-time'] !== undefined) u.handling_time = Number(opt['handling-time']);
  if (opt['shipping-group']) u.id_shipping_group = Number(opt['shipping-group']);
  if (opt.warehouse) u.id_warehouse = Number(opt.warehouse);
  if (opt.offer) u.id_offer = String(opt.offer);
  if (opt.note) u.note = opt.note;
  if (opt.vat) u.vat_indicator = opt.vat;
  return u;
}

const HELP = `Kaufland Seller API CLI

Nutzung: node kaufland.js <befehl> [argumente] [--storefront de] [--dry-run]

Allgemein
  ping                                  Verbindung + Signatur testen
  info storefronts|locales|vat          Stammdaten
  raw <METHOD> <pfad> [--json '{..}'] [--query 'a=1&b=2']   Beliebiger Endpoint

Produkte
  ean <EAN>                             Produkt per EAN
  product <id_product> [--embedded units]
  search <suchbegriff>
  categories [--q text] [--id_parent 1]
  category <id>

Angebote / Listings (Units)
  units [--csv datei.csv]               Alle eigenen Angebote
  unit <id_unit>
  unit-create --ean X --price 19,99 --amount 5 [--condition NEW] [--handling-time 1]
              [--shipping-group ID] [--offer SKU] [--min-price 15,00] [--note ..]
  unit-update <id_unit> [--price ..] [--amount ..] [--min-price ..] ...
  unit-delete <id_unit>
  units-bulk --file units.json          max 150 pro Request
  units-status <id1,id2,...>            Live-Status (max 20)
  stock <id_unit> <menge>               Kurzform: Bestand setzen
  price <id_unit> <preis>               Kurzform: Preis setzen (Euro)

Produktdaten
  product-data --file daten.json [--replace]
  product-data-status <EAN>
  product-import <öffentliche-URL>

Bestellungen
  orders [--csv datei.csv]
  order <id_order>
  order-units [--status need_to_be_sent|sent|...] [--csv datei.csv] [--from 2026-10-01 --to 2026-10-31]
  order-unit <id_order_unit>
  open-orders                            Alles was versendet werden muss
  ship <id_order_unit> <carrier> <tracking[,tracking2]>   z.B. ship 123 DHL 00340434...
  cancel <id_order_unit> <reason>        z.B. NoInventory
  refund <id_order_unit> <betrag-euro> <reason>
  addresses --order_ids A,B | --order_unit_ids 1,2

Buchhaltung
  sales-export <von> <bis> [--out umsatz.csv]   Verkäufe (Order-Units) eines Zeitraums als CSV
  invoices
  invoice-upload <id_order> <rechnung.pdf>
  report <sales|account-listing> [--json '{..}']  Report anfordern
  reports                                Reports auflisten
  report-get <id_report>

Retouren & Tickets
  returns [--status return_requested]
  return <id_return>
  return-accept <id_return_unit> | return-reject <id_return_unit> <nachricht>
  tickets [--status opened]
  ticket <id> | ticket-reply <id> <text> | ticket-close <id>

Webhooks
  subscriptions | subscribe <event> <url> [email] | unsubscribe <id>

Optionen
  --dry-run     Schreibende Requests nur anzeigen, nicht senden
  --storefront  de, cz, sk, pl, at, fr, it ... (Standard aus .env)
  --raw         Rohes JSON ausgeben
`;

const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const unwrap = (r) => (r && r.data !== undefined ? r.data : r);

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  const [cmd, a, b, c] = pos;
  if (opt.storefront) CFG.storefront = opt.storefront;
  if (opt['dry-run']) DRY_RUN = true;

  switch (cmd) {
    case undefined: case 'help': case '--help': return out(HELP);
    case 'ping': return out(await api.ping());
    case 'info': {
      const f = { storefronts: api.storefronts, locales: api.locales, vat: api.vatIndicators }[a];
      if (!f) throw new Error('info storefronts|locales|vat');
      return out(unwrap(await f()));
    }
    case 'raw': {
      const query = opt.query ? Object.fromEntries(new URLSearchParams(opt.query)) : undefined;
      return out(await request(a, b, { query, body: jsonArg(opt) }));
    }

    case 'ean': return out(unwrap(await api.productByEan(a, opt.embedded ? { embedded: opt.embedded } : {})));
    case 'product': return out(unwrap(await api.product(a, opt.embedded ? { embedded: opt.embedded } : {})));
    case 'search': return out(unwrap(await api.searchProducts(pos.slice(1).join(' '))));
    case 'categories': return out(unwrap(await api.categories({ q: opt.q, id_parent: opt.id_parent })));
    case 'category': return out(unwrap(await api.category(a, { embedded: opt.embedded || 'required_attributes,optional_attributes,parent' })));

    case 'units': {
      const units = await api.units({ embedded: opt.embedded });
      if (opt.csv) {
        writeCsv(opt.csv, units.map((u) => ({ ...u, listing_price_eur: euro(u.listing_price), minimum_price_eur: euro(u.minimum_price) })),
          ['id_unit', 'id_offer', 'id_product', 'condition', 'amount', 'listing_price_eur', 'minimum_price_eur', 'handling_time', 'id_shipping_group', 'status', 'is_live', 'storefront', 'date_lastchange_iso']);
        return out(`${units.length} Angebote -> ${opt.csv}`);
      }
      if (opt.raw) return out(units);
      for (const u of units) console.log(`${u.id_unit}\t${u.id_offer || ''}\t${u.id_product}\tMenge ${u.amount}\t${euro(u.listing_price)} €\t${u.status}${u.is_live === false ? ' (nicht live)' : ''}`);
      return out(`\n${units.length} Angebote`);
    }
    case 'unit': return out(unwrap(await api.unit(a)));
    case 'unit-create': {
      const u = unitFromOpts(opt);
      if (!u.condition) u.condition = 'NEW';
      if (u.handling_time === undefined) u.handling_time = 1;
      return out(unwrap(await api.createUnit(u)));
    }
    case 'unit-update': return out(unwrap(await api.updateUnit(a, unitFromOpts(opt))));
    case 'unit-delete': return out(await api.deleteUnit(a));
    case 'units-bulk': return out(await api.bulkUnits(jsonArg(opt)));
    case 'units-status': return out(unwrap(await api.unitStatus(String(a).split(',').map(Number))));
    case 'stock': return out(unwrap(await api.updateUnit(a, { amount: Number(b) })));
    case 'price': return out(unwrap(await api.updateUnit(a, { listing_price: cents(b) })));

    case 'product-data': {
      const d = jsonArg(opt);
      return out(await (opt.replace ? api.putProductData(d) : api.patchProductData(d)));
    }
    case 'product-data-status': return out(unwrap(await api.productDataStatus(a)));
    case 'product-import': return out(await api.importProductFile(a));

    case 'orders': {
      const orders = await api.orders({});
      if (opt.csv) { writeCsv(opt.csv, orders, ['id_order', 'ts_created_iso', 'order_units_count', 'storefront', 'is_marketplace_deemed_supplier']); return out(`${orders.length} Bestellungen -> ${opt.csv}`); }
      return out(orders);
    }
    case 'order': return out(unwrap(await api.order(a)));
    case 'order-units': case 'open-orders': {
      const status = cmd === 'open-orders' ? 'need_to_be_sent' : opt.status;
      let units = await api.orderUnits(status ? { status } : {});
      units = filterByDate(units, opt.from, opt.to);
      if (opt.csv) { writeCsv(opt.csv, units.map(flatOrderUnit), SALES_COLS); return out(`${units.length} Positionen -> ${opt.csv}`); }
      if (opt.raw) return out(units);
      for (const u of units) {
        const p = u.product || {};
        console.log(`${u.id_order_unit}\t${u.id_order}\t${(u.ts_created_iso || '').slice(0, 10)}\t${u.status}\t${euro(u.price)} €\t${(p.title || '').slice(0, 60)}`);
      }
      return out(`\n${units.length} Positionen`);
    }
    case 'order-unit': return out(unwrap(await api.orderUnit(a, { embedded: opt.embedded })));
    case 'ship': return out(await api.sendUnit(a, b, c));
    case 'cancel': return out(await api.cancelUnit(a, b));
    case 'fulfil': return out(await api.fulfilUnit(a));
    case 'refund': return out(await api.refundUnit(a, cents(b), c));
    case 'addresses': return out(unwrap(await api.shippingAddresses({ order_ids: opt.order_ids, order_unit_ids: opt.order_unit_ids })));

    case 'sales-export': {
      if (!a || !b) throw new Error('sales-export <von YYYY-MM-DD> <bis YYYY-MM-DD>');
      const units = filterByDate(await api.orderUnits({}), a, b);
      const file = opt.out || `kaufland_umsatz_${a}_${b}.csv`;
      writeCsv(file, units.map(flatOrderUnit), SALES_COLS);
      const sum = (k) => units.filter((u) => !/cancel/i.test(u.status)).reduce((s, u) => s + (u[k] || 0), 0);
      return out(`${units.length} Positionen -> ${file}\nUmsatz brutto (ohne Storno): ${euro(sum('price'))} €\nRevenue netto lt. Kaufland: ${euro(sum('revenue_net'))} €`);
    }
    case 'invoices': return out(await api.invoices({}));
    case 'invoice-upload': return out(await api.uploadInvoice(a, b));
    case 'report': return out(await api.requestReport(a, jsonArg(opt) || {}));
    case 'reports': return out(unwrap(await api.reports()));
    case 'report-get': return out(unwrap(await api.report(a)));

    case 'returns': return out(await api.returns(opt.status ? { status: opt.status } : {}));
    case 'return': return out(unwrap(await api.return(a)));
    case 'return-accept': return out(await api.acceptReturnUnit(a));
    case 'return-reject': return out(await api.rejectReturnUnit(a, pos.slice(2).join(' ')));
    case 'tickets': return out(await api.tickets(opt.status ? { status: opt.status } : {}));
    case 'ticket': return out(unwrap(await api.ticket(a)));
    case 'ticket-reply': return out(await api.ticketMessage(a, pos.slice(2).join(' ')));
    case 'ticket-close': return out(await api.closeTicket(a));

    case 'subscriptions': return out(unwrap(await api.subscriptions()));
    case 'subscribe': return out(await api.subscribe(a, b, c));
    case 'unsubscribe': return out(await api.unsubscribe(a));

    default: throw new Error(`Unbekannter Befehl "${cmd}". "node kaufland.js help" zeigt alle Befehle.`);
  }
}

const SALES_COLS = ['datum', 'id_order', 'id_order_unit', 'status', 'storefront', 'id_offer', 'ean', 'titel',
  'preis_brutto_eur', 'versand_eur', 'revenue_gross_eur', 'revenue_net_eur', 'mwst_eur', 'rabatt_eur', 'kaeufer_land'];

function flatOrderUnit(u) {
  const p = u.product || {};
  const disc = (u.discounts || []).reduce((s, d) => s + (d.discount_value || 0), 0);
  return {
    datum: (u.ts_created_iso || '').slice(0, 10), id_order: u.id_order, id_order_unit: u.id_order_unit, status: u.status,
    storefront: u.storefront, id_offer: u.id_offer, ean: (p.eans || [])[0], titel: p.title,
    preis_brutto_eur: euro(u.price), versand_eur: euro(u.shipping_rate), revenue_gross_eur: euro(u.revenue_gross),
    revenue_net_eur: euro(u.revenue_net), mwst_eur: euro(u.vat), rabatt_eur: disc ? euro(disc) : '',
    kaeufer_land: (u.shipping_address && u.shipping_address.country) || '',
  };
}

function filterByDate(units, from, to) {
  if (!from && !to) return units;
  return units.filter((u) => {
    const d = (u.ts_created_iso || '').slice(0, 10);
    return (!from || d >= from) && (!to || d <= to);
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Fehler:', e.message);
    if (e.body && process.argv.includes('--raw')) console.error(JSON.stringify(e.body, null, 2));
    process.exit(1);
  });
}
