import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const host = '127.0.0.1';
const port = Number(process.env.CODEX_ROUTER_PORT || 18766);
const envFile = process.env.CODEX_ROUTER_ENV_FILE || join(homedir(), '.codex', 'unified-router', 'openrouter.env');
const modelCatalogFile = process.env.CODEX_MODEL_CATALOG || join(homedir(), '.codex', 'models.json');
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

// Native OpenAI models and models that train on their inputs never share a
// Codex session. Spawned agents reuse their parent's session ID, so the rule
// covers whole agent trees: OpenAI output never reaches a training tier, and
// training-tier output never reaches OpenAI. Claude models are kept apart from
// the training tier the same way, since Anthropic's terms bar using Claude's
// output to train competing models; Claude and OpenAI may share a session.
// Ultra Spark counts as training because its workers run on Muse. The list can
// be extended, not disabled.
const trainingModels = new Set(['meta/muse-spark-1.3-contributor', ...String(
  process.env.CODEX_ROUTER_TRAINING_MODELS || fileEnvironment.CODEX_ROUTER_TRAINING_MODELS || '',
).split(',').map(model => model.trim()).filter(Boolean)]);
const sessionSidesFile = join(dirname(envFile), 'session-sides.json');
const sessionSideRetentionMs = 30 * 24 * 60 * 60 * 1000;
// Requests refresh a session's record at most daily, so active sessions never expire.
const sessionSideRefreshMs = 24 * 60 * 60 * 1000;

function loadSessionSides() {
  try {
    const stored = JSON.parse(readFileSync(sessionSidesFile, 'utf8'));
    const cutoff = Date.now() - sessionSideRetentionMs;
    return new Map(Object.entries(stored).filter(([, entry]) => Object.hasOwn(sideNames, entry?.side)
      && entry.at > cutoff));
  } catch {
    return new Map();
  }
}
// Sides other than `training` are protected from it; they may share a session.
const sideNames = {
  openai: 'a native OpenAI model',
  anthropic: 'a Claude model',
  training: 'a model whose provider trains on its inputs',
};
const sessionSides = loadSessionSides();

function sessionSide(requestedModel, provider, upstreamModel) {
  if (provider === 'openai') return 'openai';
  if (requestedModel.startsWith('ultra-spark/') || trainingModels.has(upstreamModel)) return 'training';
  if (upstreamModel.startsWith('anthropic/')) return 'anthropic';
  return null;
}

