import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { after, mock, test } from 'node:test';

// Exercise the router's request handler without network access or real credentials.
// Captures sit beside the env file, as Windows requires for an inherited private ACL.
const routerHome = mkdtempSync(join(tmpdir(), 'codex-router-home-'));
const rejectedRequestDir = join(routerHome, 'rejections');
mkdirSync(rejectedRequestDir);
process.env.CODEX_ROUTER_ENV_FILE = join(routerHome, 'openrouter.env');
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
process.env.CODEX_ROUTER_REJECTED_REQUEST_DIR = rejectedRequestDir;
process.env.CODEX_ROUTER_STRUCTURED_MODEL = 'gpt-6-astra';
process.env.CODEX_ROUTER_TOKEN = 'a'.repeat(64);
process.env.CODEX_ROUTER_PORT = '18766';
process.env.CODEX_ROUTER_LOG_LEVEL = 'info';
process.env.CODEX_ROUTER_PROVIDER_ORDER = 'vendor/pinned = google-vertex/us, google-ai-studio; vendor/other=other-endpoint';
const clientHeaders = {
  host: '127.0.0.1:18766',
  'content-type': 'application/json',
  'x-codex-router-token': process.env.CODEX_ROUTER_TOKEN,
  authorization: 'Bearer test-codex-token',
  'chatgpt-account-id': 'test-account',
};
let handleRequest;
const forwarded = [];
const logEntries = [];
mock.method(console, 'log', line => logEntries.push(String(line)));
mock.method(console, 'error', line => logEntries.push(String(line)));
mock.method(http, 'createServer', handler => {
  handleRequest = handler;
  return { listen: (_port, _host, ready) => ready() };
});
mock.method(https, 'request', (options, onResponse) => {
  const chunks = [];
  return new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
    final(callback) {
      const rawBody = Buffer.concat(chunks);
      const body = JSON.parse(rawBody.toString('utf8'));
      forwarded.push({ ...options, body, byteLength: rawBody.length });
      // Reproduce the Codex backend's rejection of plaintext reasoning input.
      const invalidIndex = options.hostname === 'chatgpt.com' && Array.isArray(body.input)
        ? body.input.findIndex(item => item?.type === 'reasoning' && item.content?.length > 0)
        : -1;
      const payload = invalidIndex >= 0
        ? { error: { code: 'array_above_max_length', param: `input[${invalidIndex}].content` } }
        : { id: 'resp_test', output: [] };
      const response = Readable.from([JSON.stringify(payload)]);
      response.statusCode = invalidIndex >= 0 ? 400 : 200;
      response.headers = {
        'content-type': 'application/json',
        'x-generation-id': 'gen_test',
        'x-provider-name': 'TestProvider',
        'x-request-id': 'req_test',
        'cf-ray': 'cf_test',
      };
      queueMicrotask(() => onResponse(response));
      callback();
    },
  });
});
await import('../router/unified-router.mjs');
after(() => {
  mock.restoreAll();
  rmSync(routerHome, { recursive: true, force: true });
});

async function exchangeRaw(rawBody, headers = {}, { method = 'POST', url = '/v1/responses' } = {}) {
  const request = new PassThrough();
  Object.assign(request, {
    method,
    url,
    headers: {
      ...clientHeaders,
      'content-length': '1',
      ...headers,
    },
  });
  const response = new PassThrough();
  response.headersSent = false;
  response.responseHeaders = {};
  response.writeHead = (status, responseHeaders = {}) => {
    response.statusCode = status;
    response.responseHeaders = responseHeaders;
    response.headersSent = true;
  };
  const chunks = [];
  response.on('data', chunk => chunks.push(chunk));
  const done = once(response, 'end');
  handleRequest(request, response);
  request.end(rawBody);
  await done;
  return {
    status: response.statusCode,
    headers: response.responseHeaders,
    rawBody: Buffer.concat(chunks).toString('utf8'),
  };
}

async function exchange(rawBody, headers = {}, options) {
  const result = await exchangeRaw(rawBody, headers, options);
  return { ...result, body: JSON.parse(result.rawBody) };
}

async function send(body, headers) {
  const result = await exchange(JSON.stringify(body), headers);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const upstream = forwarded.at(-1);
  assert.equal(Number(upstream.headers['content-length']), upstream.byteLength);
  return upstream;
}

function parsedLogEntries() {
  return logEntries.flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function parseSse(rawBody) {
  return rawBody.split(/\r?\n/)
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice('data: '.length)));
}

function mockUpstreamSequence(t, responses) {
  let index = 0;
  t.mock.method(https, 'request', (options, onResponse) => {
    const chunks = [];
    return new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
      final(callback) {
        const rawBody = Buffer.concat(chunks);
        const body = JSON.parse(rawBody.toString('utf8'));
        forwarded.push({ ...options, body, byteLength: rawBody.length });
        const spec = responses[index];
        index += 1;
        if (!spec) {
          callback(new Error(`Unexpected upstream request ${index}`));
          return;
        }
        const response = Readable.from([spec.body]);
        response.statusCode = spec.status;
        response.headers = {
          'content-type': spec.contentType || 'application/json',
          'x-generation-id': spec.generationId || `gen_reject_${index}`,
          'x-provider-name': '',
          'x-request-id': `req_${index}`,
          'cf-ray': `cf_${index}`,
          ...spec.headers,
        };
        queueMicrotask(() => onResponse(response));
        callback();
      },
    });
  });
}

