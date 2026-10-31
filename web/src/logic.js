// Framework-free rules shared by the React views and the Node tests.
import { formatPricePerMillion } from './format.js';
import { t } from './i18n.js';

export const big = (value) => BigInt(value ?? 0);

// ------------------------------------------------------------------- models

export const cnyTiers = (capabilities = {}) => (capabilities.priceTiers?.length ?? 0) > 1;
// DeepSeek's peak hours are stored in UTC; shown in Beijing time.
export const peakHoursLabel = (hours = []) => hours.map(([from, to]) =>
  `${String((from + 8) % 24).padStart(2, '0')}:00–${String((to + 8) % 24).padStart(2, '0')}:00`).join('、');
export const price = (value) => (value == null ? '—' : formatPricePerMillion(value));
const priceNumber = (value) => (value == null ? Infinity : Number(BigInt(value)) / 1e9);

export const MODEL_SORTS = {
  name: { label: t('Name'), compare: (a, b) => a.public_name.localeCompare(b.public_name) },
  input: { label: t('Input price (low → high)'), compare: (a, b) => priceNumber(a.customer_input_usdc_nano_per_million) - priceNumber(b.customer_input_usdc_nano_per_million) },
  output: { label: t('Output price (low → high)'), compare: (a, b) => priceNumber(a.customer_output_usdc_nano_per_million) - priceNumber(b.customer_output_usdc_nano_per_million) },
  context: { label: t('Context (long → short)'), compare: (a, b) => (b.capabilities?.contextLength ?? 0) - (a.capabilities?.contextLength ?? 0) }
};

export function capabilityLabels(model) {
  const capabilities = model.capabilities ?? {};
  return [
    capabilities.tools ? [t('Tools'), 'neutral'] : null,
    capabilities.imageInput ? [t('Image input'), 'neutral'] : null,
    capabilities.reasoningIncludedInOutput === false ? [t('Reasoning priced separately'), 'warning'] : null,
    cnyTiers(capabilities) ? [t('Tiered'), 'neutral'] : null,
    capabilities.offPeakRates ? [t('Peak/off-peak'), 'neutral'] : null,
    big(model.customer_input_usdc_nano_per_million) === 0n && big(model.customer_output_usdc_nano_per_million) === 0n ? [t('Free'), 'success'] : null
  ].filter(Boolean);
}

export const PROVIDER_COLORS = {
  deepseek: '#4d6bfe', openrouter: '#6467f2', glm: '#3859ff', zai: '#3859ff', openai: '#0f0f0f', anthropic: '#c96442',
  google: '#1a73e8', gemini: '#1a73e8', mock: '#71717a', static: '#71717a'
};
const PROVIDER_LABELS = { deepseek: 'DeepSeek', openrouter: 'OpenRouter', glm: t('Zhipu GLM'), zai: 'Z.AI', openai: 'OpenAI',
  anthropic: 'Anthropic', google: 'Google', gemini: 'Google', mock: 'Mock' };
export const providerLabel = (provider) => PROVIDER_LABELS[provider] ?? provider;
