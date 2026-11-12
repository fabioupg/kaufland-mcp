// The Worker client (Web Crypto) must sign exactly like the CLI (node:crypto).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sign } from '../src/kaufland-client.js';
import { tools } from '../src/tools.js';

const require = createRequire(import.meta.url);
const cli = require('../kaufland.js');

test('signature matches the CLI implementation', async () => {
  const cases = [
    ['GET', 'https://sellerapi.kaufland.com/v2/units/?storefront=de&limit=100&offset=0', '', 1411055926, 'a7d0cb1da1ddbc86c96ee5fedd341b7d8ebfbb2f5c83cfe0909f4e57f05dd403'],
    ['POST', 'https://sellerapi.kaufland.com/v2/units/?storefront=de', '{"ean":"4006381333931","listing_price":1999}', 1700000000, 'secret'],
    ['patch', 'https://sellerapi.kaufland.com/v2/order-units/1/send', '{"carrier_code":"DHL","tracking_numbers":"0034"}', 1, 'ü-secret'],
  ];
  for (const [m, url, body, ts, secret] of cases) {
    assert.equal(await sign(m, url, body, ts, secret), cli.sign(m, url, body, ts, secret));
  }
});

test('tool definitions are well-formed', () => {
  const names = new Set();
  for (const t of tools) {
    assert.match(t.name, /^kaufland_[a-z_]+$/);
    assert.ok(!names.has(t.name), `duplicate ${t.name}`);
    names.add(t.name);
    assert.ok(t.description && t.title && t.annotations && typeof t.run === 'function');
    assert.equal(t.inputSchema.type, 'object');
    for (const r of t.inputSchema.required) assert.ok(t.inputSchema.properties[r], `${t.name}: required ${r} not in properties`);
  }
});
