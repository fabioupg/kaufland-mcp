// MCP tool definitions for the Kaufland Seller API.
// Every tool: { name, title, description, inputSchema, annotations, run(args, api) }.

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

// ---------------------------------------------------------------- helpers
const cents = (eur) => (eur === undefined || eur === null ? undefined : Math.round(Number(String(eur).replace(',', '.')) * 100));
const eur = (c) => (c === undefined || c === null ? null : Math.round(c) / 100);
const unwrap = (r) => (r && r.data !== undefined ? r.data : r);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const bool = (description, extra = {}) => ({ type: 'boolean', description, ...extra });
const obj = (description, extra = {}) => ({ type: 'object', description, additionalProperties: true, ...extra });

const storefront = str('Storefront code, e.g. de, at, cz, sk, pl, fr, it. Defaults to the server setting.');
const limit = (def, max) => int(`Maximum number of items to return (default ${def}, max ${max}).`, { minimum: 1, maximum: max, default: def });
const offset = int('Number of items to skip, for paging. Use next_offset from a previous call.', { minimum: 0, default: 0 });
const compact = bool('Return a short summary per item (prices in EUR) instead of the raw API objects. Default true.', { default: true });

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function compactUnit(u) {
  const p = u.product || {};
  return clean({
    id_unit: u.id_unit, id_offer: u.id_offer, id_product: u.id_product, ean: (p.eans || [])[0], title: p.title,
    condition: u.condition, amount: u.amount, listing_price_eur: eur(u.listing_price), minimum_price_eur: eur(u.minimum_price),
    handling_time: u.handling_time, id_shipping_group: u.id_shipping_group, status: u.status, is_live: u.is_live,
    storefront: u.storefront, date_lastchange_iso: u.date_lastchange_iso,
  });
}

function compactOrderUnit(u) {
  const p = u.product || {};
  const disc = (u.discounts || []).reduce((s, d) => s + (d.discount_value || 0), 0);
  return clean({
    date: (u.ts_created_iso || '').slice(0, 10), id_order: u.id_order, id_order_unit: u.id_order_unit, status: u.status,
    storefront: u.storefront, id_offer: u.id_offer, ean: (p.eans || [])[0], title: p.title,
    price_eur: eur(u.price), shipping_eur: eur(u.shipping_rate), revenue_gross_eur: eur(u.revenue_gross),
    revenue_net_eur: eur(u.revenue_net), vat_eur: eur(u.vat), discount_eur: disc ? eur(disc) : undefined,
    buyer_country: u.shipping_address && u.shipping_address.country,
  });
}

function filterByDate(units, from, to) {
  if (!from && !to) return units;
  return units.filter((u) => {
    const d = (u.ts_created_iso || '').slice(0, 10);
    return (!from || d >= from) && (!to || d <= to);
  });
}

const page = (r, mapFn) => ({ total: r.total ?? null, returned: r.items.length, next_offset: r.next_offset, items: mapFn ? r.items.map(mapFn) : r.items });

// Fields an offer can carry, shared by create/update.
const unitFields = {
  price_eur: num('Listing price in EUR, e.g. 19.99. Converted to cents for the API.'),
  minimum_price_eur: num('Minimum price in EUR for automatic price adjustment.'),
  amount: int('Stock quantity.', { minimum: 0 }),
  condition: str('Condition, e.g. NEW, USED___AS_NEW, USED___VERY_GOOD, USED___GOOD, USED___ACCEPTABLE.'),
  handling_time: int('Handling time in working days.', { minimum: 0 }),
  id_shipping_group: int('Shipping group ID (see kaufland_raw_request GET /shipping-groups).'),
  id_warehouse: int('Warehouse ID.'),
  id_offer: str('Your own SKU / offer ID.'),
  note: str('Note shown to buyers.'),
  vat_indicator: str('VAT indicator, see kaufland_info type=vat_indicators.'),
  extra: obj('Any additional unit fields, sent to the API as-is.'),
};

