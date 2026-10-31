import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLatency, formatTokens, formatUsdcShort } from '../web/src/format.js';
import { callSamples, gatewayBaseUrl, proxySamples, x402Samples } from '../web/src/snippets.js';

test('compact number formats never hide non-zero amounts', () => {
  assert.equal(formatTokens(9999), '9,999');
  assert.equal(formatTokens(12_345), '12.3K');
  assert.equal(formatTokens(2_000_000), '2M');
  assert.equal(formatTokens(null), '—');
  assert.equal(formatLatency(850), '850 ms');
  assert.equal(formatLatency(1234), '1.23 s');
  assert.equal(formatUsdcShort('0'), '0');
  assert.equal(formatUsdcShort('1'), '0.000000001');
  assert.equal(formatUsdcShort('344712345'), '0.3447');
  assert.equal(formatUsdcShort('12340000000'), '12.34');
});

test('API key samples call the gateway directly with the key', () => {
  const samples = callSamples({ baseUrl: 'https://api.example.com/v1', model: 'm/x', apiKey: 'r3_live_test' });
  assert.deepEqual(samples.map((sample) => sample.label), ['Python', 'Node.js', 'Claude Code', 'Codex', 'cURL']);
  const byLabel = Object.fromEntries(samples.map((sample) => [sample.label, sample.code]));
  assert.ok(byLabel['Claude Code'].includes('ANTHROPIC_BASE_URL="https://api.example.com"\n'));
  assert.ok(byLabel['Claude Code'].includes('ANTHROPIC_AUTH_TOKEN="r3_live_test"'));
  assert.ok(byLabel.cURL.includes('Authorization: Bearer r3_live_test'));
  assert.ok(samples.every((sample) => sample.code.includes('m/x') && sample.code.includes('r3_live_test')));
});

test('proxy samples go through the local proxy and never carry a key', () => {
  assert.equal(gatewayBaseUrl('https://api.example.com/'), 'https://api.example.com/v1');
  const samples = proxySamples({ baseUrl: 'https://api.example.com/v1', model: 'm/x' });
  assert.deepEqual(samples.map((sample) => sample.label), ['Proxy', 'Python', 'Node.js', 'Claude Code', 'Codex', 'cURL']);
  const byLabel = Object.fromEntries(samples.map((sample) => [sample.label, sample.code]));
  assert.ok(byLabel.Proxy.includes('--gateway https://api.example.com') && byLabel.Proxy.includes('git clone https://github.com/scottham/router3'));
  assert.ok(byLabel['Claude Code'].includes('ANTHROPIC_BASE_URL="http://127.0.0.1:8402"\n'));
  assert.ok(samples.filter((s) => !['Claude Code', 'Proxy'].includes(s.label)).every((sample) => sample.code.includes('http://127.0.0.1:8402/v1')));
  assert.ok(byLabel.Codex.includes('wire_api = "responses"'));
  assert.ok(samples.every((sample) => sample.code.includes('m/x') || sample.label === 'Proxy'));
  assert.ok(samples.every((sample) => !/mcg_live|sk-/.test(sample.code)));
  const sdk = x402Samples({ baseUrl: 'https://api.example.com/v1', model: 'm/x' });
  assert.ok(sdk[0].code.includes('https://api.example.com/v1/chat/completions'));
});

// 2026-10-20: the brand kept the sidebar's uneven padding in the phone top bar
// and sat 3 px above the menu button.
test('the phone top bar centres the brand with the menu button', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8');
  const rule = css.match(/\.mobile-bar \.brand\s*\{([^}]*)\}/);
  assert.ok(rule, 'the mobile bar overrides the brand padding');
  const padding = rule[1].match(/padding:\s*([^;]+);/)[1].trim().split(/\s+/);
  const [top, , bottom = top] = padding.length === 1 ? [padding[0], padding[0], padding[0]] : padding;
  assert.equal(top, bottom, 'equal top and bottom padding');
  assert.match(css, /\.mobile-bar \{[^}]*align-items: center/);
});

test('the console language follows the browser: any zh tag reads Chinese, everything else English', async () => {
  const { detectLang } = await import('../web/src/i18n.js');
  assert.equal(detectLang(['zh-CN', 'en']), 'zh');
  assert.equal(detectLang(['zh-TW']), 'zh');
  assert.equal(detectLang(['en-US', 'zh-CN']), 'en');
  assert.equal(detectLang(['fr-FR', 'zh-CN']), 'zh');
  assert.equal(detectLang(['fr-FR', 'de']), 'en');
  assert.equal(detectLang([]), 'en');
});

test('every console string has a Chinese translation and the dictionary has no stale entries', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { default: zh } = await import('../web/src/locales/zh.js');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  // The dictionary itself is not a use of its keys.
  const source = (dir) => walk(dir).filter((f) => /\.(m?js|jsx)$/.test(f) && !f.includes('locales')).map((f) => readFileSync(f, 'utf8')).join('\n');
  const web = source('web/src'), api = source('src');
  const used = new Set();
  for (const [, quote, body] of web.matchAll(/(?<![\w$.])t\((['"])((?:\\.|(?!\1).)*)\1/g)) used.add(body.replace(/\\(.)/g, '$1'));
  const missing = [...used].filter((key) => !(key in zh));
  assert.deepEqual(missing, [], 'strings without a Chinese entry');
  // A key is in use when the console passes it to t() or the API sends it as a message.
  const stale = Object.keys(zh).filter((key) => !used.has(key) && !api.includes(key) && !web.includes(JSON.stringify(key).slice(1, -1)));
  assert.deepEqual(stale, [], 'dictionary entries nothing uses');
  for (const [key, value] of Object.entries(zh)) {
    const holes = (s) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join();
    assert.equal(holes(value), holes(key), `placeholders differ: ${key}`);
  }
});
