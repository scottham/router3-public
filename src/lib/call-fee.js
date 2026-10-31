// Monetary values are integer nano-USDC. Round the fee once per call, never
// by marking up each token rate. A zero-cost call has no service fee.
export function callFee(modelCostNano, basisPoints) {
  const base=BigInt(modelCostNano);
  if(base<0n || !Number.isInteger(basisPoints) || basisPoints<0 || basisPoints>10000)throw new Error('INVALID_CALL_FEE');
  const serviceFeeUsdcNano=(base*BigInt(basisPoints)+9999n)/10000n;
  return {modelCostUsdcNano:base,serviceFeeUsdcNano,customerChargeUsdcNano:base+serviceFeeUsdcNano};
}
