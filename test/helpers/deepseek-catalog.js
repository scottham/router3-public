import {loadDeepseekPrices,makeDeepseekCatalog} from '../../src/services/deepseek-catalog.js';

// Shape of GET https://api.deepseek.com/models on 2026-10-21.
export const DEEPSEEK_TEST_MODELS=[
  {id:'deepseek-flash',name:'DeepSeek-V4.1-Flash',context_window:1048576,max_output_tokens:393216,input_modalities:['text','image'],output_modalities:['text']},
  {id:'deepseek-v4-pro',name:'DeepSeek-V4-Pro',context_window:1048576,max_output_tokens:393216,input_modalities:['text'],output_modalities:['text']}];
// 8 CNY per USD keeps the arithmetic readable.
export const TEST_FX={cnyPerUsd:'8',date:'2026-10-21',source:'test',policy:'fixed'};

// Catalog entries priced from the reviewed copy (providers/deepseek-prices.json).
export function deepseekTestEntries(fx=TEST_FX,models=DEEPSEEK_TEST_MODELS) {
  return makeDeepseekCatalog(models,loadDeepseekPrices(),fx).entries;
}

// Entries with flat test rates (0.8 CNY input, 8 CNY output, no peak hours):
// 10000 input + 9000 output tokens cost exactly 0.01 USD, which the billing
// acceptance scenarios assert against.
export function scenarioEntries(fx=TEST_FX) {
  const band={input:'0.8',cachedInput:'0.16',output:'8'};
  // An output ceiling that holds about 0.115 USD without max_tokens: above the
  // scenarios' 0.01 USD request limit, below their 0.2 USD one.
  const models=DEEPSEEK_TEST_MODELS.map(m=>({...m,max_output_tokens:114688}));
  return makeDeepseekCatalog(models,{currency:'CNY',source:'https://example.com/test-prices',reviewedAt:'2026-10-06',timeOfUse:null,
    models:[{model:'deepseek-flash',peak:band,offPeak:band},{model:'deepseek-v4-pro',peak:band,offPeak:band}]},fx).entries;
}
