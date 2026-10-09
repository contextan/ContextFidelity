import { readFileSync, writeFileSync } from 'node:fs';
import { currentBuildId } from '../src/build-id.js';
import { systemText } from '../src/localization.js';

const root = new URL('../', import.meta.url);
const client = readFileSync(new URL('src/client.js', root), 'utf8').replace('__CONTEXT_PULSE_BUILD__', currentBuildId());
const shell = readFileSync(new URL('src/client.html', root), 'utf8');
const enClient = systemText(client);
const enShell = systemText(shell).replace('lang="ko"', 'lang="en"');
const missing = (enClient + enShell).match(/[^\n]{0,40}[가-힣][^\n]{0,70}/g);
if (missing) throw new Error(`Missing English interface copy:\n${[...new Set(missing)].join('\n')}`);
for (const [locale, source] of [['en', enClient], ['ko', client]]) {
  try { new Function(source); }
  catch (error) { throw new Error(`Invalid ${locale} client bundle: ${error.message}`); }
}
writeFileSync(new URL('public/app.js', root), enClient);
writeFileSync(new URL('public/app.ko.js', root), client);
writeFileSync(new URL('public/index.html', root), enShell);
writeFileSync(new URL('public/index.ko.html', root), shell.replace('src="/app.js"', 'src="/app.ko.js"'));
console.log('Built English and Korean interfaces from the shared client source.');
