import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const contextOverflowPattern = /context[ _-]?(?:length|window)|maximum context|too many tokens|prompt is too long/i;

// The largest event or SSE line the router reads before it stops parsing a stream.
export const maxEventLineChars = 16 * 1024 * 1024;

// The router's revision covers its entry file and every module beside it, so
// the installed copy (where the entry is named router.mjs) and the repository
// copy hash the same way. The health verifier uses this function too.
export function routerRevision(entryFile) {
  const directory = dirname(entryFile);
  const modules = readdirSync(directory).filter(name => name.endsWith('.mjs') && name !== basename(entryFile)).sort();
  const hash = createHash('sha256').update(readFileSync(entryFile));
  for (const name of modules) hash.update(`\0${name}\0`).update(readFileSync(join(directory, name)));
  return hash.digest('hex');
}