function unitBody(a) {
  return clean({
    ...(a.extra || {}),
    ean: a.ean, listing_price: cents(a.price_eur), minimum_price: cents(a.minimum_price_eur), amount: a.amount,
    condition: a.condition, handling_time: a.handling_time, id_shipping_group: a.id_shipping_group,
    id_warehouse: a.id_warehouse, id_offer: a.id_offer, note: a.note, vat_indicator: a.vat_indicator,
  });
}

// ---------------------------------------------------------------- tools
export const tools = [
  // ---------------- general
  {
    name: 'kaufland_ping', title: 'Test connection', annotations: READ,
    description: 'Checks that the Kaufland Seller API is reachable and the API keys and signature work.',
    inputSchema: schema({}),
    run: (a, api) => api.ping(),
  },
  {
    name: 'kaufland_info', title: 'Reference data', annotations: READ,
    description: 'Returns Kaufland reference data: available storefronts, locales or VAT indicators.',
    inputSchema: schema({ type: str('Which data to return.', { enum: ['storefronts', 'locales', 'vat_indicators'] }) }, ['type']),
    run: async (a, api) => unwrap(await ({ storefronts: api.storefronts, locales: api.locales, vat_indicators: api.vatIndicators }[a.type])()),
  },

  // ---------------- products & categories
  {
    name: 'kaufland_get_product_by_ean', title: 'Product by EAN', annotations: READ,
    description: 'Looks up a product in the Kaufland catalogue by EAN/GTIN.',
    inputSchema: schema({ ean: str('EAN / GTIN.'), embedded: str('Comma-separated embeds, e.g. units,category.'), storefront }, ['ean']),
    run: async (a, api) => unwrap(await api.productByEan(a.ean, clean({ embedded: a.embedded }), a.storefront)),
  },
  {
    name: 'kaufland_get_product', title: 'Product by ID', annotations: READ,
    description: 'Returns a catalogue product by its Kaufland id_product.',
    inputSchema: schema({ id_product: int('Kaufland product ID.'), embedded: str('Comma-separated embeds, e.g. units,category.'), storefront }, ['id_product']),
    run: async (a, api) => unwrap(await api.product(a.id_product, clean({ embedded: a.embedded }), a.storefront)),
  },
  {
    name: 'kaufland_search_products', title: 'Search catalogue', annotations: READ,
    description: 'Full-text search in the Kaufland product catalogue.',
    inputSchema: schema({ query: str('Search text.'), storefront }, ['query']),
    run: async (a, api) => unwrap(await api.searchProducts(a.query, a.storefront)),
  },
  {
    name: 'kaufland_list_categories', title: 'List categories', annotations: READ,
    description: 'Lists categories, optionally filtered by text or parent category.',
    inputSchema: schema({ q: str('Filter text.'), id_parent: int('Parent category ID.'), storefront }),
    run: async (a, api) => unwrap(await api.categories(clean({ q: a.q, id_parent: a.id_parent }), a.storefront)),
  },
  {
    name: 'kaufland_get_category', title: 'Category details', annotations: READ,
    description: 'Returns a category with its required and optional attributes.',
    inputSchema: schema({ id_category: int('Category ID.'), embedded: str('Embeds, default required_attributes,optional_attributes,parent.'), storefront }, ['id_category']),
    run: async (a, api) => unwrap(await api.category(a.id_category, { embedded: a.embedded || 'required_attributes,optional_attributes,parent' }, a.storefront)),
  },
  {
    name: 'kaufland_decide_category', title: 'Suggest category', annotations: READ,
    description: 'Asks Kaufland which category fits an item (title, description, manufacturer...). Changes nothing.',
    inputSchema: schema({ item: obj('Item data, e.g. { "title": "...", "description": "...", "manufacturer": "..." }.'), price_eur: num('Price in EUR.'), storefront }, ['item']),
    run: async (a, api) => unwrap(await api.decideCategory(a.item, cents(a.price_eur), a.storefront)),
  },

  // ---------------- offers (units)
  {
    name: 'kaufland_list_units', title: 'List my offers', annotations: READ,
    description: 'Lists your own offers (units / listings) with stock, price and status.',
    inputSchema: schema({ limit: limit(100, 1000), offset, embedded: str('Embeds, e.g. product.'), compact, storefront }),
    run: async (a, api) => page(await api.units(clean({ embedded: a.embedded, offset: a.offset }), { max: a.limit || 100 }, a.storefront), a.compact === false ? null : compactUnit),
  },
  {
    name: 'kaufland_get_unit', title: 'Offer details', annotations: READ,
    description: 'Returns one of your offers by id_unit.',
    inputSchema: schema({ id_unit: int('Offer (unit) ID.'), storefront }, ['id_unit']),
    run: async (a, api) => unwrap(await api.unit(a.id_unit, a.storefront)),
  },
  {
    name: 'kaufland_units_status', title: 'Offer live status', annotations: READ,
    description: 'Returns the live status of up to 20 offers.',
    inputSchema: schema({ unit_ids: { type: 'array', items: { type: 'integer' }, maxItems: 20, description: 'Offer IDs.' }, storefront }, ['unit_ids']),
    run: async (a, api) => unwrap(await api.unitStatus(a.unit_ids, a.storefront)),
  },
  {
    name: 'kaufland_create_unit', title: 'Create offer', annotations: WRITE,
    description: 'Creates a new offer for a product (by EAN). Prices in EUR. Defaults: condition NEW, handling_time 1.',
    inputSchema: schema({ ean: str('EAN of the product.'), ...unitFields, storefront }, ['ean', 'price_eur', 'amount']),
    run: async (a, api) => {
      const body = unitBody(a);
      if (!body.condition) body.condition = 'NEW';
      if (body.handling_time === undefined) body.handling_time = 1;
      return unwrap(await api.createUnit(body, a.storefront));
    },
  },
  {
    name: 'kaufland_update_unit', title: 'Update offer (price, stock...)', annotations: WRITE,
    description: 'Changes an existing offer: price, minimum price, stock, handling time and so on. Only the fields you pass are changed. Prices in EUR.',
    inputSchema: schema({ id_unit: int('Offer (unit) ID.'), ...unitFields, storefront }, ['id_unit']),
    run: async (a, api) => {
      const body = unitBody(a);
      if (!Object.keys(body).length) throw new Error('Nothing to update: pass at least one field.');
      return unwrap(await api.updateUnit(a.id_unit, body, a.storefront));
    },
  },
  {
    name: 'kaufland_delete_unit', title: 'Delete offer', annotations: DESTRUCTIVE,
    description: 'Deletes one of your offers. Cannot be undone.',
    inputSchema: schema({ id_unit: int('Offer (unit) ID.'), storefront }, ['id_unit']),
    run: (a, api) => api.deleteUnit(a.id_unit, a.storefront),
  },
  {
    name: 'kaufland_bulk_units', title: 'Bulk create/update offers', annotations: WRITE,
    description: 'Creates or updates up to 150 offers in one request. Each item uses raw API fields (listing_price in CENTS).',
    inputSchema: schema({ units: { type: 'array', maxItems: 150, items: { type: 'object', additionalProperties: true }, description: 'Raw unit objects.' }, storefront }, ['units']),
    run: (a, api) => api.bulkUnits(a.units, a.storefront),
  },

  // ---------------- product data
  {
    name: 'kaufland_upsert_product_data', title: 'Submit product data', annotations: WRITE,
    description: 'Submits product data (attributes, images, description) for an EAN. replace=true replaces all data (PUT), otherwise only the given attributes change (PATCH).',
    inputSchema: schema({ data: obj('Product data, e.g. { "ean": ["..."], "attributes": { ... } }.'), replace: bool('Replace all existing data.', { default: false }), storefront }, ['data']),
    run: (a, api) => (a.replace ? api.putProductData(a.data, a.storefront) : api.patchProductData(a.data, a.storefront)),
  },
  {
    name: 'kaufland_product_data_status', title: 'Product data status', annotations: READ,
    description: 'Shows the processing status of submitted product data for an EAN.',
    inputSchema: schema({ ean: str('EAN.'), storefront }, ['ean']),
    run: async (a, api) => unwrap(await api.productDataStatus(a.ean, a.storefront)),
  },
  {
    name: 'kaufland_import_product_file', title: 'Import product file', annotations: WRITE,
    description: 'Tells Kaufland to import a product data file from a public URL.',
    inputSchema: schema({ url: str('Public URL of the file.'), storefront }, ['url']),
    run: (a, api) => api.importProductFile(a.url, a.storefront),
  },

  // ---------------- orders
  {
    name: 'kaufland_list_orders', title: 'List orders', annotations: READ,
    description: 'Lists orders.',
    inputSchema: schema({ limit: limit(50, 500), offset, ts_created_from_iso: str('Only orders created after this ISO date, e.g. 2026-10-01T00:00:00Z.'), storefront }),
    run: async (a, api) => page(await api.orders(clean({ offset: a.offset, ts_created_from_iso: a.ts_created_from_iso }), { max: a.limit || 50 }, a.storefront)),
  },
  {
    name: 'kaufland_get_order', title: 'Order details', annotations: READ,
    description: 'Returns one order with its order units, buyer and addresses.',
    inputSchema: schema({ id_order: str('Order ID.'), storefront }, ['id_order']),
    run: async (a, api) => unwrap(await api.order(a.id_order, a.storefront)),
  },
  {
    name: 'kaufland_list_order_units', title: 'List order positions', annotations: READ,
    description: 'Lists order units (one per sold item) with price, revenue and status, optionally filtered by status and creation date.',
    inputSchema: schema({
      status: str('Status filter, e.g. need_to_be_sent, sent, received, returned, cancelled.'),
      from: str('Only units created on or after this date (YYYY-MM-DD).'),
      to: str('Only units created on or before this date (YYYY-MM-DD).'),
      limit: limit(100, 1000), offset, compact, storefront,
    }),
    run: async (a, api) => {
      const r = await api.orderUnits(clean({ status: a.status, offset: a.offset }), { max: a.limit || 100 }, a.storefront);
      r.items = filterByDate(r.items, a.from, a.to);
      return page(r, a.compact === false ? null : compactOrderUnit);
    },
  },
  {
    name: 'kaufland_open_orders', title: 'Orders to ship', annotations: READ,
    description: 'Lists all order units that still need to be shipped (status need_to_be_sent).',
    inputSchema: schema({ limit: limit(200, 1000), compact, storefront }),
    run: async (a, api) => page(await api.orderUnits({ status: 'need_to_be_sent' }, { max: a.limit || 200 }, a.storefront), a.compact === false ? null : compactOrderUnit),
  },
  {
    name: 'kaufland_get_order_unit', title: 'Order position details', annotations: READ,
    description: 'Returns one order unit by id_order_unit.',
    inputSchema: schema({ id_order_unit: int('Order unit ID.'), embedded: str('Embeds, e.g. product.') }, ['id_order_unit']),
    run: async (a, api) => unwrap(await api.orderUnit(a.id_order_unit, clean({ embedded: a.embedded }))),
  },
  {
    name: 'kaufland_shipping_addresses', title: 'Shipping addresses', annotations: READ,
    description: 'Returns shipping addresses for orders or order units (comma-separated IDs).',
    inputSchema: schema({ order_ids: str('Comma-separated order IDs.'), order_unit_ids: str('Comma-separated order unit IDs.') }),
    run: async (a, api) => unwrap(await api.shippingAddresses(clean({ order_ids: a.order_ids, order_unit_ids: a.order_unit_ids }))),
  },
  {
    name: 'kaufland_sales_summary', title: 'Sales summary', annotations: READ,
    description: 'Sums up sales (order units) in a date range: number of items, gross sales without cancellations and net revenue according to Kaufland, per status. Optionally returns the rows for accounting.',
    inputSchema: schema({
      from: str('Start date YYYY-MM-DD.'), to: str('End date YYYY-MM-DD.'),
      include_rows: bool('Also return every position (compact, EUR).', { default: false }),
      max_units: int('Maximum order units to scan (default 2000, max 3000).', { minimum: 1, maximum: 3000, default: 2000 }),
      storefront,
    }, ['from', 'to']),
    run: async (a, api) => {
      const max = a.max_units || 2000;
      let r;
      try {
        r = await api.orderUnits({ ts_created_from_iso: `${a.from}T00:00:00Z` }, { max }, a.storefront);
      } catch (e) {
        if (e.status !== 400) throw e;
        r = await api.orderUnits({}, { max }, a.storefront); // endpoint rejected the date filter: filter locally
      }
      const units = filterByDate(r.items, a.from, a.to);
      const valid = units.filter((u) => !/cancel/i.test(u.status || ''));
      const sum = (list, k) => eur(list.reduce((s, u) => s + (u[k] || 0), 0));
      const byStatus = {};
      for (const u of units) byStatus[u.status] = (byStatus[u.status] || 0) + 1;
      return clean({
        from: a.from, to: a.to, positions: units.length, positions_without_cancellations: valid.length,
        gross_sales_eur: sum(valid, 'price'), shipping_eur: sum(valid, 'shipping_rate'),
        revenue_gross_eur: sum(valid, 'revenue_gross'), revenue_net_eur: sum(valid, 'revenue_net'),
        by_status: byStatus,
        warning: r.next_offset !== null && r.items.length >= max ? `Scanned only the first ${max} order units; the range may be incomplete. Raise max_units.` : undefined,
        rows: a.include_rows ? units.map(compactOrderUnit) : undefined,
      });
    },
  },
  {
    name: 'kaufland_ship_order_unit', title: 'Mark as shipped', annotations: WRITE,
    description: 'Marks an order unit as shipped and adds the tracking number(s). The buyer is notified.',
    inputSchema: schema({
      id_order_unit: int('Order unit ID.'),
      carrier_code: str('Carrier code, e.g. DHL, DPD, Hermes, GLS, UPS, DHL_2_MH, Deutsche_Post.'),
      tracking_numbers: str('Tracking number; several separated by commas.'),
    }, ['id_order_unit', 'carrier_code', 'tracking_numbers']),
    run: (a, api) => api.sendUnit(a.id_order_unit, a.carrier_code, a.tracking_numbers),
  },
  {
    name: 'kaufland_cancel_order_unit', title: 'Cancel order position', annotations: DESTRUCTIVE,
    description: 'Cancels an order unit. The buyer is notified. Cannot be undone.',
    inputSchema: schema({ id_order_unit: int('Order unit ID.'), reason: str('Reason, e.g. NoInventory, BuyerRequest, ShippingAddressNotDeliverable, Other.') }, ['id_order_unit', 'reason']),
    run: (a, api) => api.cancelUnit(a.id_order_unit, a.reason),
  },
  {
    name: 'kaufland_fulfil_order_unit', title: 'Confirm order position', annotations: WRITE,
    description: 'Confirms (fulfils) an order unit.',
    inputSchema: schema({ id_order_unit: int('Order unit ID.') }, ['id_order_unit']),
    run: (a, api) => api.fulfilUnit(a.id_order_unit),
  },
  {
    name: 'kaufland_refund_order_unit', title: 'Refund order position', annotations: DESTRUCTIVE,
    description: 'Refunds money to the buyer for an order unit. Amount in EUR. Cannot be undone.',
    inputSchema: schema({ id_order_unit: int('Order unit ID.'), amount_eur: num('Amount to refund in EUR.'), reason: str('Refund reason.') }, ['id_order_unit', 'amount_eur', 'reason']),
    run: (a, api) => api.refundUnit(a.id_order_unit, cents(a.amount_eur), a.reason),
  },

  // ---------------- returns
  {
    name: 'kaufland_list_returns', title: 'List returns', annotations: READ,
    description: 'Lists returns, optionally by status (e.g. return_requested).',
    inputSchema: schema({ status: str('Status filter.'), limit: limit(50, 500), offset, storefront }),
    run: async (a, api) => page(await api.returns(clean({ status: a.status, offset: a.offset }), { max: a.limit || 50 }, a.storefront)),
  },
  {
    name: 'kaufland_get_return', title: 'Return details', annotations: READ,
    description: 'Returns one return with its return units and buyer.',
    inputSchema: schema({ id_return: int('Return ID.') }, ['id_return']),
    run: async (a, api) => unwrap(await api.return(a.id_return)),
  },
  {
    name: 'kaufland_handle_return_unit', title: 'Handle return', annotations: DESTRUCTIVE,
    description: 'Decides on a returned item: accept, reject (message required), clarify (message required) or repair.',
    inputSchema: schema({
      id_return_unit: int('Return unit ID.'),
      action: str('What to do.', { enum: ['accept', 'reject', 'clarify', 'repair'] }),
      message: str('Message to the buyer (required for reject and clarify).'),
    }, ['id_return_unit', 'action']),
    run: (a, api) => {
      if ((a.action === 'reject' || a.action === 'clarify') && !a.message) throw new Error(`"${a.action}" needs a message.`);
      return {
        accept: () => api.acceptReturnUnit(a.id_return_unit),
        reject: () => api.rejectReturnUnit(a.id_return_unit, a.message),
        clarify: () => api.clarifyReturnUnit(a.id_return_unit, a.message),
        repair: () => api.repairReturnUnit(a.id_return_unit),
      }[a.action]();
    },
  },

  // ---------------- tickets
  {
    name: 'kaufland_list_tickets', title: 'List customer tickets', annotations: READ,
    description: 'Lists customer service tickets, optionally by status (e.g. opened).',
    inputSchema: schema({ status: str('Status filter, e.g. opened, closed.'), limit: limit(50, 500), offset, storefront }),
    run: async (a, api) => page(await api.tickets(clean({ status: a.status, offset: a.offset }), { max: a.limit || 50 }, a.storefront)),
  },
  {
    name: 'kaufland_get_ticket', title: 'Ticket details', annotations: READ,
    description: 'Returns one ticket with its messages.',
    inputSchema: schema({ id_ticket: str('Ticket ID.') }, ['id_ticket']),
    run: async (a, api) => unwrap(await api.ticket(a.id_ticket)),
  },
  {
    name: 'kaufland_reply_ticket', title: 'Reply to ticket', annotations: WRITE,
    description: 'Sends a message to the buyer in a ticket.',
    inputSchema: schema({ id_ticket: str('Ticket ID.'), text: str('Message text.'), interim_notice: bool('Mark as interim notice (not the final answer).', { default: false }) }, ['id_ticket', 'text']),
    run: (a, api) => api.ticketMessage(a.id_ticket, a.text, !!a.interim_notice),
  },
  {
    name: 'kaufland_close_ticket', title: 'Close ticket', annotations: WRITE,
    description: 'Closes a ticket.',
    inputSchema: schema({ id_ticket: str('Ticket ID.') }, ['id_ticket']),
    run: (a, api) => api.closeTicket(a.id_ticket),
  },

  // ---------------- invoices & reports
  {
    name: 'kaufland_list_invoices', title: 'List invoices', annotations: READ,
    description: 'Lists invoices you uploaded for orders.',
    inputSchema: schema({ limit: limit(50, 500), offset, storefront }),
    run: async (a, api) => page(await api.invoices(clean({ offset: a.offset }), { max: a.limit || 50 }, a.storefront)),
  },
  {
    name: 'kaufland_upload_invoice', title: 'Upload invoice', annotations: WRITE,
    description: 'Uploads a PDF invoice for an order. The PDF is passed as base64.',
    inputSchema: schema({ id_order: str('Order ID.'), filename: str('File name, e.g. RE-2026-001.pdf.'), pdf_base64: str('PDF content, base64 encoded.') }, ['id_order', 'filename', 'pdf_base64']),
    run: (a, api) => api.uploadInvoice(a.id_order, a.filename, a.pdf_base64),
  },
  {
    name: 'kaufland_delete_invoice', title: 'Delete invoice', annotations: DESTRUCTIVE,
    description: 'Deletes an uploaded invoice.',
    inputSchema: schema({ id_order: str('Order ID.'), id_invoice: int('Invoice ID.') }, ['id_order', 'id_invoice']),
    run: (a, api) => api.deleteInvoice(a.id_order, a.id_invoice),
  },
  {
    name: 'kaufland_request_report', title: 'Request report', annotations: WRITE,
    description: 'Requests a report (e.g. sales, account-listing). Fetch it later with kaufland_get_report.',
    inputSchema: schema({ type: str('Report type, e.g. sales, account-listing.'), params: obj('Report parameters, e.g. { "date_from": "2026-10-01", "date_to": "2026-10-31" }.'), storefront }, ['type']),
    run: (a, api) => api.requestReport(a.type, a.params || {}, a.storefront),
  },
  {
    name: 'kaufland_list_reports', title: 'List reports', annotations: READ,
    description: 'Lists requested reports and their status.',
    inputSchema: schema({}),
    run: async (a, api) => unwrap(await api.reports()),
  },
  {
    name: 'kaufland_get_report', title: 'Report details', annotations: READ,
    description: 'Returns a report, including its download link when it is ready.',
    inputSchema: schema({ id_report: int('Report ID.') }, ['id_report']),
    run: async (a, api) => unwrap(await api.report(a.id_report)),
  },

  // ---------------- webhooks
  {
    name: 'kaufland_list_subscriptions', title: 'List webhooks', annotations: READ,
    description: 'Lists your webhook subscriptions.',
    inputSchema: schema({}),
    run: async (a, api) => unwrap(await api.subscriptions()),
  },
  {
    name: 'kaufland_subscribe', title: 'Add webhook', annotations: WRITE,
    description: 'Subscribes a callback URL to a Kaufland event (e.g. order_new).',
    inputSchema: schema({ event_name: str('Event name.'), callback_url: str('HTTPS URL that receives the events.'), fallback_email: str('E-mail for delivery failures.'), storefront }, ['event_name', 'callback_url']),
    run: (a, api) => api.subscribe(a.event_name, a.callback_url, a.fallback_email, a.storefront),
  },
  {
    name: 'kaufland_unsubscribe', title: 'Remove webhook', annotations: DESTRUCTIVE,
    description: 'Deletes a webhook subscription.',
    inputSchema: schema({ id_subscription: int('Subscription ID.') }, ['id_subscription']),
    run: (a, api) => api.unsubscribe(a.id_subscription),
  },

  // ---------------- escape hatch
  {
    name: 'kaufland_raw_request', title: 'Any API endpoint', annotations: DESTRUCTIVE,
    description: 'Calls any Seller API v2 endpoint not covered by the other tools (e.g. GET /shipping-groups, GET /warehouses). Prices in the API are in CENTS. Prefer the specific tools.',
    inputSchema: schema({
      method: str('HTTP method.', { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }),
      path: str('Path below /v2, e.g. /shipping-groups.'),
      query: obj('Query parameters.'),
      body: obj('JSON body.'),
    }, ['method', 'path']),
    run: (a, api) => {
      if (!/^\/[A-Za-z0-9_\-./]*$/.test(a.path) || a.path.includes('..')) throw new Error('path must look like /some/endpoint');
      return api.request(a.method, a.path, { query: a.query, body: a.body });
    },
  },
];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));
