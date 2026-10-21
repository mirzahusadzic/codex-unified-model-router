import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const muse = JSON.parse(readFileSync(new URL('../catalog/muse-model.json', import.meta.url), 'utf8'));

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
