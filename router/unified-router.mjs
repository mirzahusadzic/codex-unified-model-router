import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const host = '127.0.0.1';
const port = Number(process.env.CODEX_ROUTER_PORT || 18766);
const envFile = process.env.CODEX_ROUTER_ENV_FILE || join(homedir(), '.codex', 'unified-router', 'openrouter.env');
const modelCatalogFile = process.env.CODEX_MODEL_CATALOG || join(homedir(), '.codex', 'models.json');
const structuredFallbackModel = process.env.CODEX_ROUTER_STRUCTURED_MODEL || 'gpt-6-astra';
const maxBodyBytes = 64 * 1024 * 1024;
const routerRevision = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');

function readEnvironmentFile(file) {
  if (!existsSync(file)) return {};
  const values = {};
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const fileEnvironment = readEnvironmentFile(envFile);
const logLevels = { error: 0, info: 1, debug: 2 };
const configuredLogLevel = String(
  process.env.CODEX_ROUTER_LOG_LEVEL || fileEnvironment.CODEX_ROUTER_LOG_LEVEL || 'error',
).trim().toLowerCase();
if (!Object.hasOwn(logLevels, configuredLogLevel)) {
  throw new Error('CODEX_ROUTER_LOG_LEVEL must be error, info, or debug');
}
const openrouterApiKey = process.env.OPENROUTER_API_KEY || fileEnvironment.OPENROUTER_API_KEY || '';
const routerToken = process.env.CODEX_ROUTER_TOKEN || fileEnvironment.CODEX_ROUTER_TOKEN || '';
const rejectedRequestDir = String(
  process.env.CODEX_ROUTER_REJECTED_REQUEST_DIR
    || fileEnvironment.CODEX_ROUTER_REJECTED_REQUEST_DIR
    || '',
).trim();
if (!/^[a-f0-9]{64}$/.test(routerToken)) {
  throw new Error('A 64-character hex CODEX_ROUTER_TOKEN is required; rerun the installer');
}

// Optional OpenRouter endpoint preferences, for example
// `deepseek/deepseek-v4.1-flash-1017=deepseek`. Separate models with `;`.
function parseProviderOrders(value) {
  const orders = new Map();
  for (const entry of value.split(';').map(part => part.trim()).filter(Boolean)) {
    const match = entry.match(/^([^=\s]+)\s*=\s*(.+)$/);
    const providers = match?.[2].split(',').map(provider => provider.trim()).filter(Boolean) || [];
    if (!match || providers.length === 0 || providers.some(provider => /\s/.test(provider))) {
      throw new Error('CODEX_ROUTER_PROVIDER_ORDER entries must look like model=provider[,provider]');
    }
    orders.set(match[1], providers);
  }
  return orders;
}
const providerOrders = parseProviderOrders(String(
  process.env.CODEX_ROUTER_PROVIDER_ORDER || fileEnvironment.CODEX_ROUTER_PROVIDER_ORDER || '',
));

const openrouterRejectedDiagnostic = '[router diagnostic] OpenRouter rejected this step. The thread is intact; retry or start a new thread.';
const openrouterContextOverflowMessage = 'The conversation exceeds the OpenRouter model context window.';
const openrouterRecoveryCompactBytes = 1024 * 1024;
const openrouterRecoveryCompactItems = 80;
const maxCapturedUpstreamErrorBytes = 256 * 1024;

function isAuthenticated(headers) {
  const supplied = headers['x-codex-router-token'];
  return typeof supplied === 'string'
    && Buffer.byteLength(supplied) === Buffer.byteLength(routerToken)
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(routerToken));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validRequest(body) {
  return isObject(body)
    && typeof body.model === 'string' && body.model.trim().length > 0
    && (body.input == null || typeof body.input === 'string' || Array.isArray(body.input))
    && (body.reasoning == null || (isObject(body.reasoning)
      && (body.reasoning.effort == null || typeof body.reasoning.effort === 'string')))
    && (body.text == null || (isObject(body.text)
      && (body.text.format == null || (isObject(body.text.format)
        && (body.text.format.type == null || typeof body.text.format.type === 'string')))));
}

function routeFor(model) {
  if (typeof model === 'string' && (model.startsWith('deepseek/') || model.startsWith('openrouter/'))) {
    return {
      provider: 'openrouter',
      hostname: 'openrouter.ai',
      path: '/api/v1/responses',
      protocol: https,
    };
  }
  return {
    provider: 'openai',
    hostname: 'chatgpt.com',
    path: '/backend-api/codex/responses',
    protocol: https,
  };
}

function upstreamModelFor(model, provider) {
  if (provider === 'openrouter' && typeof model === 'string' && model.startsWith('openrouter/')) {
    return model.slice('openrouter/'.length);
  }
  return model;
}

function hasStructuredOutput(request) {
  const format = request?.text?.format;
  return Boolean(format && format.type && format.type !== 'text');
}

// DeepSeek accepts only low, high, max, and none. Other OpenRouter models take
// OpenRouter's standard efforts, which it translates for each provider.
function normalizeReasoningForOpenRouter(value, model) {
  if (!value || typeof value !== 'object' || value.effort == null || !model.startsWith('deepseek/')) return;
  const effort = String(value.effort);
  if (['low', 'high', 'max', 'none'].includes(effort)) return;
  value.effort = effort === 'medium' ? 'high' : 'max';
}

function normalizeStateForOpenRouter(request) {
  let changed = false;
  if (request.previous_response_id != null) {
    delete request.previous_response_id;
    changed = true;
  }
  if (request.store === true) {
    request.store = false;
    changed = true;
  }
  return changed;
}

function normalizeToolHistoryForOpenRouter(input) {
  const repairs = {
    changed: false,
    droppedInvalidCalls: 0,
    droppedDuplicateCalls: 0,
    droppedUnansweredCalls: 0,
    droppedOrphanOutputs: 0,
    droppedDuplicateOutputs: 0,
  };
  if (!Array.isArray(input)) return { input, repairs };

  const runs = [];
  for (let index = 0; index < input.length;) {
    if (input[index]?.type !== 'function_call') {
      index += 1;
      continue;
    }
    const run = { start: index, end: index, calls: [] };
    while (index < input.length && input[index]?.type === 'function_call') {
      run.calls.push({ index, item: input[index] });
      run.end = index;
      index += 1;
    }
    runs.push(run);
  }

  const retainedCallIndexes = new Set();
  const retainedCallIds = new Set();
  for (const run of runs) {
    for (const call of run.calls) {
      if (typeof call.item.call_id !== 'string' || call.item.call_id.length === 0) {
        repairs.droppedInvalidCalls += 1;
        continue;
      }
      if (retainedCallIds.has(call.item.call_id)) {
        repairs.droppedDuplicateCalls += 1;
        continue;
      }
      retainedCallIds.add(call.item.call_id);
      retainedCallIndexes.add(call.index);
    }
  }

  const outputsByCallId = new Map();
  for (const item of input) {
    if (item?.type !== 'function_call_output') continue;
    if (typeof item.call_id !== 'string' || !retainedCallIds.has(item.call_id)) {
      repairs.droppedOrphanOutputs += 1;
      continue;
    }
    if (outputsByCallId.has(item.call_id)) repairs.droppedDuplicateOutputs += 1;
    // The latest output is the most useful observation if an interrupted turn
    // left more than one result for the same call ID.
    outputsByCallId.set(item.call_id, item);
  }

  for (const run of runs) {
    for (const call of run.calls) {
      if (retainedCallIndexes.has(call.index) && !outputsByCallId.has(call.item.call_id)) {
        repairs.droppedUnansweredCalls += 1;
        retainedCallIndexes.delete(call.index);
      }
    }
  }

  const normalized = [];
  const runsByStart = new Map(runs.map(run => [run.start, run]));
  for (let index = 0; index < input.length;) {
    const run = runsByStart.get(index);
    if (run) {
      const calls = run.calls.filter(call => retainedCallIndexes.has(call.index));
      normalized.push(...calls.map(call => call.item));
      for (const call of calls) {
        const output = outputsByCallId.get(call.item.call_id);
        if (output) normalized.push(output);
      }
      index = run.end + 1;
      continue;
    }
    if (input[index]?.type !== 'function_call_output') normalized.push(input[index]);
    index += 1;
  }

  repairs.changed = normalized.length !== input.length
    || normalized.some((item, index) => item !== input[index]);
  return { input: normalized, repairs };
}

function normalizeInputForOpenAI(input) {
  if (!Array.isArray(input)) return input;
  return input.flatMap(item => {
    if (item?.type !== 'reasoning' || !Array.isArray(item.content) || item.content.length === 0) {
      return [item];
    }
    // Codex replays OpenRouter's plaintext reasoning after a model switch, but
    // the native backend requires reasoning content to be absent or empty.
    if (!item.encrypted_content) return [];
    const { content, ...reasoning } = item;
    return [reasoning];
  });
}

function logEvent(level, event, fields = {}) {
  if (logLevels[level] > logLevels[configuredLogLevel]) return;
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else console.log(line);
}

function upstreamTrace(headers) {
  const value = name => {
    const candidate = headers?.[name];
    return typeof candidate === 'string' && candidate.length <= 256 ? candidate : null;
  };
  return {
    generationId: value('x-generation-id'),
    providerName: value('x-provider-name'),
    upstreamRequestId: value('x-request-id') || value('request-id'),
    cloudflareRayId: value('cf-ray'),
  };
}

function upstreamHeaders(requestHeaders, provider, bodyLength) {
  const allowed = ['accept', 'user-agent'];
  if (provider === 'openai') {
    allowed.push('authorization', 'chatgpt-account-id', 'openai-beta', 'originator',
      'version', 'session_id', 'conversation_id', 'x-request-id', 'x-client-request-id',
      'x-codex-turn-metadata', 'x-codex-turn-state', 'x-codex-beta-features',
      'x-openai-internal-codex-responses-lite');
  }
  const headers = Object.fromEntries(allowed
    .filter(name => requestHeaders[name] !== undefined)
    .map(name => [name, requestHeaders[name]]));
  headers['content-length'] = String(bodyLength);
  headers['accept-encoding'] = 'identity';
  headers['content-type'] = 'application/json';

  if (provider === 'openrouter') {
    if (!openrouterApiKey) {
      const error = new Error('OPENROUTER_API_KEY is not configured for the unified router');
      error.statusCode = 503;
      throw error;
    }
    headers.authorization = `Bearer ${openrouterApiKey}`;
  } else if (!headers.authorization) {
    const error = new Error('The OpenAI request did not include Codex authentication');
    error.statusCode = 401;
    throw error;
  }
  return headers;
}

function responseHeaders(headers) {
  const result = { ...headers };
  for (const name of ['connection', 'transfer-encoding', 'content-length', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'set-cookie']) {
    delete result[name];
  }
  return result;
}

function sendJson(response, status, value) {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function payloadHash(body) {
  return createHash('sha256').update(body).digest('hex');
}

function captureRejectedRequest({
  requestId, attempt, requestBody, responseBody,
}) {
  if (!rejectedRequestDir) return null;
  // File modes do not restrict access on Windows. There, captures must stay in
  // the router directory, whose current-user-only ACL new files inherit.
  const fromRouterDir = relative(resolve(dirname(envFile)), resolve(rejectedRequestDir));
  if (process.platform === 'win32' && (fromRouterDir.startsWith('..') || isAbsolute(fromRouterDir))) {
    logEvent('error', 'openrouter.rejection_capture_refused', {
      requestId, attempt, reason: 'outside_private_router_directory',
    });
    return null;
  }
  const prefix = `${requestId}-attempt-${attempt}`;
  try {
    mkdirSync(rejectedRequestDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(rejectedRequestDir, `${prefix}.request.json`), requestBody, { mode: 0o600 });
    writeFileSync(join(rejectedRequestDir, `${prefix}.response.json`), responseBody, { mode: 0o600 });
    return prefix;
  } catch (error) {
    logEvent('error', 'openrouter.rejection_capture_failed', {
      requestId,
      attempt,
      errorCode: error.code || null,
    });
    return null;
  }
}

const contextOverflowPattern = /context[ _-]?(?:length|window)|maximum context|too many tokens|prompt is too long/i;

function parseUpstreamError(body) {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    const messages = [parsed?.error?.message, parsed?.error?.metadata?.raw]
      .filter(value => typeof value === 'string');
    const errorType = parsed?.error_type ?? parsed?.error?.type ?? null;
    return {
      errorCode: parsed?.error?.code ?? null,
      errorType,
      // OpenRouter's Responses API can report the overflow only in error_type.
      contextOverflow: [parsed?.error?.code, errorType].includes('context_length_exceeded')
        || messages.some(message => contextOverflowPattern.test(message)),
    };
  } catch {
    return { errorCode: null, errorType: null, contextOverflow: false };
  }
}

function readUpstreamBody(stream, limit = maxCapturedUpstreamErrorBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    stream.on('data', chunk => {
      const buffer = Buffer.from(chunk);
      if (bytes + buffer.length > limit) {
        const remaining = Math.max(0, limit - bytes);
        if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
        bytes = limit;
        truncated = true;
        return;
      }
      chunks.push(buffer);
      bytes += buffer.length;
    });
    stream.once('error', fail);
    stream.once('aborted', () => fail(new Error('Upstream response was aborted')));
    stream.once('close', () => fail(new Error('Upstream response closed before it ended')));
    stream.once('end', () => {
      if (settled) return;
      settled = true;
      resolve({ body: Buffer.concat(chunks), bytes, truncated });
    });
  });
}

