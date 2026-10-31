import { callFee } from '../lib/call-fee.js';
import { canonicalize } from '../lib/crypto.js';
import { applyBasisPoints, tokenCostNano } from '../lib/money.js';
import { AppError } from '../lib/errors.js';
import { estimateTierMaximum, calculateTierActual, heldOutput } from './tier-pricing.js';

function bigint(value) {
  return BigInt(value ?? 0);
}

// `bytesPerToken` sizes the input estimate. The default (1) is a hard upper
// bound: no tokenizer emits more tokens than UTF-8 bytes. Holds that are only
// estimates (API keys: the actual cost is charged even above the hold) use a
// realistic ratio instead, and `holdOutputTokens` caps how much of the output
// limit is held (the limit itself is still forwarded to the provider).
export const REALISTIC_BYTES_PER_TOKEN = 3;

export class PricingService {
  estimateMaximum(request, price, options = {}) {
    const estimate=this.estimateModelMaximum(request,price,options);
    return price.call_fee_policy_id ? {...estimate,maxChargeUsdcNano:callFee(estimate.maxChargeUsdcNano,price.service_fee_bps).customerChargeUsdcNano} : estimate;
  }

  estimateModelMaximum(request, price, { bytesPerToken = 1, holdOutputTokens = null, cacheWriteTtl = null } = {}) {
    if(price.bailian_quote)return estimateTierMaximum(request,price.bailian_quote,price.capabilities,{bytesPerToken,holdOutputTokens,cacheWriteTtl});
    const maxOutputTokens = BigInt(request.max_completion_tokens ?? request.max_tokens ?? price.capabilities?.maxOutputTokens ?? 1024);
    if (maxOutputTokens <= 0n) throw new AppError('MAX_TOKENS_REQUIRED', 'A positive max_tokens or max_completion_tokens is required', 422);

    // Conservative upper bound: modern tokenizers cannot emit more tokens than the
    // UTF-8 byte representation plus fixed protocol overhead. Over-reservation is
    // released after actual usage is known; under-reservation is never billed to user.
    const inputBytes = BigInt(Buffer.byteLength(canonicalize({
      messages: request.messages,
      tools: request.tools ?? null,
      response_format: request.response_format ?? null
    }), 'utf8'));
    const maxInputTokens = (inputBytes + BigInt(bytesPerToken) - 1n) / BigInt(bytesPerToken) + 1024n;

    if(price.capabilities?.contextLength && maxInputTokens+maxOutputTokens>BigInt(price.capabilities.contextLength)) {
      throw new AppError('CONTEXT_LIMIT_EXCEEDED', 'Request exceeds the selected model route context bound', 422);
    }

    const quote = price.provider_quote;
    if (quote && maxInputTokens + maxOutputTokens > BigInt(quote.context_length)) {
      throw new AppError('CONTEXT_LIMIT_EXCEEDED', 'Request exceeds the selected model route context bound', 422);
    }
    const inputRate = quote ? applyBasisPoints(BigInt(quote.max_input_usd_nano_per_million), quote.markup_bps)
      : bigint(price.customer_input_usdc_nano_per_million);
    const input = tokenCostNano(maxInputTokens, inputRate);
    const held = heldOutput(maxOutputTokens, holdOutputTokens);
    const output = tokenCostNano(held, bigint(price.customer_output_usdc_nano_per_million));
    const reasoning = price.capabilities?.reasoningIncludedInOutput === false
      ? tokenCostNano(held, bigint(price.customer_reasoning_usdc_nano_per_million))
      : 0n;
    const total = input + output + reasoning + (quote ? applyBasisPoints(BigInt(quote.request_cost_usd_nano),quote.markup_bps) : 0n);
    return { maxChargeUsdcNano: total > 0n ? total : 1n, maxInputTokens, maxOutputTokens };
  }

  // `reportedCostUsdNano` is the cost the provider itself reported for the
  // call; quotes with billing='reported' (OpenRouter) settle on it and use
  // their rates only for the hold.
  calculateActual(usage, price, reportedCostUsdNano=null) {
    const cost=this.calculateModelActual(usage,price,reportedCostUsdNano);
    return price.call_fee_policy_id ? {...cost,...callFee(cost.providerCostUsdNano,price.service_fee_bps)} : cost;
  }

  calculateModelActual(usage, price, reportedCostUsdNano=null) {
    if(price.bailian_quote?.billing==='reported'&&reportedCostUsdNano!=null) {
      const providerCostUsdNano=BigInt(reportedCostUsdNano);
      return {providerCostUsdNano,customerChargeUsdcNano:applyBasisPoints(providerCostUsdNano,price.bailian_quote.markupBps??0)};
    }
    if(price.bailian_quote)return calculateTierActual(usage,price.bailian_quote,price.started_at?new Date(price.started_at):null);
    const inputTokens = bigint(usage.inputTokens);
    const cachedTokens = bigint(usage.cachedInputTokens);
    const outputTokens = bigint(usage.outputTokens);
    const reasoningTokens = bigint(usage.reasoningTokens);
    const nonCachedInput = inputTokens > cachedTokens ? inputTokens - cachedTokens : 0n;
    const reasoningIncluded = price.capabilities?.reasoningIncludedInOutput !== false;

    const customerChargeUsdcNano =
      tokenCostNano(nonCachedInput, bigint(price.customer_input_usdc_nano_per_million)) +
      tokenCostNano(cachedTokens, bigint(price.customer_cached_input_usdc_nano_per_million)) +
      tokenCostNano(outputTokens, bigint(price.customer_output_usdc_nano_per_million)) +
      (reasoningIncluded ? 0n : tokenCostNano(reasoningTokens, bigint(price.customer_reasoning_usdc_nano_per_million)));

    const providerCostUsdNano =
      tokenCostNano(nonCachedInput, bigint(price.provider_input_usd_nano_per_million)) +
      tokenCostNano(cachedTokens, bigint(price.provider_cached_input_usd_nano_per_million)) +
      tokenCostNano(outputTokens, bigint(price.provider_output_usd_nano_per_million)) +
      (reasoningIncluded ? 0n : tokenCostNano(reasoningTokens, bigint(price.provider_reasoning_usd_nano_per_million)));

    return { customerChargeUsdcNano, providerCostUsdNano };
  }
}
