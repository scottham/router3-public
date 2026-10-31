// CDP 1.59.0's single-argument record is a Zod 3 API. Preserve its string
// keys explicitly when using patched Zod 4. Run after installation and before
// dev/build, including Docker's --ignore-scripts installation. Fail closed if
// upstream changes: review the override, patch and SDK tests together.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(dirname(require.resolve('@coinbase/cdp-sdk')), '..');
assert.equal(JSON.parse(readFileSync(resolve(root, 'package.json'))).version, '1.59.0', 'Review the CDP Zod compatibility patch before upgrading');
for (const [file, z] of [['_esm/policies/evmSchema.js', 'z'], ['_cjs/policies/evmSchema.js', 'zod_2.z']]) {
  const path = resolve(root, file);
  const text = readFileSync(path, 'utf8');
  const before = `types: ${z}.record(${z}.array(${z}.object({`;
  const after = `types: ${z}.record(${z}.string(), ${z}.array(${z}.object({`;
  const oldCount = text.split(before).length - 1;
  const newCount = text.split(after).length - 1;
  assert.ok((oldCount === 1 && newCount === 0) || (oldCount === 0 && newCount === 1), `Unexpected CDP schema in ${file}; review Zod compatibility`);
  if (oldCount) writeFileSync(path, text.replace(before, after));
}
console.log('CDP 1.59.0 ESM/CJS schemas prepared for Zod 4');
