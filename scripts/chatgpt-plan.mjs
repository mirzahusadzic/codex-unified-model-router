import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Print `active`, `inactive`, or `unknown` for the ChatGPT plan in Codex's
// login. The claims are a snapshot from Codex's last token refresh, so only a
// clearly lapsed or missing ChatGPT login reports `inactive`. Tokens are never
// printed.
const [codexHome] = process.argv.slice(2);
if (!codexHome) {
  console.error('Usage: chatgpt-plan.mjs <codex-home>');
  process.exit(2);
}

function planStatus() {
  const file = join(codexHome, 'auth.json');
  if (!existsSync(file)) return 'inactive';
  let auth;
  try {
    auth = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return 'unknown';
  }
  const idToken = auth?.tokens?.id_token;
  if (typeof idToken !== 'string') return 'inactive';
  let claims;
  try {
    claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return 'unknown';
  }
  const until = Date.parse(claims?.['https://api.openai.com/auth']?.chatgpt_subscription_active_until ?? '');
  if (Number.isNaN(until)) return 'unknown';
  return until > Date.now() ? 'active' : 'inactive';
}

console.log(planStatus());
