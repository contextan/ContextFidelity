// Build answer receipts only from immutable inputs captured at request time.
// Never look up the latest context or decision version to describe an old answer.
export function contextUsage(run) {
  const input = run?.snapshots?.findLast(s => s.phase === 'correction' && s.call_status === 'completed')
    || run?.snapshots?.find(s => s.phase === 'generation' && s.call_status === 'completed');
  if (!input) return null;
  const parse = b => { try { return JSON.parse(b.content); } catch { return {}; } };
  const scope = parse(input.blocks.find(b => b.key === 'PROJECT_SCOPE') || {});
  return {
    snapshot_id: input.id, phase: input.phase, model: input.model,
    topics: scope.topics || [],
    current_question: (() => { const q = input.blocks.find(b => b.key === 'CURRENT_QUESTION'); return q ? { content: q.content, source_id: q.source_id } : null; })(),
    captured_at: input.created_at,
    contexts: input.blocks.filter(b => b.context_id).map(b => ({ ...parse(b), id: b.context_id, source_id: b.source_id, version: b.version })),
    decisions: input.blocks.filter(b => b.decision_id && !b.key.startsWith('ORIGINAL:')).map(b => ({ ...parse(b), id: b.decision_id, source_id: b.source_id, version: b.version })),
    history: input.blocks.filter(b => b.key.startsWith('HISTORY:')).map(b => ({ ...parse(b), source_id: b.source_id })),
    correction_evidence: input.blocks.filter(b => b.key.startsWith('ORIGINAL:')).map(b => ({ ...parse(b), source_id: b.source_id })),
  };
}
