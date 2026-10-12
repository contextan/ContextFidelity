import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const defaultPath = existsSync('data/contextfidelity.sqlite') || !existsSync('data/contextpulse.sqlite') ? 'data/contextfidelity.sqlite' : 'data/contextpulse.sqlite';
const path = resolve(process.argv[2] || defaultPath);
const db = new DatabaseSync(path, { readOnly: true });
const counts = Object.fromEntries(['projects','sessions','messages','decisions','contexts','context_candidates','runs','snapshots','call_results'].map(t => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
const mismatches = db.prepare('SELECT id,hash,payload FROM snapshots').all().filter(s => createHash('sha256').update(s.payload).digest('hex') !== s.hash).map(s => s.id);
const forwardHistory = [];
for (const s of db.prepare("SELECT s.id,s.blocks,r.user_message_id FROM snapshots s JOIN runs r ON r.id=s.run_id WHERE s.phase IN ('generation','correction')").all()) {
  const current = db.prepare('SELECT rowid FROM messages WHERE id=?').get(s.user_message_id)?.rowid;
  for (const b of JSON.parse(s.blocks).filter(b => b.key.startsWith('HISTORY:'))) if (db.prepare('SELECT rowid FROM messages WHERE id=?').get(b.source_id)?.rowid >= current) forwardHistory.push(s.id);
}
const report = { checked_at: new Date().toISOString(), counts, integrity: db.prepare('PRAGMA integrity_check').all().map(v => v.integrity_check), foreign_key_violations: db.prepare('PRAGMA foreign_key_check').all().length, snapshot_hash_mismatches: mismatches, future_messages_in_history: forwardHistory, file_mode: (statSync(path).mode & 0o777).toString(8), running_requests: db.prepare("SELECT COUNT(*) n FROM runs WHERE status='running'").get().n };
db.close();
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.integrity.some(v => v !== 'ok') || report.foreign_key_violations || mismatches.length || forwardHistory.length) process.exitCode = 1;
