import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOpenRouterPrompts, readPrompts, usesOpenRouterPrompts } from './openrouter-prompts.mjs';

// Compare installed OpenRouter entries with the prompts this checkout would install.
const [codexHome] = process.argv.slice(2);
if (!codexHome) throw new Error('Usage: verify-prompts.mjs <codex-home>');
const root = fileURLToPath(new URL('../', import.meta.url));
const prompts = readPrompts(join(root, 'prompts', 'openrouter-instructions.md'),
  join(root, 'prompts', 'openrouter-persistent.md'));
const installed = new Map(JSON.parse(readFileSync(join(codexHome, 'models.json'), 'utf8')).models
  .map(model => [model.slug, model]));

let checked = 0;
for (const name of readdirSync(join(root, 'catalog')).filter(value => value.endsWith('.json'))) {
  const value = JSON.parse(readFileSync(join(root, 'catalog', name), 'utf8'));
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (!usesOpenRouterPrompts(entry.slug)) continue;
    const model = installed.get(entry.slug);
    if (!model) throw new Error(`The installed catalog lacks ${entry.slug}; rerun the installer`);
    const expected = applyOpenRouterPrompts(entry, prompts);
    if (model.base_instructions !== expected.base_instructions
        || model.model_messages?.instructions_template !== expected.model_messages.instructions_template
        || model.model_messages?.persistent_instructions !== expected.model_messages.persistent_instructions) {
      throw new Error(`Installed prompts for ${entry.slug} differ from the repository; rerun the installer`);
    }
    checked += 1;
  }
}
if (checked === 0) throw new Error('No OpenRouter catalog entries were checked');
