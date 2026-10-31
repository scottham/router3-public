import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('documentation and install metadata are included', () => {
  for (const path of ['README.md', 'package.json', '.env.example', 'docs/ARCHITECTURE.md', 'docs/CONFIGURATION_CHECKLIST.md']) {
    assert.equal(existsSync(path), true, `${path} must exist`);
  }
});
