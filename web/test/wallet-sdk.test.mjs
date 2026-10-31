import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const cdpRoot = resolve(dirname(require.resolve('@coinbase/cdp-sdk')), '..');
const reownRoot = resolve(dirname(require.resolve('@reown/appkit-wallet')), '..');
const esm = await import(pathToFileURL(resolve(cdpRoot, '_esm/policies/evmSchema.js')));
const cjs = require(resolve(cdpRoot, '_cjs/policies/evmSchema.js'));
const policy = await import(pathToFileURL(resolve(cdpRoot, '_esm/policies/types.js')));
const frame = await import(pathToFileURL(resolve(reownRoot, 'src/W3mFrameSchema.js')));
const abi = await import('abitype/zod');
const address = `0x${'ab'.repeat(20)}`;

test('every wallet SDK consumer resolves the patched Zod 4 implementation', () => {
  for (const name of ['@coinbase/cdp-sdk', '@reown/appkit-wallet', 'abitype']) {
    const consumer = createRequire(require.resolve(name));
    assert.equal(consumer('zod/package.json').version, '4.6.7', name);
    assert.equal(typeof consumer('zod').z.core, 'object', name);
  }
});

for (const [format, sdk] of [['ESM', esm], ['CJS', cjs]]) {
  test(`CDP ${format}: EIP-712 type maps retain validation after migration`, () => {
    const value = { type: 'evmTypedDataField', types: {
      types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'value', type: 'uint256' }] }, primaryType: 'Permit'
    }, conditions: [{ path: 'owner', operator: 'in', addresses: [address] }] };
    assert.deepEqual(sdk.SignEvmTypedDataFieldCriterionSchema.parse(value), value);
    for (const bad of [null, 'not a type map', { Permit: 'not fields' }, { Permit: [{ name: 123, type: 'address' }] }]) {
      const result = sdk.SignEvmTypedDataFieldCriterionSchema.safeParse({ ...value, types: { ...value.types, types: bad } });
      assert.equal(result.success, false);
      assert.ok(result.error.issues.length);
    }
    assert.equal(sdk.SignEvmTypedDataFieldCriterionSchema.safeParse({ ...value, conditions: [] }).success, false);
  });
}

test('CDP rejects oversized policy collections before reading their elements', () => {
  const rules = Array(policy.MAX_POLICY_RULES + 1).fill(null);
  Object.defineProperty(rules, 0, { get() { throw new Error('Oversized collection was traversed'); } });
  const result = policy.CreatePolicyBodySchema.safeParse({ scope: 'account', rules });
  assert.equal(result.success, false);
  assert.deepEqual(result.error.issues.map(({ code, path }) => ({ code, path })), [{ code: 'too_big', path: ['rules'] }]);
});

test('Reown accepts wallet connection, theme and SIWX payloads and rejects invalid fields', () => {
  assert.equal(frame.FrameGetUserResponse.safeParse({ address, chainId: 'eip155:143', accounts: [{ address, type: 'eoa' }] }).success, true);
  assert.equal(frame.FrameGetUserResponse.safeParse({ address, chainId: {} }).success, false);
  const theme = { themeMode: 'dark', themeVariables: { '--w3m-accent': '#836ef9', '--w3m-z-index': 100 }, w3mThemeVariables: { color: 'blue' } };
  assert.deepEqual(frame.AppSyncThemeRequest.parse(theme), theme);
  assert.equal(frame.AppSyncThemeRequest.safeParse({ ...theme, themeVariables: { color: {} } }).success, false);
  assert.equal(frame.SIWXMessage.safeParse({ accountAddress: address, chainId: 'eip155:143', domain: 'router3.ai', uri: 'https://router3.ai', version: '1', nonce: '12345678', resources: ['https://router3.ai'] }).success, true);
});

test('Reown accepts signing and transaction RPC envelopes with Zod 4', () => {
  for (const [method, schema] of [['personal_sign', frame.RpcPersonalSignRequest], ['eth_signTypedData_v4', frame.RpcEthSignTypedDataV4], ['eth_sendTransaction', frame.RpcEthSendTransactionRequest]]) {
    const payload = { method, params: ['0x1234', address] };
    assert.deepEqual(schema.parse(payload), payload);
    assert.equal(schema.safeParse({ ...payload, params: 'invalid' }).success, false);
    assert.equal(frame.W3mFrameSchema.appEvent.safeParse({ type: '@w3m-app/RPC_REQUEST', payload }).success, true);
  }
});

test('ABI and typed-data schemas still accept valid Ethereum types and reject bad addresses', () => {
  const value = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: 'balance', type: 'uint256' }] }];
  assert.deepEqual(abi.Abi.parse(value), value);
  assert.equal(abi.Address.safeParse(address).success, true);
  assert.equal(abi.Address.safeParse('0xnot-an-address').success, false);
  const typed = { Permit: [{ name: 'owner', type: 'address' }, { name: 'value', type: 'uint256' }] };
  assert.deepEqual(abi.TypedData.parse(typed), typed);
});
