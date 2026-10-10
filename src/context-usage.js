import { systemText } from './localization.js';

function localizedSelectionReason(reason, locale, included) {
  if (typeof reason !== 'string' || locale !== 'en' || !/[가-힣]/u.test(reason)) return reason;
  const score = reason.match(/^SQLite FTS5 (?:키워드·주제 )?점수 (\d+)% · 기준 (\d+)% (이상|미달 또는 상위 후보 제한)$/u);
  if (score) return included
    ? `SQLite FTS5 keyword/topic score ${score[1]}% · threshold ${score[2]}%`
    : `SQLite FTS5 keyword/topic score ${score[1]}% · below threshold ${score[2]}% or outside the candidate limit`;
  if (reason.startsWith('SQLite FTS5 키워드 일치 없음')) return 'No SQLite FTS5 keyword match above the threshold';
  // Older receipts may contain a Korean selector explanation. Preserve the
  // frozen request, but show a truthful localized summary in the English UI.
  return systemText(included ? '질문 의미로 자동 선택' : '질문 의미로 자동 제외', locale);
}

// Build answer receipts only from immutable inputs captured at request time.
// Never look up the latest context or decision version to describe an old answer.
export function contextUsage(run, locale = 'ko') {
  const input = run?.snapshots?.findLast(s => s.phase === 'correction' && s.call_status === 'completed')
    || run?.snapshots?.find(s => s.phase === 'generation' && s.call_status === 'completed');
  if (!input) return null;
  const parse = block => { try { return JSON.parse(block?.content || '{}'); } catch { return {}; } };
  const scope = parse(input.blocks.find(block => block.key === 'PROJECT_SCOPE'));
  const selection = parse(input.blocks.find(block => block.key === 'CONTEXT_SELECTION'));
  const retrievalScores = new Map((selection.search?.scores || selection.search?.candidates || []).map(item => [item.context_id, item]));
  const rawExcluded = Array.isArray(input.excluded)
    ? input.excluded
    : (() => { try { return JSON.parse(input.excluded || '[]'); } catch { return []; } })();

  const injectedContexts = input.blocks.filter(block => block.context_id).map(block => {
    const value = parse(block);
    return {
      ...value,
      selection_reason: localizedSelectionReason(value.selection_reason, locale, true),
      id: block.context_id,
      source_id: block.source_id,
      version: block.version,
      scope: block.scope || value.scope,
      topics: block.topics || value.topics || [],
      override: block.override || 'auto',
      retrieval: retrievalScores.get(block.context_id) || null,
      injected: true,
      entry_type: 'context',
    };
  });
  const injectedDecisions = input.blocks.filter(block => block.decision_id && !block.key.startsWith('ORIGINAL:')).map(block => ({
    ...parse(block),
    id: block.decision_id,
    source_id: block.source_id,
    version: block.version,
    scope: block.scope || parse(block).scope,
    topics: parse(block).topics || [],
    injected: true,
    entry_type: 'conversation',
  }));
  const injectedHistory = input.blocks.filter(block => block.key.startsWith('HISTORY:')).map(block => ({
    ...parse(block),
    source_id: block.source_id,
    topics: block.topics || [],
    injected: true,
    entry_type: 'history',
  }));
  const excludedContexts = rawExcluded.filter(item => item.type === 'context').map(item => ({
    id: item.id,
    root_id: item.root_id,
    source_id: item.source_id,
    title: item.title,
    content: item.content,
    kind: item.kind || 'reference',
    scope: item.scope || 'topic',
    status: item.status,
    override: item.override || 'auto',
    include_mode: item.include_mode || 'auto',
    topics: item.topics || [],
    version: item.version,
    retrieval: retrievalScores.get(item.id) || null,
    selection_reason: localizedSelectionReason(item.reason, locale, false),
    injected: false,
    entry_type: 'context',
  }));
  const excludedDecisions = rawExcluded.filter(item => item.type === 'decision').map(item => ({
    id: item.id,
    source_id: item.source_id,
    content: item.content,
    scope: item.scope || 'topic',
    status: item.status,
    topics: item.topics || [],
    version: item.version,
    selection_reason: systemText(item.reason, locale),
    injected: false,
    entry_type: 'conversation',
  }));
  const excludedHistory = rawExcluded.filter(item => item.type === 'message').map(item => ({
    id: item.id,
    source_id: item.source_id || item.id,
    role: item.role,
    content: item.content,
    topics: item.topics || [],
    selection_reason: systemText(item.reason, locale),
    injected: false,
    entry_type: 'history',
  }));

  const questionTopics = Array.isArray(scope.topics) ? scope.topics : [];
  const projectLabel = systemText('프로젝트 전체', locale);
  const unsortedLabel = systemText('주제 미지정', locale);
  const groups = new Map();
  const ensureGroup = (topic, groupScope = 'topic') => {
    if (!groups.has(topic)) groups.set(topic, { topic, scope: groupScope, injected_items: [], excluded_items: [] });
    return groups.get(topic);
  };

  for (const topic of questionTopics) ensureGroup(topic);
  const addToGroups = (items, target) => {
    for (const item of items) {
      const topics = Array.isArray(item.topics) ? item.topics : [];
      const projectWide = item.scope === 'project';
      const labels = projectWide ? [projectLabel] : topics.length ? topics : [unsortedLabel];
      for (const topic of labels) {
        const group = ensureGroup(topic, projectWide ? 'project' : 'topic');
        group[target].push(item);
      }
    }
  };

  addToGroups(injectedContexts, 'injected_items');
  addToGroups(injectedDecisions, 'injected_items');
  addToGroups(injectedHistory, 'injected_items');
  addToGroups(excludedContexts, 'excluded_items');
  addToGroups(excludedDecisions, 'excluded_items');
  addToGroups(excludedHistory, 'excluded_items');

  const topicClusters = [...groups.values()].map(group => {
    const questionMatched = group.scope !== 'project' && questionTopics.includes(group.topic);
    const included = group.injected_items.length;
    const excluded = group.excluded_items.length;
    return {
      ...group,
      question_matched: questionMatched,
      matched: questionMatched,
      included_count: included,
      excluded_count: excluded,
      reason: group.scope === 'project'
        ? systemText('프로젝트 전체 범위', locale)
        : questionMatched
          ? systemText('질문 주제와 일치', locale)
          : systemText('질문 주제 범위 밖', locale),
    };
  });

  return {
    snapshot_id: input.id,
    phase: input.phase,
    model: input.model,
    topics: questionTopics,
    current_question: (() => {
      const question = input.blocks.find(block => block.key === 'CURRENT_QUESTION');
      return question ? { content: question.content, source_id: question.source_id } : null;
    })(),
    captured_at: input.created_at,
    selection_mode: selection.mode === 'fts5' ? 'fts5' : selection.mode === 'semantic' ? 'semantic' : 'tags',
    search: selection.search || null,
    selection_warning: selection.warning || null,
    topic_clusters: topicClusters,
    contexts: injectedContexts,
    decisions: injectedDecisions,
    excluded_contexts: excludedContexts,
    excluded_decisions: excludedDecisions,
    excluded_history: excludedHistory,
    history: injectedHistory,
    correction_evidence: input.blocks.filter(block => block.key.startsWith('ORIGINAL:')).map(block => ({ ...parse(block), source_id: block.source_id })),
  };
}
