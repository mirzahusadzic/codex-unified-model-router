import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { PassThrough, Readable, Writable } from 'node:stream';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Exercise the router's request handler without network access or real credentials.
process.env.CODEX_ROUTER_ENV_FILE = fileURLToPath(new URL('./missing.env', import.meta.url));
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
process.env.CODEX_ROUTER_STRUCTURED_MODEL = 'gpt-6-astra';
let handleRequest;
const forwarded = [];
mock.method(console, 'log', () => {});
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
      response.headers = { 'content-type': 'application/json' };
      queueMicrotask(() => onResponse(response));
      callback();
    },
  });
});
await import('../router/unified-router.mjs');
after(() => mock.restoreAll());

async function send(body) {
  const request = new PassThrough();
  Object.assign(request, {
    method: 'POST',
    url: '/v1/responses',
    headers: {
      authorization: 'Bearer test-codex-token',
      'chatgpt-account-id': 'test-account',
      'content-length': '1',
    },
  });
  const response = new PassThrough();
  response.headersSent = false;
  response.writeHead = status => {
    response.statusCode = status;
    response.headersSent = true;
  };
  const chunks = [];
  response.on('data', chunk => chunks.push(chunk));
  const done = once(response, 'end');
  handleRequest(request, response);
  request.end(JSON.stringify(body));
  await done;
  assert.equal(response.statusCode, 200, Buffer.concat(chunks).toString('utf8'));
  const upstream = forwarded.at(-1);
  assert.equal(Number(upstream.headers['content-length']), upstream.byteLength);
  return upstream;
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
    assert.deepEqual(upstream.body.reasoning, { effort: 'max' });
    assert.equal(upstream.headers.authorization, 'Bearer test-openrouter-key');
    assert.equal(upstream.headers['chatgpt-account-id'], undefined);
  }
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
      headers: { authorization: 'Bearer test-codex-token' },
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
    const closed = once(response, 'close');
    if (phase === 'after completion') upstreamResponse.end();
    else response.destroy();
    await closed;
    assert.equal(upstream.destroyed, phase !== 'after completion');
  });
}
