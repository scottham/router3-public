import { randomUUID } from 'node:crypto';

export class MockProvider {
  async invoke(request, model) {
    const text = request.messages.map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
    const output = `mock:${text}`;
    const inputTokens = Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
    const outputTokens = Math.max(1, Math.ceil(Buffer.byteLength(output, 'utf8') / 4));
    const id = `mock_${randomUUID()}`;
    return {
      providerRequestId: id,
      usage: { inputTokens, cachedInputTokens: 0, outputTokens, reasoningTokens: 0 },
      rawUsageRedacted: { input_tokens: inputTokens, output_tokens: outputTokens },
      body: {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model.public_name,
        choices: [{ index: 0, message: { role: 'assistant', content: output }, finish_reason: 'stop' }],
        usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
      }
    };
  }

  // Deterministic streaming transport: the same completion as `invoke`, split
  // into small deltas, then a usage-only chunk the way OpenAI emits it with
  // `stream_options.include_usage`. Lets SDK compatibility be verified without
  // a real vendor.
  async stream(request, model, signal) {
    const result = await this.invoke(request, model);
    const { id, created, choices: [choice], usage } = result.body;
    const base = { id, object: 'chat.completion.chunk', created, model: model.public_name };
    const parts = choice.message.content.match(/[\s\S]{1,8}/g) ?? [''];
    async function* chunks() {
      yield { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };
      for (const part of parts) {
        if (signal?.aborted) return;
        yield { ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] };
      }
      yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      yield { ...base, choices: [], usage };
    }
    return { chunks: chunks(), result: () => result };
  }
}
