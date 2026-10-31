export function normalizeHexPrivateKey(value, label = 'Configured private key') {
  const candidate = value?.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(candidate ?? '')) return candidate;
  if (/^[0-9a-fA-F]{64}$/.test(candidate ?? '')) return `0x${candidate}`;
  throw new Error(`${label} must be 32-byte hexadecimal data`);
}

export function normalizeTestnetPrivateKey(value) {
  return normalizeHexPrivateKey(value, 'Configured testnet operator private key');
}