function isMessageForRole(item, role) {
  return item?.role === role && (item.type == null || item.type === 'message');
}

function compactOpenRouterHistory(input, requestBytes) {
  if (!Array.isArray(input)
      || (requestBytes <= openrouterRecoveryCompactBytes
        && input.length <= openrouterRecoveryCompactItems)) {
    return { input, changed: false, droppedItems: 0, strategy: null };
  }

  const lastUserIndex = input.findLastIndex(item => isMessageForRole(item, 'user'));
  const lastDeveloperIndex = input.findLastIndex(item => isMessageForRole(item, 'developer'));
  // The current developer context and task statement always survive, even
  // when the rest of the latest turn has to be cut to a recent tail.
  const pinned = [...new Set([lastDeveloperIndex, lastUserIndex])].filter(index => index >= 0);
  const itemBytes = index => Buffer.byteLength(JSON.stringify(input[index]) ?? '');
  let itemBudget = openrouterRecoveryCompactItems - pinned.length;
  let byteBudget = pinned.reduce((budget, index) => budget - itemBytes(index), openrouterRecoveryCompactBytes);

  let start = input.length;
  while (start > lastUserIndex + 1 && itemBudget > 0) {
    const bytes = itemBytes(start - 1);
    if (bytes > byteBudget && start < input.length) break;
    itemBudget -= 1;
    byteBudget -= bytes;
    start -= 1;
  }

  const retainedIndexes = new Set(pinned);
  for (let index = start; index < input.length; index += 1) retainedIndexes.add(index);
  const compacted = input.filter((_item, index) => retainedIndexes.has(index));
  return {
    input: compacted,
    changed: compacted.length !== input.length,
    droppedItems: input.length - compacted.length,
    strategy: lastUserIndex >= 0 && start === lastUserIndex + 1 ? 'latest-user-turn' : 'recent-tail',
  };
}