function recordSessionSide(sessionId, side) {
  const cutoff = Date.now() - sessionSideRetentionMs;
  for (const [id, entry] of sessionSides) if (entry.at <= cutoff) sessionSides.delete(id);
  sessionSides.set(sessionId, { side, at: Date.now() });
  try {
    const temporary = `${sessionSidesFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(sessionSides)), { mode: 0o600 });
    renameSync(temporary, sessionSidesFile);
  } catch (error) {
    logEvent('error', 'session.isolation_persist_failed', { errorCode: error.code || null });
  }
}

// Ultra Spark workers must start with fork_context: false, but only the prompt
// asks for that. Codex gives a session's main thread a thread ID equal to the
// session ID, and each spawned agent its own thread ID. The router remembers
// the tool call IDs in Ultra Spark requests from a main thread and refuses a
// Muse or other training-tier request from a spawned agent in the same session
// that carries one of them: that request holds the lead's forked history. A
// fork before the lead's first tool call carries no known ID and is not
// detected. Records are in memory only and keep each session's most recent
// IDs; after a restart the check resumes with the lead's next request.
// Requests without a session or thread ID are not checked.
const leadCallIds = new Map();
const maxLeadSessions = 256;
const maxLeadCallIdsPerSession = 4096;
const maxCallIdLength = 256;

function callIdsIn(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(item => (item?.type === 'function_call' || item?.type === 'function_call_output')
      && typeof item.call_id === 'string' && item.call_id.length > 0 && item.call_id.length <= maxCallIdLength)
    .map(item => item.call_id);
}

function recordLeadCallIds(sessionId, input) {
  const ids = leadCallIds.get(sessionId) ?? new Set();
  leadCallIds.delete(sessionId);
  leadCallIds.set(sessionId, ids);
  for (const id of callIdsIn(input)) {
    ids.delete(id);
    ids.add(id);
  }
  for (const id of ids) {
    if (ids.size <= maxLeadCallIdsPerSession) break;
    ids.delete(id);
  }
  for (const id of leadCallIds.keys()) {
    if (leadCallIds.size <= maxLeadSessions) break;
    leadCallIds.delete(id);
  }
}

function forkedLeadCallIds(sessionId, input) {
  const ids = leadCallIds.get(sessionId);
  if (!ids) return 0;
  return new Set(callIdsIn(input).filter(id => ids.has(id))).size;
}

const openrouterRejectedDiagnostic = '[router diagnostic] OpenRouter rejected this step. The thread is intact; retry or start a new thread.';
const openrouterContextOverflowMessage = 'The conversation exceeds the OpenRouter model context window.';
const openrouterRecoveryCompactBytes = 1024 * 1024;
const openrouterRecoveryCompactItems = 80;
// Codex sends its context as a developer message followed by user messages
// (injected AGENTS.md and environment context). A new thread opens with it; a
// compacted thread lists its retained user messages first and places the
// context just before the compaction summary. A compacted retry keeps that
// block, from the first developer message, up to this many items.
const openrouterRecoveryContextItems = 16;
const openrouterRecoveryOmissionNotice = '[router note] The provider rejected this thread\'s full history, so this retry omits earlier conversation items. The thread\'s context and instructions, the latest user message, and the most recent items are kept. Treat anything else from earlier in the thread as unknown: re-read files and re-check state before relying on it, and ask the user if an earlier decision matters.';
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

// OpenRouter slugs: `deepseek/` and `openrouter/<vendor>/<model>`, plus the
// `ultra-spark/` alias, which selects DeepSeek with the delegation policy.
const openrouterPrefixes = ['deepseek/', 'openrouter/', 'ultra-spark/'];

function routeFor(model) {
  if (typeof model === 'string' && openrouterPrefixes.some(prefix => model.startsWith(prefix))) {
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
  if (provider !== 'openrouter' || typeof model !== 'string') return model;
  if (model.startsWith('openrouter/')) return model.slice('openrouter/'.length);
  if (model.startsWith('ultra-spark/')) return `deepseek/${model.slice('ultra-spark/'.length)}`;
  return model;
}

// DeepSeek's endpoint offers JSON mode but rejects JSON schemas. Request JSON
// mode and append the schema as the final instruction, which keeps the cached
// prompt prefix intact. Other models receive the schema unchanged.
function adaptStructuredOutputForDeepSeek(request, model) {
  const format = request.text?.format;
  if (!model.startsWith('deepseek/') || format?.type !== 'json_schema') return null;
  request.text = { ...request.text, format: { type: 'json_object' } };
  const name = typeof format.name === 'string' && format.name ? ` named ${format.name}` : '';
  const instruction = {
    type: 'message',
    role: 'developer',
    content: [{
      type: 'input_text',
      text: `Respond with only a JSON object${name} that conforms to this JSON schema:\n${JSON.stringify(format.schema ?? {})}`,
    }],
  };
  if (Array.isArray(request.input)) request.input = [...request.input, instruction];
  else if (typeof request.input === 'string') request.input = [{ role: 'user', content: request.input }, instruction];
  else request.input = [instruction];
  return instruction;
}

// DeepSeek accepts only low, high, max, and none. Other efforts round up to the
// next accepted level, so `minimal` keeps some reasoning instead of turning it
// off. Other OpenRouter models take OpenRouter's standard efforts, which it
// translates for each provider.
function normalizeReasoningForOpenRouter(value, model) {
  if (!value || typeof value !== 'object' || value.effort == null || !model.startsWith('deepseek/')) return;
  const effort = String(value.effort);
  if (['low', 'high', 'max', 'none'].includes(effort)) return;
  value.effort = effort === 'minimal' ? 'low' : effort === 'medium' ? 'high' : 'max';
}

// Claude caches a prompt only at a cache_control breakpoint, and OpenRouter's
// Responses API exposes only the top-level form, which places the breakpoint
// on the last cacheable block and moves it as the thread grows. Without it,
// every step bills the whole history at the full input price.
function addClaudePromptCaching(request, model) {
  if (!model.startsWith('anthropic/') || request.cache_control !== undefined) return false;
  request.cache_control = { type: 'ephemeral' };
  return true;
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
    droppedToolDeclarations: 0,
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

  const validCallId = id => typeof id === 'string' && id.length > 0;
  const callIds = new Set(runs.flatMap(run => run.calls.map(call => call.item.call_id)).filter(validCallId));
  const outputsByCallId = new Map();
  for (const [index, item] of input.entries()) {
    if (item?.type !== 'function_call_output') continue;
    if (!callIds.has(item.call_id)) {
      repairs.droppedOrphanOutputs += 1;
      continue;
    }
    if (outputsByCallId.has(item.call_id)) repairs.droppedDuplicateOutputs += 1;
    // The latest output is the most useful observation if an interrupted turn
    // left more than one result for the same call ID.
    outputsByCallId.set(item.call_id, { index, item });
  }

  // When a call ID repeats, keep the occurrence the output answers: the last
  // one before it. Other items stay in their original order.
  const retainedByCallId = new Map();
  for (const run of runs) {
    for (const call of run.calls) {
      const id = call.item.call_id;
      if (!validCallId(id)) {
        repairs.droppedInvalidCalls += 1;
        continue;
      }
      if (!retainedByCallId.has(id)) {
        retainedByCallId.set(id, call.index);
        continue;
      }
      repairs.droppedDuplicateCalls += 1;
      const output = outputsByCallId.get(id);
      if (!output || call.index < output.index) retainedByCallId.set(id, call.index);
    }
  }
  for (const id of retainedByCallId.keys()) {
    if (!outputsByCallId.has(id)) {
      repairs.droppedUnansweredCalls += 1;
      retainedByCallId.delete(id);
    }
  }
  const retainedCallIndexes = new Set(retainedByCallId.values());

  const normalized = [];
  const runsByStart = new Map(runs.map(run => [run.start, run]));
  for (let index = 0; index < input.length;) {
    const run = runsByStart.get(index);
    if (run) {
      const calls = run.calls.filter(call => retainedCallIndexes.has(call.index));
      normalized.push(...calls.map(call => call.item));
      for (const call of calls) {
        const output = outputsByCallId.get(call.item.call_id);
        if (output) normalized.push(output.item);
      }
      index = run.end + 1;
      continue;
    }
    // Codex 0.164 records Responses Lite tool declarations in the history of
    // threads that used a native model. OpenRouter rejects these items, and the
    // request's `tools` field already declares the selected model's tools.
    if (input[index]?.type === 'additional_tools') repairs.droppedToolDeclarations += 1;
    else if (input[index]?.type !== 'function_call_output') normalized.push(input[index]);
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
    // Codex 0.163 sends hyphenated session headers; earlier versions used
    // session_id and conversation_id.
    allowed.push('authorization', 'chatgpt-account-id', 'openai-beta', 'originator',
      'version', 'session-id', 'thread-id', 'session_id', 'conversation_id', 'x-request-id',
      'x-client-request-id', 'x-codex-window-id', 'x-codex-turn-metadata', 'x-codex-turn-state',
      'x-codex-beta-features', 'x-openai-internal-codex-responses-lite');
  }
  const headers = Object.fromEntries(allowed
    .filter(name => requestHeaders[name] !== undefined)
    .map(name => [name, requestHeaders[name]]));
  headers['content-length'] = String(bodyLength);
  headers['accept-encoding'] = 'identity';
  headers['content-type'] = 'application/json';

  if (provider === 'openrouter') {
    if (!openrouterApiKey) {
      const error = new Error('OPENROUTER_API_KEY is not configured for the Codex Unified Model Router');
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

// File modes do not restrict access on Windows, so captures go only into the
// router directory itself: the installer gives it a protected current-user ACL
// that new files inherit, which a subdirectory could override.
export function captureDirectoryAllowed(directory, routerDirectory, platform = process.platform) {
  if (platform !== 'win32') return true;
  return resolve(directory).toLowerCase() === resolve(routerDirectory).toLowerCase();
}

function captureRejectedRequest({
  requestId, attempt, requestBody, responseBody,
}) {
  if (!rejectedRequestDir) return null;
  if (!captureDirectoryAllowed(rejectedRequestDir, dirname(envFile))) {
    logEvent('error', 'openrouter.rejection_capture_refused', {
      requestId, attempt, reason: 'not_private_router_directory',
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
    const succeed = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    stream.on('data', chunk => {
      const buffer = Buffer.from(chunk);
      if (bytes + buffer.length > limit) {
        const remaining = Math.max(0, limit - bytes);
        if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
        bytes = limit;
        truncated = true;
        succeed({ body: Buffer.concat(chunks), bytes, truncated });
        stream.destroy();
        return;
      }
      chunks.push(buffer);
      bytes += buffer.length;
    });
    stream.once('error', fail);
    stream.once('aborted', () => fail(new Error('Upstream response was aborted')));
    stream.once('close', () => fail(new Error('Upstream response closed before it ended')));
    stream.once('end', () => succeed({ body: Buffer.concat(chunks), bytes, truncated }));
  });
}

// A Responses stream ends with a response.completed, response.incomplete, or
// response.failed event whose response carries the token usage. The tap reads
// it as chunks pass through, without holding any back. It buffers one SSE line
// at a time, up to a bound, and parses only a line that names a final event
// type, wherever the type appears in it: JSON does not fix property order, and
// OpenRouter sends no `event:` lines. It runs only at `info` level.
const usageLogging = logLevels[configuredLogLevel] >= logLevels.info;
const finalEventTypes = new Set(['response.completed', 'response.incomplete', 'response.failed']);
const finalEventPattern = /"type"\s*:\s*"response\.(?:completed|incomplete|failed)"/;
const maxEventLineChars = 16 * 1024 * 1024;

// Only numbers are kept, one level deep, so usage can never carry content.
function tokenCounts(usage) {
  if (!isObject(usage)) return null;
  const counts = {};
  for (const [name, value] of Object.entries(usage)) {
    if (typeof value === 'number' && Number.isFinite(value)) counts[name] = value;
    else if (isObject(value)) {
      const nested = Object.fromEntries(Object.entries(value)
        .filter(([, item]) => typeof item === 'number' && Number.isFinite(item)));
      if (Object.keys(nested).length > 0) counts[name] = nested;
    }
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

function usageTap(onUsage) {
  const decoder = new StringDecoder('utf8');
  let line = '';
  let overflow = false;
  const endLine = () => {
    if (!overflow && line.startsWith('data:') && finalEventPattern.test(line)) {
      try {
        const event = JSON.parse(line.slice('data:'.length));
        const usage = finalEventTypes.has(event?.type) ? tokenCounts(event.response?.usage) : null;
        if (usage) onUsage({ responseStatus: event.response.status ?? null, usage });
      } catch {
        // A malformed final event leaves nothing to log.
      }
    }
    line = '';
    overflow = false;
  };
  const scan = text => {
    for (let start = 0; start < text.length;) {
      const end = text.indexOf('\n', start);
      if (!overflow) {
        line += end === -1 ? text.slice(start) : text.slice(start, end);
        if (line.length > maxEventLineChars) {
          overflow = true;
          line = '';
        }
      }
      if (end === -1) break;
      endLine();
      start = end + 1;
    }
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        scan(decoder.write(chunk));
      } catch {
        overflow = true;
        line = '';
      }
      callback(null, chunk);
    },
    flush(callback) {
      try {
        scan(decoder.end());
        endLine();
      } catch {
        // Logging never affects the response.
      }
      callback();
    },
  });
}

function isMessageForRole(item, role) {
  return item?.role === role && (item.type == null || item.type === 'message');
}

function completeToolPairs(input, retainedIndexes) {
  const calls = new Map();
  const outputs = new Map();
  for (const [index, item] of input.entries()) {
    const target = item?.type === 'function_call' ? calls
      : item?.type === 'function_call_output' ? outputs : null;
    if (!target || typeof item.call_id !== 'string' || item.call_id.length === 0) continue;
    if (!target.has(item.call_id)) target.set(item.call_id, []);
    target.get(item.call_id).push(index);
  }
  const partners = new Map();
  for (const [callId, callIndexes] of calls) {
    const outputIndexes = outputs.get(callId);
    if (!outputIndexes) continue;
    for (const index of [...callIndexes, ...outputIndexes]) {
      if (!partners.has(index)) partners.set(index, []);
      partners.get(index).push(...callIndexes, ...outputIndexes);
    }
  }
  const completed = new Set(retainedIndexes);
  const pending = [...completed];
  while (pending.length > 0) {
    for (const index of partners.get(pending.pop()) || []) {
      if (completed.has(index)) continue;
      completed.add(index);
      pending.push(index);
    }
  }
  return completed;
}

function codexContextIndexes(input) {
  const indexes = [];
  const first = Math.max(input.findIndex(item => isMessageForRole(item, 'developer')), 0);
  for (let index = first; index < input.length; index += 1) {
    if (indexes.length >= openrouterRecoveryContextItems) break;
    if (!['developer', 'system', 'user'].some(role => isMessageForRole(input[index], role))) break;
    indexes.push(index);
  }
  return indexes;
}

function omissionNotice() {
  return {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: openrouterRecoveryOmissionNotice }],
  };
}

function compactOpenRouterHistory(input, requestBytes) {
  if (!Array.isArray(input)
      || (requestBytes <= openrouterRecoveryCompactBytes
        && input.length <= openrouterRecoveryCompactItems)) {
    return { input, changed: false, droppedItems: 0, strategy: null, omissionNotice: false };
  }

  const lastUserIndex = input.findLastIndex(item => isMessageForRole(item, 'user'));
  const lastDeveloperIndex = input.findLastIndex(item => isMessageForRole(item, 'developer'));
  const context = codexContextIndexes(input);
  // Codex's context, the current developer context and the task statement
  // always survive, even when the rest of the latest turn has to be cut to a
  // recent tail. Dropping Codex's context would remove the rules the thread
  // runs under (AGENTS.md among them) and any compaction summary for this step.
  const pinned = new Set([...context, lastDeveloperIndex, lastUserIndex].filter(index => index >= 0));
  const itemBytes = index => Buffer.byteLength(JSON.stringify(input[index]) ?? '');
  const notice = omissionNotice();
  // Reserve room for the omission notice so the retry stays within both limits.
  let itemBudget = openrouterRecoveryCompactItems - pinned.size - 1;
  let byteBudget = [...pinned].reduce((budget, index) => budget - itemBytes(index),
    openrouterRecoveryCompactBytes - Buffer.byteLength(JSON.stringify(notice)));

  let start = input.length;
  let taken = 0;
  while (start > lastUserIndex + 1 && itemBudget > 0) {
    const index = start - 1;
    // A pinned item inside the tail is already counted against the budgets.
    if (pinned.has(index)) {
      start -= 1;
      continue;
    }
    const bytes = itemBytes(index);
    if (bytes > byteBudget && taken > 0) break;
    itemBudget -= 1;
    byteBudget -= bytes;
    taken += 1;
    start -= 1;
  }

  const selectedIndexes = new Set(pinned);
  for (let index = start; index < input.length; index += 1) selectedIndexes.add(index);
  // Selecting a tail can begin between a tool call and its output. Restore both
  // sides before normalization, which would otherwise discard the orphan.
  const retainedIndexes = completeToolPairs(input, selectedIndexes);
  const compacted = input.filter((_item, index) => retainedIndexes.has(index));
  const droppedItems = input.length - compacted.length;
  // Tell the model its view is partial, right after Codex's context, so it
  // does not mistake missing history for history that never happened.
  if (droppedItems > 0) {
    compacted.splice(context.length > 0 ? compacted.indexOf(input[context.at(-1)]) + 1 : 0, 0, notice);
  }
  return {
    input: compacted,
    changed: droppedItems > 0,
    droppedItems,
    strategy: lastUserIndex >= 0 && start === lastUserIndex + 1 ? 'latest-user-turn' : 'recent-tail',
    omissionNotice: droppedItems > 0,
  };
}

function prepareOpenRouterRecovery(parsed, primaryBody, structuredOutputInstruction) {
  // `parsed` already carries the OpenRouter state, reasoning, and tool-history
  // normalization, so the retry only changes which history items are sent.
  // Encrypted reasoning is bound to the provider that produced it; drop it
  // instead of resending the same opaque payload.
  let input = parsed.input;
  let schemaInstruction = null;
  if (Array.isArray(input) && structuredOutputInstruction && input.at(-1) === structuredOutputInstruction) {
    schemaInstruction = input.at(-1);
    input = input.slice(0, -1);
  }
  input = Array.isArray(input)
    ? input.filter(item => !(item?.type === 'reasoning' && item.encrypted_content))
    : input;
  const droppedReasoningItems = Array.isArray(input) ? parsed.input.length - input.length - (schemaInstruction ? 1 : 0) : 0;
  const compacted = compactOpenRouterHistory(input, primaryBody.length);
  const repaired = normalizeToolHistoryForOpenRouter(compacted.input);
  const recoveryInput = Array.isArray(repaired.input) && schemaInstruction
    ? [...repaired.input, schemaInstruction] : repaired.input;
  const body = Buffer.from(JSON.stringify({ ...parsed, input: recoveryInput }));
  return {
    body,
    changed: !body.equals(primaryBody),
    compactionStrategy: compacted.changed ? compacted.strategy : null,
    droppedItems: compacted.droppedItems,
    omissionNotice: compacted.omissionNotice,
    droppedReasoningItems,
    inputItems: Array.isArray(recoveryInput) ? recoveryInput.length : null,
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
    sessionId: null,
  };
  // Codex 0.163 sends `session-id`; earlier versions sent `session_id`.
  const suppliedSessionId = request.headers['session-id'] ?? request.headers.session_id;
  if (typeof suppliedSessionId === 'string' && suppliedSessionId.length <= 256) requestInfo.sessionId = suppliedSessionId;
  // Codex 0.163 sends `thread-id`; earlier versions sent `conversation_id`.
  const suppliedThreadId = request.headers['thread-id'] ?? request.headers.conversation_id;
  const threadId = typeof suppliedThreadId === 'string' && suppliedThreadId.length <= 256 ? suppliedThreadId : null;
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
        providerIsolation: 'session-v2',
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
      sendJson(response, 413, { error: { message: 'Request body exceeds the Codex Unified Model Router limit' } });
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
    // The router never substitutes another model, including for structured
    // output; preserve-model-v1 remains accepted for clients that send it.
    const model = requestedModel;
    const target = routeFor(model);
    let stateReset = false;
    let structuredOutputAdapted = false;
    let structuredOutputInstruction = null;

    const upstreamModel = upstreamModelFor(model, target.provider);
    const side = sessionSide(requestedModel, target.provider, upstreamModel);
    const recorded = requestInfo.sessionId ? sessionSides.get(requestInfo.sessionId) : undefined;
    if (side && requestInfo.sessionId) {
      if (recorded && (recorded.side === 'training') !== (side === 'training')) {
        logEvent('error', 'session.provider_isolation', {
          requestId, sessionId: requestInfo.sessionId, model: requestedModel, recordedSide: recorded.side, side,
        });
        sendJson(response, 409, { error: {
          code: 'provider_isolation',
          message: side === 'training'
            ? `This session already used ${sideNames[recorded.side]}, and this model's provider trains on its inputs. Start a new thread to use it.`
            : `This session already used ${sideNames.training}. Start a new thread to use ${sideNames[side]}.`,
        } });
        return;
      }
      if (!recorded) recordSessionSide(requestInfo.sessionId, side);
    }
    if (recorded && Date.now() - recorded.at > sessionSideRefreshMs) {
      recordSessionSide(requestInfo.sessionId, recorded.side);
    }
    if (requestInfo.sessionId && threadId) {
      const ultraSpark = requestedModel.startsWith('ultra-spark/');
      if (threadId === requestInfo.sessionId) {
        if (ultraSpark) recordLeadCallIds(requestInfo.sessionId, parsed.input);
      } else if (side === 'training' && !ultraSpark) {
        const forkedCallIds = forkedLeadCallIds(requestInfo.sessionId, parsed.input);
        if (forkedCallIds > 0) {
          logEvent('error', 'session.forked_lead_context', {
            requestId, sessionId: requestInfo.sessionId, model: requestedModel, forkedCallIds,
          });
          sendJson(response, 409, { error: {
            code: 'forked_lead_context',
            message: 'This worker request carries the Ultra Spark lead thread\'s history, and its provider trains on its inputs. Spawn workers with fork_context: false.',
          } });
          return;
        }
      }
    }
    let toolHistoryRepairs = null;
    let providerOrder = null;
    let promptCachingAdded = false;
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
      structuredOutputInstruction = adaptStructuredOutputForDeepSeek(parsed, upstreamModel);
      structuredOutputAdapted = Boolean(structuredOutputInstruction);
      promptCachingAdded = addClaudePromptCaching(parsed, upstreamModel);
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
      else sendJson(response, 502, { error: { message: 'Codex Unified Model Router upstream request failed' } });
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
        structuredOutputAdapted,
        promptCachingAdded,
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
                const recovery = prepareOpenRouterRecovery(parsed, body, structuredOutputInstruction);
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
                    omissionNotice: recovery.omissionNotice,
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
          const streams = [upstreamResponse, response];
          if (usageLogging && status >= 200 && status < 300
              && /^text\/event-stream/i.test(upstreamResponse.headers?.['content-type'] || '')) {
            streams.splice(1, 0, usageTap(({ responseStatus, usage }) => logEvent('info', 'upstream.usage', {
              requestId,
              sessionId: requestInfo.sessionId,
              provider: target.provider,
              model,
              upstreamModel,
              attempt,
              responseStatus,
              usage,
              ...trace,
            })));
          }
          pipeline(...streams, error => {
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
