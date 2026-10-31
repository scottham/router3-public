#!/usr/bin/env node
// End-to-end checks of /v1/messages (Anthropic) and /v1/responses against a
// running gateway, paid from a real wallet: by default with an API key
// created for the run, `--proxy` through the local x402 proxy.
//
//   node --env-file=.env scripts/verify-agent-protocols-e2e.mjs [--proxy] [--agents]
//
// PRIVATE_KEY is the payer. MCG_BASE_URL defaults to https://router3.ai.
// Alternatively, MCG_API_KEY_FILE supplies an existing key: no wallet setup,
// limit changes, withdrawal or key revocation is performed by this script.
// --agents also runs Claude Code (`claude`, or CLAUDE_BIN) and Codex
// (`codex`, or CODEX_BIN) on two coding tasks each, per model, in temporary
// directories with their own config; a task passes when the agent exits
// cleanly and `node --test` passes there. Every agent run starts at the same
// time, so their tool calls run concurrently on one key (or the proxy's
// channel pool) the way a team of agents would. The agents run commands on this host with
// permissions bypassed, inside their temporary directory. About 1 USDC and
// 15 minutes.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPayment } from './lib/e2e-payment.mjs';

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey&&!process.env.MCG_API_KEY_FILE) { console.error('PRIVATE_KEY or MCG_API_KEY_FILE is required'); process.exit(2); }
const gatewayUrl = (process.env.MCG_BASE_URL ?? 'https://router3.ai').replace(/\/(v1)?$/, '');
const payment = await openPayment({ gatewayUrl, privateKey, maxChannels: 32 });
const base = payment.base;
console.log(`${payment.mode}: ${payment.describe}, payer ${payment.payer}`);
// Per agent: the model it codes with, per provider. OpenRouter models are
// cheap ones so the run stays around a dollar.
const MODELS = { claude: [process.env.MCG_DS_MODEL ?? 'deepseek/deepseek-v4-pro', process.env.MCG_OR_CLAUDE_MODEL ?? 'openrouter/moonshotai/kimi-k3'],
  codex: [process.env.MCG_DS_MODEL ?? 'deepseek/deepseek-v4-pro', process.env.MCG_OR_CODEX_MODEL ?? 'openrouter/z-ai/glm-5.3'] };
const FAST = { deepseek: process.env.MCG_DS_FAST_MODEL ?? 'deepseek/deepseek-flash', openrouter: process.env.MCG_OR_FAST_MODEL ?? 'openrouter/z-ai/glm-5.3' };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const headers = { anthropic: { 'x-api-key': payment.token, 'anthropic-version': '2023-06-01' }, responses: { authorization: `Bearer ${payment.token}` } };
const path = { anthropic: '/v1/messages', responses: '/v1/responses' };
const tool = {
  anthropic: { name: 'get_time', description: 'Current time in a timezone', input_schema: { type: 'object', properties: { tz: { type: 'string' } }, required: ['tz'] } },
  responses: { type: 'function', name: 'get_time', description: 'Current time in a timezone', parameters: { type: 'object', properties: { tz: { type: 'string' } }, required: ['tz'] } }
};
const body = (protocol, model, stream) => protocol === 'anthropic'
  ? { model, max_tokens: 2000, stream, tools: [tool.anthropic], messages: [{ role: 'user', content: 'What time is it in UTC? Use the tool.' }] }
  : { model, max_output_tokens: 2000, stream, tools: [tool.responses], input: 'What time is it in UTC? Use the tool.' };
const post = (protocol, payload) => fetch(base + path[protocol], { method: 'POST', headers: { 'content-type': 'application/json', ...headers[protocol] }, body: JSON.stringify(payload) });
const sseData = (text) => text.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data:'))).filter(Boolean).map((l) => JSON.parse(l.slice(5)));