function prepareOpenRouterRecovery(parsed, primaryBody) {
  // `parsed` already carries the OpenRouter state, reasoning, and tool-history
  // normalization, so the retry only changes which history items are sent.
  // Encrypted reasoning is bound to the provider that produced it; drop it
  // instead of resending the same opaque payload.
  const input = Array.isArray(parsed.input)
    ? parsed.input.filter(item => !(item?.type === 'reasoning' && item.encrypted_content))
    : parsed.input;
  const droppedReasoningItems = Array.isArray(input) ? parsed.input.length - input.length : 0;
  const compacted = compactOpenRouterHistory(input, primaryBody.length);
  const repaired = normalizeToolHistoryForOpenRouter(compacted.input);
  const body = Buffer.from(JSON.stringify({ ...parsed, input: repaired.input }));
  return {
    body,
    changed: !body.equals(primaryBody),
    compactionStrategy: compacted.changed ? compacted.strategy : null,
    droppedItems: compacted.droppedItems,
    droppedReasoningItems,
    inputItems: Array.isArray(repaired.input) ? repaired.input.length : null,
    historyRepairs: repaired.repairs,
  };
}

function sendSyntheticResponse(response, requestId, diagnostic, finalEvents) {
  const responseId = `resp_router_${requestId.replaceAll('-', '')}`;
  const events = [
    {
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        status: 'in_progress',
        output: [],
      },
    },
    ...finalEvents(responseId),
  ];
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-codex-router-diagnostic': diagnostic,
  });
  for (const event of events) {
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function sendResponsesDiagnostic(response, requestId) {
  // Omit usage so Codex keeps its last real token accounting.
  sendSyntheticResponse(response, requestId, 'openrouter-request-rejected', responseId => [
    {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        id: responseId.replace(/^resp_/, 'msg_'),
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: openrouterRejectedDiagnostic }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        status: 'completed',
        end_turn: true,
      },
    },
  ]);
}