const nativeReasoning = {
  type: 'reasoning',
  id: 'rs_native',
  summary: [{ type: 'summary_text', text: 'A native reasoning summary.' }],
  encrypted_content: 'test-native-ciphertext',
};
const deepseekReasoning = {
  type: 'reasoning',
  id: 'rs_tmp_example',
  summary: [],
  content: [{ type: 'reasoning_text', text: 'Synthetic provider reasoning.' }],
  encrypted_content: null,
};
const mixedHistory = [
  { role: 'user', content: 'howdy' },
  nativeReasoning,
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Howdy!' }] },
  { role: 'user', content: 'all good?' },
  deepseekReasoning,
  { type: 'message', id: 'msg_tmp_example', role: 'assistant', content: [{ type: 'output_text', text: 'All good.' }] },
  { role: 'user', content: 'not bad ha? this project?' },
];
const recoveryHistory = [
  {
    type: 'message',
    id: 'msg_current_developer',
    role: 'developer',
    content: [{ type: 'input_text', text: 'Current development instructions.' }],
  },
  ...Array.from({ length: 100 }, (_, index) => ({
    type: 'message',
    id: `msg_old_${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: index % 2 === 0 ? 'input_text' : 'output_text', text: `Old turn ${index}` }],
  })),
  {
    type: 'message',
    id: 'msg_current_user',
    role: 'user',
    content: [{ type: 'input_text', text: 'Continue the current task.' }],
  },
  {
    type: 'function_call',
    id: 'fc_current',
    call_id: 'call_current',
    name: 'exec_command',
    arguments: '{"cmd":"printf current"}',
  },
  {
    type: 'function_call_output',
    id: 'fco_current',
    call_id: 'call_current',
    output: 'current',
  },
];

test('OpenAI can continue mixed history after a DeepSeek turn', async () => {
  const upstream = await send({ model: 'gpt-6-astra', input: mixedHistory, reasoning: { effort: 'max' } });
  assert.equal(upstream.hostname, 'chatgpt.com');
  assert.equal(upstream.path, '/backend-api/codex/responses');
  assert.deepEqual(upstream.body.input, mixedHistory.filter(item => item !== deepseekReasoning));
  assert.deepEqual(upstream.body.reasoning, { effort: 'max' });
  assert.equal(upstream.headers.authorization, 'Bearer test-codex-token');
  assert.equal(upstream.headers['chatgpt-account-id'], 'test-account');
});

test('structured-output fallback also normalizes DeepSeek history for OpenAI', async () => {
  const format = { type: 'json_schema', name: 'result', schema: { type: 'object' } };
  const upstream = await send({ model: 'deepseek/deepseek-v4.1-flash-1017', input: mixedHistory, text: { format } });
  assert.equal(upstream.hostname, 'chatgpt.com');
  assert.equal(upstream.body.model, 'gpt-6-astra');
  assert.deepEqual(upstream.body.input, mixedHistory.filter(item => item !== deepseekReasoning));
  assert.deepEqual(upstream.body.text.format, format);
  const forwardedLog = parsedLogEntries().filter(entry => entry.event === 'request.forwarded').at(-1);
  assert.equal(forwardedLog.fallbackReason, 'openrouter_structured_output_unsupported');
});

test('preserve-model policy refuses structured-output substitution without contacting an upstream', async () => {
  const count = forwarded.length;
  for (const model of ['deepseek/deepseek-v4.1-flash-1017', 'openrouter/vendor/model']) {
    for (const type of ['json_schema', 'json_object']) {
      const result = await exchange(JSON.stringify({ model, text: { format: { type } } }),
        { 'x-codex-routing-policy': 'preserve-model-v1' });
      assert.equal(result.status, 422);
      assert.equal(result.body.error.code, 'model_substitution_forbidden');
    }
  }
  assert.equal(forwarded.length, count);
});

test('preserve-model text requests keep OpenRouter model selection without requiring OpenAI login', async () => {
  for (const model of ['deepseek/deepseek-v4.1-flash-1017', 'openrouter/vendor/model']) {
    const upstream = await send({ model, input: 'Synthetic request', text: { format: { type: 'text' } } }, {
      'x-codex-routing-policy': 'preserve-model-v1', authorization: undefined,
    });
    assert.equal(upstream.body.model, model.replace(/^openrouter\//, ''));
    assert.equal(upstream.hostname, 'openrouter.ai');
    assert.equal(upstream.headers['x-codex-routing-policy'], undefined);
    assert.equal(upstream.headers['chatgpt-account-id'], undefined);
  }
});

test('preserve-model policy leaves native structured output on the requested native model', async () => {
  const format = { type: 'json_schema', name: 'result', schema: { type: 'object' } };
  const upstream = await send({ model: 'gpt-6-astra', input: 'Synthetic request', text: { format } },
    { 'x-codex-routing-policy': 'preserve-model-v1' });
  assert.equal(upstream.hostname, 'chatgpt.com');
  assert.equal(upstream.body.model, 'gpt-6-astra');
  assert.deepEqual(upstream.body.text.format, format);
  assert.equal(upstream.headers['x-codex-routing-policy'], undefined);
});

test('routing capabilities and implementation revision are discoverable; unknown policies fail closed', async () => {
  const health = await exchange('', {}, { method: 'GET', url: '/health' });
  assert.deepEqual(health.body.capabilities.routingPolicies, ['preserve-model-v1']);
  assert.equal(health.body.capabilities.openrouterRejectionRecovery, 'completed-diagnostic-v1');
  assert.match(health.body.revision, /^[a-f0-9]{64}$/);
  assert.equal(health.body.capabilities.revisionPrecondition, true);
  const count = forwarded.length;
  const result = await exchange(JSON.stringify({ model: 'deepseek/example' }),
    { 'x-codex-routing-policy': 'typo' });
  assert.equal(result.status, 400);
  assert.equal(forwarded.length, count);
});

test('revision preconditions reject stale or malformed revisions before either upstream', async () => {
  const health = await exchange('', {}, { method: 'GET', url: '/health' });
  for (const model of ['gpt-6-astra', 'deepseek/example', 'openrouter/vendor/model']) {
    const count = forwarded.length;
    for (const [revision, status, code] of [
      ['0'.repeat(64), 409, 'router_revision_mismatch'],
      ['invalid', 400, 'invalid_router_revision'],
      ['', 400, 'invalid_router_revision'],
      [['a'.repeat(64), 'b'.repeat(64)], 400, 'invalid_router_revision'],
    ]) {
      const result = await exchange(JSON.stringify({ model }), { 'x-codex-router-revision': revision });
      assert.equal(result.status, status);
      assert.equal(result.body.error.code, code);
      assert.equal(forwarded.length, count);
    }
    const upstream = await send({ model, input: 'Synthetic revision check' }, {
      'x-codex-router-revision': health.body.revision, 'x-codex-routing-policy': 'preserve-model-v1',
    });
    assert.equal(forwarded.length, count + 1);
    assert.equal(upstream.headers['x-codex-router-revision'], undefined);
    assert.equal(upstream.body.model, model.replace(/^openrouter\//, ''));
  }
  assert.equal((await exchange('{}', {
    'x-codex-router-token': undefined, 'x-codex-router-revision': 'invalid',
  })).status, 401);
});

test('native reasoning, messages, tool calls, and tool results survive unchanged', async () => {
  const input = [
    nativeReasoning,
    { ...nativeReasoning, id: 'rs_empty', content: [] },
    { type: 'reasoning', id: 'rs_reference', summary: [] },
    { type: 'reasoning', id: 'rs_summary', summary: [{ type: 'summary_text', text: 'Summary only.' }] },
    { type: 'function_call', call_id: 'call_test', name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_test', output: 'found' },
    { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Found it.' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] },
  ];
  const upstream = await send({ model: 'gpt-6-astra', input });
  assert.deepEqual(upstream.body.input, input);
});

test('reasoning with encrypted content retains it while omitting plaintext content', async () => {
  const input = [{ ...nativeReasoning, content: deepseekReasoning.content }];
  const upstream = await send({ model: 'gpt-6-astra', input });
  assert.deepEqual(upstream.body.input, [nativeReasoning]);
});

test('DeepSeek and other OpenRouter routes retain their reasoning history', async () => {
  for (const model of ['deepseek/deepseek-v4.1-flash-1017', 'openrouter/vendor/model']) {
    const upstream = await send({ model, input: mixedHistory, reasoning: { effort: 'xhigh' } });
    assert.equal(upstream.hostname, 'openrouter.ai');
    assert.equal(upstream.path, '/api/v1/responses');
    assert.equal(upstream.body.model, model.replace(/^openrouter\//, ''));
    assert.deepEqual(upstream.body.input, mixedHistory);
    assert.deepEqual(upstream.body.reasoning, { effort: model.startsWith('deepseek/') ? 'max' : 'xhigh' });
    assert.equal(upstream.headers.authorization, 'Bearer test-openrouter-key');
    assert.equal(upstream.headers['chatgpt-account-id'], undefined);
  }
});

test('only DeepSeek reasoning efforts are remapped; other OpenRouter models keep standard efforts', async () => {
  for (const [requested, deepseek] of [
    ['minimal', 'max'], ['low', 'low'], ['medium', 'high'], ['high', 'high'], ['xhigh', 'max'], ['max', 'max'],
  ]) {
    for (const model of ['deepseek/deepseek-v4.1-flash-1017', 'openrouter/deepseek/deepseek-v4.1-flash-1017']) {
      const upstream = await send({ model, input: 'Hello', reasoning: { effort: requested } });
      assert.deepEqual(upstream.body.reasoning, { effort: deepseek });
    }
    const muse = await send({ model: 'openrouter/meta/muse-spark-1.3-contributor', input: 'Hello', reasoning: { effort: requested } });
    assert.equal(muse.body.model, 'meta/muse-spark-1.3-contributor');
    assert.deepEqual(muse.body.reasoning, { effort: requested });
  }
});

test('configured OpenRouter endpoint preferences apply only to their model', async () => {
  const logsBefore = parsedLogEntries().length;
  const pinned = await send({ model: 'openrouter/vendor/pinned', input: 'Hello' });
  assert.deepEqual(pinned.body.provider, { order: ['google-vertex/us', 'google-ai-studio'] });
  const forwardedLog = parsedLogEntries().slice(logsBefore).find(entry => entry.event === 'request.forwarded');
  assert.deepEqual(forwardedLog.providerOrder, ['google-vertex/us', 'google-ai-studio']);

  const unpinned = await send({ model: 'openrouter/vendor/model', input: 'Hello' });
  assert.equal(unpinned.body.provider, undefined);
  const explicit = await send({ model: 'openrouter/vendor/pinned', input: 'Hello', provider: { only: ['custom'] } });
  assert.deepEqual(explicit.body.provider, { only: ['custom'] });
  const native = await send({ model: 'vendor/pinned', input: 'Hello' });
  assert.equal(native.hostname, 'chatgpt.com');
  assert.equal(native.body.provider, undefined);
});

test('OpenRouter continuation is stateless without forwarding the native session ID', async () => {
  const upstream = await send({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: 'Continue after a tool call',
    previous_response_id: 'resp_upstream_state',
    store: true,
  }, { session_id: 'codex-thread-session' });
  assert.equal(upstream.headers['x-session-id'], undefined);
  assert.equal(upstream.body.previous_response_id, undefined);
  assert.equal(upstream.body.store, false);
  const forwardedLog = parsedLogEntries().filter(entry => entry.event === 'request.forwarded').at(-1);
  assert.equal(forwardedLog.stateReset, true);

  const native = await send({ model: 'gpt-6-astra', input: 'Native continuation', store: true },
    { session_id: 'native-session' });
  assert.equal(native.headers.session_id, 'native-session');
  assert.equal(native.headers['x-session-id'], undefined);
  assert.equal(native.body.store, true);
});

test('OpenRouter tool history drops invalid records and keeps one ordered output per call', async () => {
  const firstCall = { type: 'function_call', call_id: 'call_first', name: 'lookup', arguments: '{}' };
  const secondCall = { type: 'function_call', call_id: 'call_second', name: 'lookup', arguments: '{}' };
  const firstOutput = { type: 'function_call_output', call_id: 'call_first', output: 'old result' };
  const latestFirstOutput = { type: 'function_call_output', call_id: 'call_first', output: 'latest result' };
  const secondOutput = { type: 'function_call_output', call_id: 'call_second', output: 'second result' };
  const input = [
    deepseekReasoning,
    firstCall,
    secondCall,
    secondOutput,
    firstOutput,
    firstCall,
    latestFirstOutput,
    { type: 'function_call_output', call_id: 'call_orphan', output: 'orphan result' },
    { type: 'function_call', name: 'lookup', arguments: '{}' },
    { type: 'function_call', call_id: 'call_pending', name: 'lookup', arguments: '{}' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Continue.' }] },
  ];

  const upstream = await send({ model: 'deepseek/deepseek-v4.1-flash-1017', input });
  assert.deepEqual(upstream.body.input, [
    deepseekReasoning,
    firstCall,
    secondCall,
    latestFirstOutput,
    secondOutput,
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Continue.' }] },
  ]);

  const forwardedLog = parsedLogEntries().filter(entry => entry.event === 'request.forwarded').at(-1);
  assert.deepEqual(forwardedLog.historyRepairs, {
    changed: true,
    droppedInvalidCalls: 1,
    droppedDuplicateCalls: 1,
    droppedUnansweredCalls: 1,
    droppedOrphanOutputs: 1,
    droppedDuplicateOutputs: 1,
  });
});

test('OpenRouter keeps sequential tool rounds separate and orders parallel outputs by call', async () => {
  const firstCall = { type: 'function_call', call_id: 'call_first', name: 'lookup', arguments: '{}' };
  const secondCall = { type: 'function_call', call_id: 'call_second', name: 'lookup', arguments: '{}' };
  const firstOutput = { type: 'function_call_output', call_id: 'call_first', output: 'first' };
  const secondOutput = { type: 'function_call_output', call_id: 'call_second', output: 'second' };

  const sequential = await send({
    model: 'openrouter/vendor/model',
    input: [firstCall, firstOutput, secondCall, secondOutput],
  });
  assert.deepEqual(sequential.body.input, [firstCall, firstOutput, secondCall, secondOutput]);

  const parallel = await send({
    model: 'openrouter/vendor/model',
    input: [firstCall, secondCall, secondOutput, firstOutput],
  });
  assert.deepEqual(parallel.body.input, [firstCall, secondCall, firstOutput, secondOutput]);
});

test('OpenRouter retries one compacted history after a pre-stream 400', async t => {
  mockUpstreamSequence(t, [
    {
      status: 400,
      generationId: 'gen_reject_recovery',
      body: JSON.stringify({
        error: { message: 'invalid request', code: 400, metadata: { provider_name: null } },
      }),
    },
    {
      status: 200,
      contentType: 'text/event-stream',
      generationId: 'gen_recovered',
      body: 'data: {"type":"response.completed","response":{"id":"resp_recovered","end_turn":true}}\n\n',
    },
  ]);
  const before = forwarded.length;
  const logsBefore = parsedLogEntries().length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: recoveryHistory,
  }), { 'x-codex-routing-policy': 'preserve-model-v1' });

  assert.equal(result.status, 200);
  assert.match(result.rawBody, /resp_recovered/);
  assert.equal(forwarded.length, before + 2);
  const [primary, recovery] = forwarded.slice(before);
  assert.deepEqual(primary.body.input, recoveryHistory);
  assert.ok(recovery.body.input.length < primary.body.input.length);
  assert.deepEqual(recovery.body.input, [
    recoveryHistory[0],
    recoveryHistory[101],
    recoveryHistory[102],
    recoveryHistory[103],
  ]);

  const entries = parsedLogEntries().slice(logsBefore);
  const rejected = entries.find(entry => entry.event === 'openrouter.request_rejected');
  assert.equal(rejected.status, 400);
  assert.equal(rejected.attempt, 1);
  assert.equal(rejected.inputItems, recoveryHistory.length);
  assert.equal(rejected.generationId, 'gen_reject_recovery');
  assert.match(rejected.payloadSha256, /^[a-f0-9]{64}$/);
  const retry = entries.find(entry => entry.event === 'openrouter.recovery_attempt');
  assert.equal(retry.attempt, 2);
  assert.equal(retry.compactionStrategy, 'latest-user-turn');
  assert.equal(retry.inputItems, 4);
  assert.ok(retry.droppedItems > 0);
  assert.match(retry.payloadSha256, /^[a-f0-9]{64}$/);
});

test('OpenRouter recovery keeps a bounded recent tail for a long single-turn history', async t => {
  const singleTurnHistory = [
    {
      type: 'message',
      id: 'msg_long_user',
      role: 'user',
      content: [{ type: 'input_text', text: 'Perform a long task.' }],
    },
    ...Array.from({ length: 100 }, (_, index) => ({
      type: 'message',
      id: `msg_long_assistant_${index}`,
      role: 'assistant',
      content: [{ type: 'output_text', text: `Progress ${index}` }],
    })),
  ];
  mockUpstreamSequence(t, [
    {
      status: 400,
      body: JSON.stringify({ error: { message: 'invalid request', code: 400 } }),
    },
    {
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"response.completed","response":{"id":"resp_tail","end_turn":true}}\n\n',
    },
  ]);
  const before = forwarded.length;
  const logsBefore = parsedLogEntries().length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: singleTurnHistory,
  }), { 'x-codex-routing-policy': 'preserve-model-v1' });

  assert.equal(result.status, 200);
  assert.equal(forwarded.length, before + 2);
  const recovery = forwarded.at(-1);
  assert.ok(recovery.body.input.length <= 80);
  assert.equal(recovery.body.input[0].id, 'msg_long_user');
  assert.equal(recovery.body.input.at(-1).id, 'msg_long_assistant_99');
  const retry = parsedLogEntries().slice(logsBefore)
    .find(entry => entry.event === 'openrouter.recovery_attempt');
  assert.equal(retry.compactionStrategy, 'recent-tail');
});

test('OpenRouter recovery bounds a long latest turn that follows earlier turns', async t => {
  const longTurnHistory = [
    recoveryHistory[0],
    { type: 'message', id: 'msg_earlier_user', role: 'user', content: [{ type: 'input_text', text: 'Earlier task.' }] },
    { type: 'message', id: 'msg_earlier_reply', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
    { type: 'message', id: 'msg_task', role: 'user', content: [{ type: 'input_text', text: 'Refactor everything.' }] },
    ...Array.from({ length: 120 }, (_, index) => [
      { type: 'function_call', call_id: `call_long_${index}`, name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: `call_long_${index}`, output: 'x'.repeat(20000) },
    ]).flat(),
  ];
  mockUpstreamSequence(t, [
    { status: 400, body: JSON.stringify({ error: { message: 'invalid request', code: 400 } }) },
    {
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"response.completed","response":{"id":"resp_long_turn","end_turn":true}}\n\n',
    },
  ]);
  const before = forwarded.length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: longTurnHistory,
  }));

  assert.equal(result.status, 200);
  assert.equal(forwarded.length, before + 2);
  const [primary, recovery] = forwarded.slice(before);
  const input = recovery.body.input;
  assert.ok(recovery.byteLength < primary.byteLength / 2);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 1024 * 1024);
  assert.deepEqual(input.slice(0, 2).map(item => item.id), ['msg_current_developer', 'msg_task']);
  assert.equal(input.at(-1).call_id, 'call_long_119');
  const callIds = new Set(input.filter(item => item.type === 'function_call').map(item => item.call_id));
  const outputIds = input.filter(item => item.type === 'function_call_output').map(item => item.call_id);
  assert.deepEqual(outputIds, [...callIds]);
});

test('OpenRouter recovery drops encrypted reasoning from a short history', async t => {
  mockUpstreamSequence(t, [
    { status: 400, body: JSON.stringify({ error: { message: 'invalid request', code: 400 } }) },
    {
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"response.completed","response":{"id":"resp_no_reasoning","end_turn":true}}\n\n',
    },
  ]);
  const before = forwarded.length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: mixedHistory,
  }));

  assert.equal(result.status, 200);
  assert.match(result.rawBody, /resp_no_reasoning/);
  assert.equal(forwarded.length, before + 2);
  assert.deepEqual(forwarded.at(-1).body.input, mixedHistory.filter(item => item !== nativeReasoning));
});

test('an OpenRouter context-window rejection fails the response so Codex can compact', async t => {
  mockUpstreamSequence(t, [{
    status: 400,
    body: JSON.stringify({ error: {
      message: "This endpoint's maximum context length is 163840 tokens. However, you requested about 200000 tokens.",
      code: 400,
    } }),
  }]);
  const before = forwarded.length;
  const logsBefore = parsedLogEntries().length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: recoveryHistory,
  }));

  assert.equal(result.status, 200);
  assert.equal(result.headers['x-codex-router-diagnostic'], 'openrouter-context-overflow');
  assert.equal(forwarded.length, before + 1);
  const events = parseSse(result.rawBody);
  assert.deepEqual(events.map(event => event.type), ['response.created', 'response.failed']);
  assert.equal(events[1].response.error.code, 'context_length_exceeded');
  assert.doesNotMatch(result.rawBody, /163840/);
  const rejected = parsedLogEntries().slice(logsBefore)
    .find(entry => entry.event === 'openrouter.request_rejected');
  assert.equal(rejected.contextOverflow, true);
});

test('a context overflow reported only through error_type also fails the response', async t => {
  mockUpstreamSequence(t, [{
    status: 400,
    body: JSON.stringify({
      error_type: 'context_length_exceeded',
      error: { code: 'invalid_prompt', message: 'Request rejected' },
    }),
  }]);
  const before = forwarded.length;
  const result = await exchangeRaw(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello' }));
  assert.equal(result.headers['x-codex-router-diagnostic'], 'openrouter-context-overflow');
  assert.equal(parseSse(result.rawBody)[1].response.error.code, 'context_length_exceeded');
  assert.equal(forwarded.length, before + 1);
});

test('an OpenRouter 400 that closes before ending returns 502 instead of hanging', async t => {
  t.mock.method(https, 'request', (options, onResponse) => new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
    final(callback) {
      const response = new PassThrough();
      response.statusCode = 400;
      response.headers = { 'content-type': 'application/json' };
      queueMicrotask(() => {
        onResponse(response);
        response.write('{"error":');
        response.destroy();
      });
      callback();
    },
  }));
  const result = await exchangeRaw(JSON.stringify({ model: 'openrouter/vendor/model', input: 'Hello' }));
  assert.equal(result.status, 502);
});

test('tool-history repair keeps an answered retry that reuses an unanswered call ID', async () => {
  const call = args => ({ type: 'function_call', call_id: 'call_retry', name: 'exec_command', arguments: args });
  const output = { type: 'function_call_output', call_id: 'call_retry', output: 'done' };
  const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Retrying.' }] };
  const upstream = await send({
    model: 'openrouter/vendor/model',
    input: [{ role: 'user', content: 'go' }, call('{"cmd":"first"}'), message, call('{"cmd":"second"}'), output],
  });
  // One call/output pair survives; neither the call nor its output is lost.
  assert.deepEqual(upstream.body.input, [{ role: 'user', content: 'go' }, call('{"cmd":"first"}'), output, message]);
});

test('a repeated OpenRouter 400 completes with a router diagnostic instead of breaking Codex', async t => {
  mockUpstreamSequence(t, [
    {
      status: 400,
      generationId: 'gen_reject_primary',
      body: JSON.stringify({
        error: { message: 'invalid request', code: 400, metadata: { provider_name: null } },
      }),
    },
    {
      status: 400,
      generationId: 'gen_reject_recovery',
      body: JSON.stringify({
        error: { message: 'invalid request', code: 400, metadata: { provider_name: null } },
      }),
    },
  ]);
  const before = forwarded.length;
  const captureBefore = readdirSync(rejectedRequestDir).sort();
  const logsBefore = parsedLogEntries().length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'openrouter/vendor/model',
    input: recoveryHistory,
  }), { 'x-codex-routing-policy': 'preserve-model-v1' });

  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'text/event-stream');
  assert.equal(result.headers['x-codex-router-diagnostic'], 'openrouter-request-rejected');
  assert.doesNotMatch(result.rawBody, /"error"/);
  const events = parseSse(result.rawBody);
  assert.deepEqual(events.map(event => event.type), [
    'response.created',
    'response.output_item.done',
    'response.completed',
  ]);
  assert.equal(events[1].item.role, 'assistant');
  assert.equal(events[1].item.content[0].text,
    '[router diagnostic] OpenRouter rejected this step. The thread is intact; retry or start a new thread.');
  assert.equal(events[2].response.end_turn, true);
  assert.equal(events[2].response.usage, undefined);
  assert.equal(forwarded.length, before + 2);

  const entries = parsedLogEntries().slice(logsBefore);
  const rejected = entries.filter(entry => entry.event === 'openrouter.request_rejected');
  assert.equal(rejected.length, 2);
  assert.deepEqual(rejected.map(entry => entry.attempt), [1, 2]);
  assert.deepEqual(rejected.map(entry => entry.generationId), [
    'gen_reject_primary',
    'gen_reject_recovery',
  ]);
  for (const entry of rejected) {
    assert.match(entry.payloadSha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.status, 400);
    assert.equal(entry.bytes > 0, true);
    assert.equal(entry.inputItems > 0, true);
    assert.equal(entry.upstreamErrorCode, 400);
    assert.equal(entry.upstreamErrorBytes > 0, true);
  }
  assert.equal(entries.some(entry => entry.event === 'openrouter.fallback_completion'), true);
  const serializedLogs = JSON.stringify(entries);
  assert.doesNotMatch(serializedLogs, /Continue the current task|Old turn 0|printf current/);

  const captureAfter = readdirSync(rejectedRequestDir).sort();
  const created = captureAfter.filter(name => !captureBefore.includes(name));
  assert.equal(created.length, 4);
  for (const name of created) {
    assert.equal(statSync(join(rejectedRequestDir, name)).mode & 0o777, 0o600);
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(rejectedRequestDir, name), 'utf8')));
  }
});

test('native OpenAI 400 responses remain errors and are never replaced by router diagnostics', async t => {
  mockUpstreamSequence(t, [{
    status: 400,
    generationId: 'gen_native_reject',
    body: JSON.stringify({ error: { message: 'native rejected this request', code: 400 } }),
  }]);
  const result = await exchangeRaw('{"model":"gpt-6-astra","input":"Hello"}');
  assert.equal(result.status, 400);
  assert.deepEqual(JSON.parse(result.rawBody), {
    error: { message: 'native rejected this request', code: 400 },
  });
});

test('structured router logs correlate requests without recording bodies or credentials', async () => {
  const ready = parsedLogEntries().find(entry => entry.event === 'router.ready');
  assert.match(ready.revision, /^[a-f0-9]{64}$/);
  const before = logEntries.length;
  const sensitiveBody = 'ROUTER_PRIVATE_BODY_VALUE';
  await send({ model: 'openrouter/vendor/model', input: sensitiveBody }, {
    'x-private-header': 'ROUTER_PRIVATE_HEADER_VALUE', session_id: 'session-log-test',
  });
  const rejected = await exchange(JSON.stringify({
    model: 'openrouter/vendor/model',
    text: { format: { type: 'json_schema' } },
  }), { 'x-codex-routing-policy': 'preserve-model-v1' });
  assert.equal(rejected.status, 422);
  await new Promise(resolve => setImmediate(resolve));

  const entries = parsedLogEntries().slice(before);
  const forwarded = entries.filter(entry => entry.event === 'request.forwarded').at(-1);
  assert.match(forwarded.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(forwarded.sessionId, 'session-log-test');
  const started = entries.find(entry => entry.event === 'upstream.response_started'
    && entry.requestId === forwarded.requestId);
  const finished = entries.find(entry => entry.event === 'upstream.response_finished'
    && entry.requestId === forwarded.requestId);
  const completed = entries.find(entry => entry.event === 'request.finished'
    && entry.requestId === forwarded.requestId);
  assert.equal(completed.sessionId, 'session-log-test');
  assert.equal(completed.level, 'info');
  assert.equal(completed.status, 200);
  const rejectedFinished = entries.filter(entry => entry.event === 'request.finished').at(-1);
  assert.equal(rejectedFinished.level, 'error');
  assert.equal(rejectedFinished.status, 422);
  for (const entry of [started, finished]) {
    assert.equal(entry.generationId, 'gen_test');
    assert.equal(entry.providerName, 'TestProvider');
    assert.equal(entry.upstreamRequestId, 'req_test');
    assert.equal(entry.cloudflareRayId, 'cf_test');
  }
  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, new RegExp(sensitiveBody));
  assert.doesNotMatch(serialized, /ROUTER_PRIVATE_HEADER_VALUE|test-openrouter-key|a{64}/);
});

test('string, empty, and absent inputs still pass through', async () => {
  for (const body of [{ input: 'Hello' }, { input: [] }, {}]) {
    const upstream = await send({ model: 'gpt-6-astra', ...body });
    assert.deepEqual(upstream.body, { model: 'gpt-6-astra', ...body });
  }
});

for (const phase of ['before headers', 'after headers', 'during streaming', 'after completion']) {
  test(`upstream cleanup when the client closes ${phase}`, async t => {
    const upstream = new Writable({
      autoDestroy: false,
      write(_chunk, _encoding, callback) { callback(); },
    });
    const upstreamResponse = new PassThrough();
    upstreamResponse.statusCode = 200;
    upstreamResponse.headers = { 'content-type': 'text/event-stream' };
    let deliverHeaders;
    t.mock.method(https, 'request', (_options, onResponse) => {
      deliverHeaders = () => onResponse(upstreamResponse);
      return upstream;
    });
    t.after(() => {
      upstream.destroy();
      upstreamResponse.destroy();
    });

    const request = new PassThrough();
    Object.assign(request, {
      method: 'POST',
      url: '/v1/responses',
      headers: { ...clientHeaders },
    });
    const response = new PassThrough();
    response.headersSent = false;
    response.writeHead = status => {
      response.statusCode = status;
      response.headersSent = true;
    };
    const received = [];
    response.on('data', chunk => received.push(chunk.toString()));
    t.after(() => response.destroy());
    const sent = once(upstream, 'finish');
    handleRequest(request, response);
    request.end(JSON.stringify({ model: 'gpt-6-astra', input: 'Hello' }));
    await sent;
    assert.equal(upstream.destroyed, false);

    if (phase !== 'before headers') deliverHeaders();
    if (phase === 'during streaming' || phase === 'after completion') {
      upstreamResponse.write('data: first chunk\n\n');
      assert.deepEqual(received, ['data: first chunk\n\n']);
      assert.equal(upstream.destroyed, false);
    }
    const before = logEntries.length;
    const closed = once(response, 'close');
    if (phase === 'after completion') upstreamResponse.end();
    else response.destroy();
    await closed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(upstream.destroyed, phase !== 'after completion');
    const events = parsedLogEntries().slice(before).map(entry => entry.event);
    assert.equal(events.includes('request.aborted'), phase !== 'after completion');
    assert.equal(events.includes('upstream.error'), false);
  });
}

test('router authentication is required even with a Codex bearer token', async () => {
  const count = forwarded.length;
  for (const token of [undefined, '', 'wrong', 'b'.repeat(64), 'é'.repeat(64)]) {
    for (const model of ['gpt-6-astra', 'deepseek/example']) {
      const result = await exchange(JSON.stringify({ model }), { 'x-codex-router-token': token });
      assert.equal(result.status, 401);
    }
  }
  const models = await exchange('', { 'x-codex-router-token': undefined }, { method: 'GET', url: '/v1/models' });
  assert.equal(models.status, 401);
  const health = await exchange('', { 'x-codex-router-token': undefined }, { method: 'GET', url: '/health' });
  assert.equal(health.status, 200);
  assert.equal(health.body.clientAuth, true);
  assert.equal(forwarded.length, count);
});

test('rejects browser origins, foreign hosts, and non-JSON content before forwarding', async () => {
  const count = forwarded.length;
  for (const headers of [
    { host: 'evil.example:18766' }, { host: undefined }, { host: '127.0.0.1:1234' },
    { origin: 'https://evil.example' }, { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-origin' },
  ]) {
    assert.equal((await exchange('{"model":"deepseek/example"}', headers)).status, 403);
  }
  for (const contentType of [undefined, 'text/plain', 'application/jsonp']) {
    assert.equal((await exchange('{"model":"deepseek/example"}', { 'content-type': contentType })).status, 415);
  }
  assert.equal(forwarded.length, count);
});

test('malformed JSON and invalid body shapes return 400 and subsequent requests work', async () => {
  const count = forwarded.length;
  const invalid = [null, [], 1, true, 'hello', {}, { model: 1 }, { model: ' ' },
    { model: 'deepseek/example', input: {} }, { model: 'deepseek/example', reasoning: [] },
    { model: 'deepseek/example', reasoning: { effort: { toString: null } } },
    { model: 'deepseek/example', text: { format: 'json' } }];
  for (const body of ['{broken', ...invalid.map(value => JSON.stringify(value))]) {
    assert.equal((await exchange(body)).status, 400);
  }
  assert.equal(forwarded.length, count);
  await send({ model: 'gpt-6-astra' });
});

test('only provider-specific headers go upstream; local and unrelated credentials stay local', async () => {
  for (const model of ['gpt-6-astra', 'openrouter/vendor/model']) {
    const upstream = await send({ model }, {
      cookie: 'private-cookie', 'proxy-authorization': 'private-proxy-token',
      'x-private-header': 'private-value', 'openai-beta': 'responses=experimental',
      session_id: 'native-session', 'x-codex-turn-state': 'native-state',
      'content-type': 'application/json; charset=utf-8',
    });
    for (const name of ['cookie', 'proxy-authorization', 'x-private-header', 'x-codex-router-token', 'host']) {
      assert.equal(upstream.headers[name], undefined);
    }
    assert.equal(upstream.headers.session_id, model.startsWith('gpt') ? 'native-session' : undefined);
    assert.equal(upstream.headers['x-codex-turn-state'], model.startsWith('gpt') ? 'native-state' : undefined);
  }
});

test('synchronous upstream failures return 502 without exposing error details', async t => {
  t.mock.method(https, 'request', () => { throw new Error('private error details'); });
  const result = await exchange('{"model":"gpt-6-astra"}');
  assert.equal(result.status, 502);
  assert.doesNotMatch(JSON.stringify(result.body), /private error details/);
});

for (const failure of ['error', 'premature close']) {
  test(`upstream ${failure} closes the downstream stream`, async t => {
    const upstream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const upstreamResponse = new PassThrough();
    upstreamResponse.statusCode = 200;
    upstreamResponse.headers = { 'content-type': 'text/event-stream' };
    t.mock.method(https, 'request', (_options, onResponse) => {
      queueMicrotask(() => onResponse(upstreamResponse));
      return upstream;
    });
    const request = new PassThrough();
    Object.assign(request, { method: 'POST', url: '/v1/responses', headers: { ...clientHeaders } });
    const response = new PassThrough();
    response.writeHead = () => { response.headersSent = true; };
    response.resume();
    const closed = new Promise(resolve => response.once('close', resolve));
    t.after(() => { request.destroy(); response.destroy(); upstream.destroy(); upstreamResponse.destroy(); });
    handleRequest(request, response);
    request.end('{"model":"gpt-6-astra"}');
    await new Promise(resolve => setImmediate(resolve));
    const before = logEntries.length;
    upstreamResponse.write('data: first\n\n');
    upstreamResponse.destroy(failure === 'error' ? new Error('upstream reset') : undefined);
    await closed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(response.destroyed, true);
    assert.equal(upstream.destroyed, true);
    const events = parsedLogEntries().slice(before).map(entry => entry.event);
    assert.deepEqual(events, ['upstream.error']);
  });
}
