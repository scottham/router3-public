// Customer requests are validated with a passthrough schema so unknown OpenAI
// fields do not break integrations, but only these fields may reach an upstream
// provider. Two classes of field are deliberately excluded:
//
//   * control-plane fields (api_key, api_base, mock_response, fallbacks,
//     num_retries) would let a customer re-point the call or hide the attempt
//     that Router3 bills for;
//   * fan-out fields (n, best_of) multiply the real completion cost while the
//     reservation only covers a single completion of max_tokens.
import {CACHE_FIELDS} from './prompt-cache.js';

export const ALLOWED_UPSTREAM_FIELDS = Object.freeze([
  'messages', 'max_tokens', 'max_completion_tokens', 'temperature', 'tools',
  'tool_choice', 'response_format', 'user', 'top_p', 'frequency_penalty',
  'presence_penalty', 'stop', 'seed', 'parallel_tool_calls', 'logprobs',
  'top_logprobs', 'thinking', 'reasoning_effort', 'enable_thinking', 'thinking_budget', ...CACHE_FIELDS
]);

export function upstreamRequestBody(request, upstreamModel, extra = {}) {
  const body = {};
  // Omit unset generation controls so each model uses its provider defaults.
  // Do not fill in temperature, top_p, thinking or reasoning_effort here.
  for (const field of ALLOWED_UPSTREAM_FIELDS) {
    if (request[field] !== undefined) body[field] = request[field];
  }
  return { ...body, ...extra, model: upstreamModel, stream: false };
}