function sendContextOverflow(response, requestId) {
  // Codex maps this code to its context-window error, which drives compaction.
  sendSyntheticResponse(response, requestId, 'openrouter-context-overflow', responseId => [
    {
      type: 'response.failed',
      response: {
        id: responseId,
        object: 'response',
        status: 'failed',
        error: { code: 'context_length_exceeded', message: openrouterContextOverflowMessage },
      },
    },
  ]);
}

function modelList() {
  try {
    const catalog = JSON.parse(readFileSync(modelCatalogFile, 'utf8'));
    return {
      object: 'list',
      data: (catalog.models || []).map(model => ({ id: model.slug, object: 'model' })),
    };
  } catch {
    return { object: 'list', data: [] };
  }
}

const server = http.createServer((request, response) => {
  const requestId = randomUUID();
  const requestStartedAt = Date.now();
  const requestInfo = {
    requestId,
    method: request.method,
    path: request.url,
    model: null,
    sessionId: typeof request.headers.session_id === 'string'
      && request.headers.session_id.length <= 256
      ? request.headers.session_id
      : null,
  };
  let clientClosed = false;
  let upstreamFailed = false;
  response.once('finish', () => {
    const status = response.statusCode || null;
    logEvent(status !== null && status >= 400 ? 'error' : 'info', 'request.finished', {
      ...requestInfo,
      status,
      durationMs: Date.now() - requestStartedAt,
    });
  });
  response.once('close', () => {
    if (!response.writableFinished && !upstreamFailed) {
      clientClosed = true;
      logEvent('info', 'request.aborted', {
        ...requestInfo,
        durationMs: Date.now() - requestStartedAt,
      });
    }
  });
  request.on('error', () => response.destroy());
  const localPort = request.socket?.localPort || port;
  if (![`127.0.0.1:${localPort}`, `localhost:${localPort}`].includes(request.headers.host)
      || request.headers.origin !== undefined
      || (request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'none')) {
    sendJson(response, 403, { error: { message: 'Only local CLI requests are supported' } });
    return;
  }
  if (request.method === 'GET' && ['/health', '/v1/health'].includes(request.url)) {
    sendJson(response, 200, {
      ok: true,
      openai: true,
      openrouter: Boolean(openrouterApiKey),
      clientAuth: true,
      revision: routerRevision,
      capabilities: {
        routingPolicies: ['preserve-model-v1'],
        openrouterRejectionRecovery: 'completed-diagnostic-v1',
        revisionPrecondition: true,
      },
    });
    return;
  }

  if (!isAuthenticated(request.headers)) {
    sendJson(response, 401, { error: { message: 'Invalid or missing router token; rerun the installer and restart Codex' } });
    return;
  }

  const expectedRevision = request.headers['x-codex-router-revision'];
  if (expectedRevision !== undefined) {
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      sendJson(response, 400, { error: { code: 'invalid_router_revision', message: 'Expected a lowercase SHA-256 router revision' } });
      return;
    }
    if (expectedRevision !== routerRevision) {
      sendJson(response, 409, { error: { code: 'router_revision_mismatch', message: 'The running router revision differs from the requested revision' } });
      return;
    }
  }

  if (request.method === 'GET' && ['/models', '/v1/models'].includes(request.url)) {
    sendJson(response, 200, modelList());
    return;
  }

  if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(request.url)) {
    sendJson(response, 404, { error: { message: `Unsupported route: ${request.method} ${request.url}` } });
    return;
  }

  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] || '')) {
    sendJson(response, 415, { error: { message: 'Content-Type must be application/json' } });
    return;
  }

  const chunks = [];
  let receivedBytes = 0;
  let rejected = false;
  request.on('data', chunk => {
    if (rejected) return;
    receivedBytes += chunk.length;
    if (receivedBytes > maxBodyBytes) {
      rejected = true;
      response.once('finish', () => request.destroy());
      sendJson(response, 413, { error: { message: 'Request body exceeds the unified router limit' } });
      return;
    }
    chunks.push(chunk);
  });

  request.on('end', () => {
    if (rejected || response.destroyed) return;
    const startedAt = Date.now();
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      sendJson(response, 400, { error: { message: `Invalid JSON request: ${error.message}` } });
      return;
    }

    if (!validRequest(parsed)) {
      sendJson(response, 400, { error: { message: 'Expected a JSON object with a model string and valid input, reasoning, and text fields' } });
      return;
    }

    const requestedModel = parsed.model;
    requestInfo.model = requestedModel;
    const routingPolicy = request.headers['x-codex-routing-policy'];
    if (routingPolicy !== undefined && routingPolicy !== 'preserve-model-v1') {
      sendJson(response, 400, { error: { message: 'Unsupported routing policy' } });
      return;
    }
    let model = requestedModel;
    let target = routeFor(model);
    let fallbackReason = null;
    let stateReset = false;

    if (target.provider === 'openrouter' && hasStructuredOutput(parsed)) {
      if (routingPolicy === 'preserve-model-v1') {
        sendJson(response, 422, { error: {
          code: 'model_substitution_forbidden',
          message: 'This route cannot honor structured output without substituting the model. Use text output and validate locally.',
        } });
        return;
      }
      model = structuredFallbackModel;
      target = routeFor(model);
      if (target.provider !== 'openai') {
        sendJson(response, 500, {
          error: { message: 'Structured-output fallback must resolve to an OpenAI model' },
        });
        return;
      }
      parsed.model = model;
      fallbackReason = 'openrouter_structured_output_unsupported';
    }

    const upstreamModel = upstreamModelFor(model, target.provider);
    let toolHistoryRepairs = null;
    let providerOrder = null;
    if (target.provider === 'openrouter') {
      // Fallbacks stay enabled so an endpoint outage degrades to a cache miss.
      if (providerOrders.has(upstreamModel) && parsed.provider === undefined) {
        providerOrder = providerOrders.get(upstreamModel);
        parsed.provider = { order: providerOrder };
      }
      stateReset = normalizeStateForOpenRouter(parsed);
      normalizeReasoningForOpenRouter(parsed.reasoning, upstreamModel);
      const normalizedHistory = normalizeToolHistoryForOpenRouter(parsed.input);
      parsed.input = normalizedHistory.input;
      toolHistoryRepairs = normalizedHistory.repairs;
    } else {
      parsed.input = normalizeInputForOpenAI(parsed.input);
    }
    parsed.model = upstreamModel;
    let body;
    try {
      body = Buffer.from(JSON.stringify(parsed));
    } catch (error) {
      sendJson(response, 400, { error: { message: `Unable to encode request: ${error.message}` } });
      return;
    }

    if (toolHistoryRepairs?.changed) {
      logEvent('info', 'history.repaired', {
        requestId, sessionId: requestInfo.sessionId, model: upstreamModel, ...toolHistoryRepairs,
      });
    }

    let currentUpstream;
    let upstreamErrorLogged = false;
    let recoveryAttempted = false;
    const upstreamError = error => {
      if (clientClosed || response.writableFinished || upstreamErrorLogged) return;
      upstreamFailed = true;
      upstreamErrorLogged = true;
      logEvent('error', 'upstream.error', {
        requestId,
        sessionId: requestInfo.sessionId,
        provider: target.provider,
        model,
        errorCode: error.code || null,
        durationMs: Date.now() - startedAt,
      });
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else sendJson(response, 502, { error: { message: 'Unified router upstream request failed' } });
    };

    response.once('close', () => {
      if (!response.writableFinished && currentUpstream && !currentUpstream.destroyed) {
        currentUpstream.destroy();
      }
    });

    const sendUpstream = ({
      requestBody,
      attempt,
      recovery = null,
    }) => {
      let headers;
      try {
        headers = upstreamHeaders(request.headers, target.provider, requestBody.length);
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: { message: error.message } });
        return;
      }

      const requestHash = payloadHash(requestBody);
      const upstreamInputItems = Array.isArray(parsed.input) ? parsed.input.length : null;
      logEvent('info', 'request.forwarded', {
        requestId,
        sessionId: requestInfo.sessionId,
        provider: target.provider,
        model,
        upstreamModel,
        requestedModel,
        fallbackReason,
        providerOrder,
        stateReset,
        routingPolicy: routingPolicy || 'default',
        bytes: requestBody.length,
        inputItems: recovery?.inputItems ?? upstreamInputItems,
        payloadSha256: requestHash,
        attempt,
        recoveryStrategy: recovery?.compactionStrategy || null,
        droppedItems: recovery?.droppedItems || 0,
        droppedReasoningItems: recovery?.droppedReasoningItems || 0,
        historyRepairs: attempt === 1
          ? (toolHistoryRepairs?.changed ? toolHistoryRepairs : null)
          : (recovery?.historyRepairs?.changed ? recovery.historyRepairs : null),
      });

      let upstream;
      try {
        upstream = target.protocol.request({
          hostname: target.hostname,
          path: target.path,
          method: 'POST',
          headers,
          timeout: 300000,
        }, upstreamResponse => {
          if (response.destroyed) {
            upstreamResponse.destroy();
            return;
          }
          const status = upstreamResponse.statusCode || null;
          const trace = upstreamTrace(upstreamResponse.headers);
          upstreamResponse.once('error', () => {
            if (!clientClosed) upstreamFailed = true;
          });
          upstreamResponse.once('close', () => {
            if (!clientClosed && !upstreamResponse.readableEnded) upstreamFailed = true;
          });

          logEvent(status !== null && status >= 400 ? 'error' : 'info', 'upstream.response_started', {
            requestId,
            sessionId: requestInfo.sessionId,
            provider: target.provider,
            model,
            status,
            timeToHeadersMs: Date.now() - startedAt,
            attempt,
            payloadSha256: requestHash,
            ...trace,
          });

          if (target.provider === 'openrouter' && status === 400) {
            void (async () => {
              const upstreamBody = await readUpstreamBody(upstreamResponse);
              logEvent('error', 'upstream.response_finished', {
                requestId,
                sessionId: requestInfo.sessionId,
                provider: target.provider,
                model,
                status,
                durationMs: Date.now() - startedAt,
                attempt,
                payloadSha256: requestHash,
                ...trace,
              });

              const capture = captureRejectedRequest({
                requestId,
                attempt,
                requestBody,
                responseBody: upstreamBody.body,
              });
              const upstreamErrorDetails = parseUpstreamError(upstreamBody.body);
              logEvent('error', 'openrouter.request_rejected', {
                requestId,
                sessionId: requestInfo.sessionId,
                model,
                upstreamModel,
                status,
                attempt,
                payloadSha256: requestHash,
                bytes: requestBody.length,
                inputItems: recovery?.inputItems ?? upstreamInputItems,
                recoveryStrategy: recovery?.compactionStrategy || null,
                droppedItems: recovery?.droppedItems || 0,
                upstreamErrorCode: upstreamErrorDetails.errorCode,
                upstreamErrorType: upstreamErrorDetails.errorType,
                upstreamErrorSha256: payloadHash(upstreamBody.body),
                upstreamErrorBytes: upstreamBody.bytes,
                upstreamErrorTruncated: upstreamBody.truncated,
                contextOverflow: upstreamErrorDetails.contextOverflow,
                capture,
                ...trace,
              });

              if (clientClosed || response.destroyed) return;
              if (upstreamErrorDetails.contextOverflow) {
                // Let Codex compact the thread itself instead of silently
                // retrying with history the router chose to discard.
                sendContextOverflow(response, requestId);
                return;
              }
              if (!recoveryAttempted) {
                const recovery = prepareOpenRouterRecovery(parsed, body);
                if (recovery.changed) {
                  recoveryAttempted = true;
                  logEvent('info', 'openrouter.recovery_attempt', {
                    requestId,
                    sessionId: requestInfo.sessionId,
                    model,
                    upstreamModel,
                    attempt: 2,
                    previousPayloadSha256: requestHash,
                    payloadSha256: payloadHash(recovery.body),
                    bytes: recovery.body.length,
                    inputItems: recovery.inputItems,
                    compactionStrategy: recovery.compactionStrategy,
                    droppedItems: recovery.droppedItems,
                    droppedReasoningItems: recovery.droppedReasoningItems,
                    historyRepairs: recovery.historyRepairs?.changed ? recovery.historyRepairs : null,
                  });
                  sendUpstream({ requestBody: recovery.body, attempt: 2, recovery });
                  return;
                }
              }

              if (clientClosed || response.destroyed) return;
              logEvent('error', 'openrouter.fallback_completion', {
                requestId,
                sessionId: requestInfo.sessionId,
                model,
                upstreamModel,
                attempt,
                payloadSha256: requestHash,
                ...trace,
              });
              sendResponsesDiagnostic(response, requestId);
            })().catch(error => upstreamError(error));
            return;
          }

          response.writeHead(status || 502, responseHeaders(upstreamResponse.headers));
          pipeline(upstreamResponse, response, error => {
            if (error) {
              upstream.destroy();
              upstreamError(error);
            }
          });
          upstreamResponse.on('end', () => {
            if (clientClosed || upstreamFailed) return;
            logEvent(status !== null && status >= 400 ? 'error' : 'info', 'upstream.response_finished', {
              requestId,
              sessionId: requestInfo.sessionId,
              provider: target.provider,
              model,
              status,
              durationMs: Date.now() - startedAt,
              attempt,
              payloadSha256: requestHash,
              ...trace,
            });
          });
        });

        currentUpstream = upstream;
        upstream.on('timeout', () => upstream.destroy(new Error('Upstream request timed out')));
        upstream.on('error', upstreamError);
        upstream.end(requestBody);
      } catch (error) {
        upstream?.destroy();
        upstreamError(error);
      }
    };

    sendUpstream({ requestBody: body, attempt: 1 });
  });
});

server.listen(port, host, () => {
  logEvent('info', 'router.ready', {
    host,
    port,
    openrouterConfigured: Boolean(openrouterApiKey),
    revision: routerRevision,
  });
});

function shutdown(signal) {
  logEvent('info', 'router.shutdown', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
