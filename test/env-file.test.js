import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnv, upsertEnv } from '../scripts/lib/env-file.mjs';

test('environment updates preserve wallet keys, provider aliases and comments', () => {
  const original = [
    '# user-managed secrets',
    'PRIVATE_KEY = 0xprivate-test-value',
    'deepseek_api_key=deepseek-test-value',
    'export glm_api_key = glm-test-value',
    '',
    'REAL_MODEL_CALLS_ENABLED=false',
    ''
  ].join('\n');

  const updated = upsertEnv(original, new Map([
    ['REAL_MODEL_CALLS_ENABLED', 'true'],
    ['PROVIDER_CONFIG_PATH', 'providers/providers.json']
  ]));

  assert.match(updated, /# user-managed secrets/);
  assert.match(updated, /PRIVATE_KEY = 0xprivate-test-value/);
  assert.match(updated, /deepseek_api_key=deepseek-test-value/);
  assert.match(updated, /export glm_api_key = glm-test-value/);
  assert.match(updated, /REAL_MODEL_CALLS_ENABLED=true/);
  assert.equal(parseEnv(updated).get('PRIVATE_KEY'), '0xprivate-test-value');
  assert.equal(parseEnv(updated).get('glm_api_key'), 'glm-test-value');
});