try {
  // A tool call in both formats, for every provider, streamed and not, all at
  // once: the closing event carries the settled charge, the model is the
  // public name, and every call paid from its own channel.
  const cases = Object.values(FAST).flatMap((model) => ['anthropic', 'responses'].flatMap((protocol) => [false, true].map((stream) => ({ model, protocol, stream }))));
  const outcomes = await Promise.all(cases.map(async ({ model, protocol, stream }) => {
    const name = `${protocol} ${model} ${stream ? 'stream' : 'sync'}`;
    try {
      const response = await post(protocol, body(protocol, model, stream));
      const text = await response.text();
      if (response.status !== 200) return [name, false, `${response.status} ${text.slice(0, 200)}`];
      if (!stream) {
        const json = JSON.parse(text);
        const items = json.content ?? json.output;
        const called = items.some((i) => i.type === 'tool_use' || i.type === 'function_call');
        return [name, called && json.model === model && payment.charged(json.gateway) != null, `charged ${payment.charged(json.gateway)}`];
      }
      const events = sseData(text);
      const last = protocol === 'anthropic' ? events.at(-2) : events.at(-1);
      const gateway = last?.gateway ?? last?.response?.gateway;
      const closing = protocol === 'anthropic' ? events.at(-1)?.type === 'message_stop' : last?.type === 'response.completed';
      return [name, closing && payment.charged(gateway) != null && !events.some((e) => e.type === 'error'), `charged ${payment.charged(gateway)}`];
    } catch (error) { return [name, false, error.message]; }
  }));
  for (const outcome of outcomes) check(...outcome);
  if (payment.proxy) check(`${cases.length} concurrent protocol calls used ${payment.proxy.pool.size} channels`, payment.proxy.pool.size >= Math.min(cases.length, payment.proxy.pool.maxChannels));
  else { const view = await payment.view(); check(`${cases.length} concurrent protocol calls on one key`, view.running === 0 && BigInt(view.chargedAtomic) > 0n, `charged ${view.chargedAtomic}`); }

  // Refused before any payment: server-side tools and stored Responses state.
  for (const [name, protocol, payload, code] of [
    ['anthropic server tool refused', 'anthropic', { model: FAST.deepseek, max_tokens: 50, tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages: [{ role: 'user', content: 'hi' }] }, 'SERVER_TOOLS_NOT_SUPPORTED'],
    ['responses web_search refused', 'responses', { model: FAST.deepseek, tools: [{ type: 'web_search' }], input: 'hi' }, 'SERVER_TOOLS_NOT_SUPPORTED'],
    ['responses store refused', 'responses', { model: FAST.deepseek, store: true, input: 'hi' }, 'RESPONSES_STORE_NOT_SUPPORTED'],
    ['responses previous_response_id refused', 'responses', { model: FAST.deepseek, previous_response_id: 'resp_x', input: 'hi' }, 'RESPONSES_STATE_NOT_SUPPORTED']
  ]) {
    const response = await post(protocol, payload);
    const json = await response.json();
    check(name, response.status === 422 && (json.error?.code === code), `${response.status} ${json.error?.code}`);
  }

  const TASKS = {
    expr: { seed: null, prompt: `In the current directory, implement an ES module expr.js exporting evaluate(source, vars={}) for arithmetic expressions: numbers (incl. decimals and 1e3), + - * / % and ^ (right-associative, higher than unary minus so -2^2 = -4), parentheses, unary minus/plus, variables from vars, functions min, max, sqrt, abs. Throw SyntaxError with the 0-based position for malformed input ('2 +', '(1', '1 2'), ReferenceError for unknown variables, RangeError for division by zero and sqrt of negatives. Add package.json with type module and expr.test.js using node:test covering precedence, associativity, every error type and edge cases. Run node --test and fix until all tests pass.` },
    ledger: { seed: new URL('./fixtures/agent-ledger/', import.meta.url), prompt: `The tests in this repo fail. Find and fix every bug in ledger.js without editing the existing tests in ledger.test.js. Then add statement(account) returning entries touching the account in chronological order as {id, memo, delta, balance} (signed delta, running balance) and statementCsv(account) with a header row and RFC 4180 quoting; add tests for both, including a memo with a comma and a quote. Run node --test until everything passes.` }
  };

  function which(bin) { try { return execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim(); } catch { return null; } }
  const run = (command, args, options) => new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 1500000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ status: -1, stdout, stderr: String(error) }); });
  });

  async function runAgent(agent, model, task) {
    const dir = mkdtempSync(join(tmpdir(), `router3-${agent}-`));
    const work = join(dir, 'work'), home = join(dir, 'home');
    mkdirSync(home);
    if (TASKS[task].seed) cpSync(TASKS[task].seed, work, { recursive: true }); else mkdirSync(work);
    execFileSync('git', ['init', '-q'], { cwd: work });
    const fast = FAST[model.split('/')[0]];
    let result;
    if (agent === 'claude') {
      result = await run(process.env.CLAUDE_BIN ?? 'claude', ['-p', TASKS[task].prompt, '--permission-mode', 'bypassPermissions', '--output-format', 'json'], {
        cwd: work, timeout: 1500000,
        env: { ...process.env, CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: payment.token, ANTHROPIC_API_KEY: '',
          ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: fast,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }
      });
    } else {
      // Web search is a server-side tool the gateway refuses; Codex sends it unless disabled.
      writeFileSync(join(home, 'config.toml'), `web_search = "disabled"\nmodel = "${model}"\nmodel_provider = "router3"\n\n[model_providers.router3]\nname = "Router 3"\nbase_url = "${base}/v1"\nenv_key = "ROUTER3_PROXY_TOKEN"\nwire_api = "responses"\n`);
      result = await run(process.env.CODEX_BIN ?? 'codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '--json', TASKS[task].prompt], {
        cwd: work, timeout: 1500000, env: { ...process.env, CODEX_HOME: home, ROUTER3_PROXY_TOKEN: payment.token }
      });
    }
    const tests = await run(process.execPath, ['--test'], { cwd: work, timeout: 120000 });
    const summary = (tests.stdout.match(/# (pass|fail) \d+/g) ?? []).join(' ');
    const failed = agent === 'codex' && /"turn\.failed"/.test(result.stdout ?? '');
    const ok = result.status === 0 && !failed && tests.status === 0 && /# pass [1-9]/.test(tests.stdout);
    if(ok)rmSync(dir,{recursive:true,force:true});
    else {
      writeFileSync(join(dir,'agent.stdout.log'),result.stdout,{mode:0o600});
      writeFileSync(join(dir,'agent.stderr.log'),result.stderr,{mode:0o600});
      writeFileSync(join(dir,'tests.log'),tests.stdout+tests.stderr,{mode:0o600});
    }
    return [`${agent} ${model} ${task}`, ok, `agent exit ${result.status}, ${summary}${ok ? '' : `, kept ${dir}`}`];
  }

  if (process.argv.includes('--agents')) {
    const runs = [];
    for (const agent of ['claude', 'codex']) {
      if (!which(agent === 'claude' ? process.env.CLAUDE_BIN ?? 'claude' : process.env.CODEX_BIN ?? 'codex')) { check(`${agent} installed`, false, 'not found on PATH'); continue; }
      for (const model of MODELS[agent]) for (const task of Object.keys(TASKS)) runs.push(runAgent(agent, model, task));
    }
    const before = await payment.view();
    console.log(`running ${runs.length} coding agents in parallel`);
    for (const outcome of await Promise.all(runs)) check(...outcome);
    const after = await payment.view();
    if (runs.length) check(`${runs.length} parallel agents ${payment.proxy ? 'shared the channel pool' : 'on one key'}`,
      payment.proxy ? after.channels >= before.channels : BigInt(after.chargedAtomic) > BigInt(before.chargedAtomic), JSON.stringify(payment.proxy ? after : { charged: after.chargedAtomic, unspent: after.unspentAtomic }));
  }
} finally {
  console.log(`closed: ${JSON.stringify(await payment.close())}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed (${payment.mode})`);
process.exit(failed.length ? 1 : 0);
