import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyOpenRouterPrompts, readPrompts, suffixField, usesOpenRouterPrompts } from '../scripts/openrouter-prompts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const readEntry = name => JSON.parse(readFileSync(join(root, 'catalog', name), 'utf8'));
const prompts = readPrompts(join(root, 'prompts', 'openrouter-instructions.md'),
  join(root, 'prompts', 'openrouter-persistent.md'));
const normalize = value => value.replace(/\r\n/g, '\n');
const muse = readEntry('muse-model.json');
const deepseek = readEntry('deepseek-model.json');
const ultraSpark = readEntry('deepseek-ultra-spark-model.json');

test('checked-in OpenRouter entries carry the rendered maintained prompts', () => {
  let checked = 0;
  for (const name of readdirSync(join(root, 'catalog')).filter(value => value.endsWith('.json'))) {
    const value = readEntry(name);
    for (const entry of Array.isArray(value) ? value : [value]) {
      assert.equal(typeof entry.slug, 'string', `${name}: missing model slug`);
      if (!usesOpenRouterPrompts(entry.slug)) continue;
      const expected = applyOpenRouterPrompts(entry, prompts);
      const stale = `${name}: run node scripts/render-openrouter-entries.mjs`;
      assert.equal(normalize(entry.base_instructions), normalize(expected.base_instructions), stale);
      assert.equal(normalize(entry.model_messages.instructions_template),
        normalize(expected.model_messages.instructions_template), stale);
      assert.equal(normalize(entry.model_messages.persistent_instructions),
        normalize(expected.model_messages.persistent_instructions), stale);
      checked += 1;
    }
  }
  assert.equal(checked, 3);
});

test('Muse Spark 1.3 Contributor catalog entry matches the OpenRouter model capabilities', () => {
  assert.equal(muse.slug, 'openrouter/meta/muse-spark-1.3-contributor');
  assert.equal(muse.context_window, 1048576);
  assert.equal(muse.max_context_window, 1048576);
  assert.equal(muse.effective_context_window_percent, 95);
  // Reasoning is mandatory upstream, so `none` must not be offered.
  assert.deepEqual(muse.supported_reasoning_levels.map(level => level.effort), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(muse.default_reasoning_level, 'medium');
  assert.equal(muse.supports_parallel_tool_calls, false);
  assert.match(muse.description, /Meta may train on prompts and completions/);
});

test('Ultra Spark is DeepSeek with a delegation policy that keeps thread history away from workers', () => {
  const identity = ['slug', 'display_name', 'description', 'priority', suffixField, 'base_instructions', 'model_messages'];
  const capabilities = entry => Object.fromEntries(Object.entries(entry).filter(([key]) => !identity.includes(key)));
  assert.equal(ultraSpark.slug, 'openrouter/deepseek/deepseek-v4.1-flash-1017');
  assert.equal(ultraSpark.display_name, 'DeepSeek V4.1 Flash 1017 · Ultra Spark');
  assert.deepEqual(capabilities(ultraSpark), capabilities(deepseek));
  assert.equal(ultraSpark[suffixField], 'ultra-spark.md');
  const policy = readFileSync(join(root, 'prompts', 'ultra-spark.md'), 'utf8');
  assert.match(policy, new RegExp(`model: "${muse.slug.replaceAll('.', '\\.')}"`));
  assert.match(policy, /fork_context: false/);
  assert.match(policy, /Never fork this thread's history into a worker/);
});

test('catalog builds append an entry suffix and omit the router-only field from Codex', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-catalog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'bundled.json'), '{"models":[]}\n');
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'build-catalog.mjs'),
    '--bundled', join(directory, 'bundled.json'), '--catalog-dir', join(root, 'catalog'),
    '--instructions', join(root, 'prompts', 'openrouter-instructions.md'),
    '--persistent', join(root, 'prompts', 'openrouter-persistent.md'),
    '--output', join(directory, 'models.json')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const models = new Map(JSON.parse(readFileSync(join(directory, 'models.json'), 'utf8')).models
    .map(model => [model.slug, model]));
  const policy = readFileSync(join(root, 'prompts', 'ultra-spark.md'), 'utf8');
  assert.equal(models.get(ultraSpark.slug).base_instructions, `${prompts.instructions}\n${policy}`);
  assert.equal(models.get(deepseek.slug).base_instructions, prompts.instructions);
  for (const model of models.values()) assert.equal(Object.hasOwn(model, suffixField), false);
});

test('prompt suffixes must name a file in the prompts directory', () => {
  for (const suffix of ['../secret.md', 'ultra-spark.txt', '/etc/passwd']) {
    assert.throws(() => applyOpenRouterPrompts({ slug: 'openrouter/vendor/model', [suffixField]: suffix }, prompts),
      /must name a \.md file/);
  }
});
