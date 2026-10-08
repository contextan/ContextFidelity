import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
export function currentBuildId() {
  return createHash('sha256').update(['src/config.js', 'src/workspaces.js', 'src/client.js', 'src/client.html', 'src/server.js', 'src/auth.js', 'src/provider.js', 'src/pipeline.js', 'src/context-ai.js', 'src/context-usage.js', 'src/store.js', 'src/localization.js', 'locales/en.json'].map(p => readFileSync(new URL('../' + p, import.meta.url))).join('')).digest('hex').slice(0, 12);
}
