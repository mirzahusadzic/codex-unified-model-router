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
process.env.CODEX_ROUTER_TOKEN = 'a'.repeat(64);
process.env.CODEX_ROUTER_PORT = '18766';
const clientHeaders = {
  host: '127.0.0.1:18766',
  'content-type': 'application/json',
  'x-codex-router-token': process.env.CODEX_ROUTER_TOKEN,
  authorization: 'Bearer test-codex-token',
  'chatgpt-account-id': 'test-account',
};
let handleRequest;
const forwarded = [];
mock.method(console, 'log', () => {});
mock.method(console, 'error', () => {});
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

async function exchange(rawBody, headers = {}, { method = 'POST', url = '/v1/responses' } = {}) {
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
  response.writeHead = status => {
    response.statusCode = status;
    response.headersSent = true;
  };
  const chunks = [];
  response.on('data', chunk => chunks.push(chunk));
  const done = once(response, 'end');
  handleRequest(request, response);
  request.end(rawBody);
  await done;
  return { status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}

async function send(body, headers) {
  const result = await exchange(JSON.stringify(body), headers);
  assert.equal(result.status, 200, JSON.stringify(result.body));
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
    const closed = once(response, 'close');
    if (phase === 'after completion') upstreamResponse.end();
    else response.destroy();
    await closed;
    assert.equal(upstream.destroyed, phase !== 'after completion');
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
    upstreamResponse.write('data: first\n\n');
    upstreamResponse.destroy(failure === 'error' ? new Error('upstream reset') : undefined);
    await closed;
    assert.equal(response.destroyed, true);
    assert.equal(upstream.destroyed, true);
  });
}
