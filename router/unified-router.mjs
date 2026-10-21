import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
const openrouterApiKey = process.env.OPENROUTER_API_KEY || fileEnvironment.OPENROUTER_API_KEY || '';
const routerToken = process.env.CODEX_ROUTER_TOKEN || fileEnvironment.CODEX_ROUTER_TOKEN || '';
if (!/^[a-f0-9]{64}$/.test(routerToken)) {
  throw new Error('A 64-character hex CODEX_ROUTER_TOKEN is required; rerun the installer');
}

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

function normalizeReasoningForOpenRouter(value) {
  if (!value || typeof value !== 'object' || value.effort == null) return;
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
  response.once('finish', () => {
    logEvent('info', 'request.finished', {
      ...requestInfo,
      status: response.statusCode || null,
      durationMs: Date.now() - requestStartedAt,
    });
  });
  response.once('close', () => {
    if (!response.writableFinished) {
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
      capabilities: { routingPolicies: ['preserve-model-v1'], revisionPrecondition: true },
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
      sendJson(response, 413, { error: { message: 'Request body exceeds the unified router limit' } });
      request.destroy();
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
      fallbackReason = 'deepseek_structured_output_unsupported';
    }

    const upstreamModel = upstreamModelFor(model, target.provider);
    let toolHistoryRepairs = null;
    if (target.provider === 'openrouter') {
      stateReset = normalizeStateForOpenRouter(parsed);
      normalizeReasoningForOpenRouter(parsed.reasoning);
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

    let headers;
    try {
      headers = upstreamHeaders(request.headers, target.provider, body.length);
    } catch (error) {
      sendJson(response, error.statusCode || 500, { error: { message: error.message } });
      return;
    }

    if (toolHistoryRepairs?.changed) {
      logEvent('info', 'history.repaired', {
        requestId, sessionId: requestInfo.sessionId, model: upstreamModel, ...toolHistoryRepairs,
      });
    }
    logEvent('info', 'request.forwarded', {
      requestId,
      sessionId: requestInfo.sessionId,
      provider: target.provider,
      model,
      upstreamModel,
      requestedModel,
      fallbackReason,
      stateReset,
      routingPolicy: routingPolicy || 'default',
      bytes: body.length,
      inputItems: Array.isArray(parsed.input) ? parsed.input.length : null,
      historyRepairs: toolHistoryRepairs?.changed ? toolHistoryRepairs : null,
    });

    let upstream;
    const upstreamError = error => {
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
        response.writeHead(upstreamResponse.statusCode || 502, responseHeaders(upstreamResponse.headers));
        pipeline(upstreamResponse, response, error => {
          if (error) {
            upstream.destroy();
            upstreamError(error);
          }
        });
        logEvent(status !== null && status >= 400 ? 'error' : 'info', 'upstream.response_started', {
          requestId,
          sessionId: requestInfo.sessionId,
          provider: target.provider,
          model,
          status,
          timeToHeadersMs: Date.now() - startedAt,
          ...trace,
        });
        upstreamResponse.on('end', () => {
          logEvent(status !== null && status >= 400 ? 'error' : 'info', 'upstream.response_finished', {
            requestId,
            sessionId: requestInfo.sessionId,
            provider: target.provider,
            model,
            status,
            durationMs: Date.now() - startedAt,
            ...trace,
          });
        });
      });

      upstream.on('timeout', () => upstream.destroy(new Error('Upstream request timed out')));
      upstream.on('error', upstreamError);
      response.on('close', () => {
        if (!response.writableFinished && !upstream.destroyed) upstream.destroy();
      });
      upstream.end(body);
    } catch (error) {
      upstream?.destroy();
      upstreamError(error);
    }
  });
});

server.listen(port, host, () => {
  logEvent('info', 'router.ready', { host, port, openrouterConfigured: Boolean(openrouterApiKey) });
});

function shutdown(signal) {
  logEvent('info', 'router.shutdown', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
