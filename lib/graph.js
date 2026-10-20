/**
 * 兰台·簿 · 图谱 (skill graph).
 *
 * What this is NOT: a code knowledge graph. The nodes are skills, the edges are
 * relationships that can be *proven from the text*, and the point is not to draw a
 * pretty picture — it is to answer "which of these should stop being true".
 *
 * Measured on a real seven-skill collection, naive edge inference produced exactly
 * one edge and it was wrong (`node` shared by two unrelated skills). So the model
 * here is deliberately two-layered:
 *
 *   theme edges   skill ──belongs──▶ theme ──contains──▶ skill   (multi-membership)
 *   structural    conflicts / shared-path / shared-option / references / same-session
 *
 * Themes are grown from the collection's own vocabulary, never from a preset list,
 * because a preset list would impose the author's world on the user's skills.
 */
import { compareSkills, extractOptions, extractPaths, extractSnippets, triggerSimilarity } from './conflicts.js';

/** Words that appear in almost every technical skill and therefore carry no signal. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'then', 'than', 'into',
  'node', 'npm', 'pnpm', 'git', 'bash', 'shell', 'cmd', 'powershell', 'true', 'false',
  'https', 'http', 'com', 'org', 'cn', 'github', 'file', 'path', 'line', 'text',
  '的', '了', '和', '与', '在', '是', '用', '到', '把', '被', '就', '也', '都', '而',
  // Code fragments and over-generic words: they recur everywhere and classify nothing.
  'get', 'set', 'use', 'run', 'try', 'url', 'api', 'json', 'yaml', 'string', 'value',
  'name', 'type', 'data', 'item', 'list', 'code', 'text', 'main', 'index', 'test', 'tests',
  '一个', '这个', '那个', '可以', '如果', '因为', '所以', '但是', '或者', '然后',
]);

/**
 * Multi-word terms are kept whole (`dsh-plugin`, `http.sslBackend`); single words
 * are kept only when they are Latin and not a stopword. Chinese prose yields no
 * single-character themes — a fragment of a sentence is not a topic.
 */
function termCandidates(text) {
  // Split on name separators first, so `dsh-plugin-tool-contract` yields its four
  // segments, then take the natural-language words from the summary.
  const segments = text
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term) && /^[a-z]/.test(term));
  const multi = text.match(/[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+/g) ?? [];
  return [...multi, ...segments];
}
const MIN_THEME_SIZE = 2;
const MIN_TERM_LENGTH = 3;

/** Strip code fences so prose vocabulary is not drowned by command words. */
function proseOnly(body) {
  return String(body ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/**
 * Candidate theme names: terms that recur across several skills. Multi-word terms
 * are kept as written (`dsh-plugin`, `http.sslBackend`), single words are accepted
 * only when they are not stopwords.
 */
export function candidateThemes(skills) {
  const documentFrequency = new Map();
  for (const skill of skills) {
    // Terms come from the human-written summary only. Body text is full of command
    // fragments ("try", "url", "合并走") that are not topics; a theme has to be a
    // domain noun somebody chose while summarising the skill.
    const text = `${skill.description ?? ''} ${skill.whenToUse ?? ''}`.toLowerCase();
    const terms = new Set(termCandidates(text));
    for (const term of terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  return [...documentFrequency.entries()]
    .filter(([, count]) => count >= MIN_THEME_SIZE)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Which skills belong to each candidate theme. */
export function themes(skills) {
  const candidates = candidateThemes(skills);
  const result = [];
  for (const [term, count] of candidates) {
    const members = skills
      .filter((skill) => {
        const text = `${skill.description ?? ''} ${skill.whenToUse ?? ''}`.toLowerCase();
        return text.includes(term);
      })
      .map((skill) => skill.name);
    if (members.length >= MIN_THEME_SIZE) result.push({ term, count, members });
  }
  return result;
}

function overlap(setA, setB) {
  const shared = [];
  for (const item of setA) if (setB.has(item)) shared.push(item);
  return shared;
}

/**
 * Structural edges that can be proven from text alone — no 兰台 metadata required,
 * so an imported collection works the same as a home-grown one.
 */
export function structuralEdges(skills) {
  const edges = [];
  const fingerprints = skills.map((skill) => {
    const snippets = extractSnippets(skill.body ?? '');
    return {
      name: skill.name,
      paths: extractPaths(snippets),
      options: extractOptions(snippets),
      mentions: new Set(skills.filter((other) => other.name !== skill.name).map((other) => other.name)),
    };
  });

  for (let i = 0; i < fingerprints.length; i += 1) {
    for (let j = i + 1; j < fingerprints.length; j += 1) {
      const a = fingerprints[i];
      const b = fingerprints[j];

      const sharedPaths = overlap(a.paths, b.paths);
      if (sharedPaths.length > 0) {
        edges.push({ from: a.name, to: b.name, kind: 'shared-path', evidence: sharedPaths.slice(0, 5) });
      }

      const sharedOptions = [];
      for (const [key, values] of a.options) {
        const other = b.options.get(key);
        if (!other) continue;
        sharedOptions.push(`${key}=${[...values].join('|')}`);
      }
      if (sharedOptions.length > 0) {
        edges.push({ from: a.name, to: b.name, kind: 'shared-option', evidence: sharedOptions.slice(0, 5) });
      }

      const similarity = triggerSimilarity(skills[i], skills[j]);
      if (similarity >= 0.34) {
        edges.push({ from: a.name, to: b.name, kind: 'related-trigger', evidence: [`相似度 ${similarity.toFixed(2)}`] });
      }

      const conflicts = compareSkills(skills[i], skills[j]);
      if (conflicts.length > 0) {
        edges.push({
          from: a.name,
          to: b.name,
          kind: 'conflicts',
          evidence: conflicts.map((conflict) => `${conflict.kind}: ${conflict.evidence.join(' / ')}`).slice(0, 4),
        });
      }
    }
  }

  // Cross-references: one skill names another in its body.
  for (const skill of skills) {
    const body = String(skill.body ?? '');
    for (const other of skills) {
      if (other.name === skill.name) continue;
      if (!body.includes(other.name)) continue;
      edges.push({ from: skill.name, to: other.name, kind: 'references', evidence: [`正文提到 ${other.name}`] });
    }
  }

  // Same distillation session: two skills learned from one incident are cousins.
  for (let i = 0; i < skills.length; i += 1) {
    for (let j = i + 1; j < skills.length; j += 1) {
      const session = skills[i].session;
      if (!session || session !== skills[j].session) continue;
      edges.push({
        from: skills[i].name,
        to: skills[j].name,
        kind: 'same-session',
        evidence: [`同一次蒸馏: ${session}`],
      });
    }
  }

  return edges;
}

/**
 * Skills that belong to no theme and connect to nothing: candidates for archiving.
 *
 * Only *strong* edges count as a connection. Sharing a path, a trigger or a common
 * means two skills were written on the same machine — three unrelated skills that
 * all mention `--check` are not related. Strong means: distilled from the same
 * session, naming each other, or contradicting each other.
 */
const STRONG_EDGE_KINDS = new Set(['same-session', 'references', 'conflicts']);

export function orphans(skills, themeList, edges) {
  const touched = new Set();
  for (const theme of themeList) for (const member of theme.members) touched.add(member);
  for (const edge of edges) {
    if (!STRONG_EDGE_KINDS.has(edge.kind)) continue;
    touched.add(edge.from);
    touched.add(edge.to);
  }
  return skills.map((skill) => skill.name).filter((name) => !touched.has(name));
}

/** Coverage per theme: how thin is each area of knowledge. */
export function coverage(skills, themeList) {
  return themeList.map((theme) => ({
    theme: theme.term,
    skills: theme.members.length,
    names: theme.members,
    thin: theme.members.length <= MIN_THEME_SIZE,
  }));
}

export function buildGraph(skills) {
  const usable = skills.filter((skill) => !skill.error && typeof skill.body === 'string');
  const themeList = themes(usable);
  const edges = structuralEdges(usable);
  const orphanNames = orphans(usable, themeList, edges);
  return {
    nodes: usable.map((skill) => ({ name: skill.name, stage: skill.stage ?? 0, source: skill.source ?? 'imported' })),
    themes: themeList,
    // `edges` stays structural only. Membership lives in `themes`, and counting it
    // twice made the report say "21 edges" for a collection with zero real links.
    edges,
    themeLinks: themeList.reduce((total, theme) => total + theme.members.length, 0),
    orphans: orphanNames,
    coverage: coverage(usable, themeList),
  };
}

const MERMAID_SAFE = /[^\w\u4e00-\u9fa5-]/g;
const nodeId = (name) => `s_${name.replace(MERMAID_SAFE, '_')}`;
const themeId = (term) => `t_${term.replace(MERMAID_SAFE, '_')}`;

/** Mermaid `graph LR`: themes in the middle, skills hanging off them. */
export function toMermaid(graph, { maxThemes = 8 } = {}) {
  const lines = ['graph LR'];
  for (const name of graph.nodes.map((node) => node.name)) {
    lines.push(`  ${nodeId(name)}["${name}"]`);
  }
  for (const theme of graph.themes.slice(0, maxThemes)) {
    lines.push(`  ${themeId(theme.term)}(["${theme.term}"])`);
    for (const member of theme.members) {
      lines.push(`  ${nodeId(member)} -.-> ${themeId(theme.term)}`);
    }
  }
  for (const edge of graph.edges) {
    if (edge.kind === 'related-trigger' || edge.kind === 'references') continue;
    const arrow = edge.kind === 'conflicts' ? '==' : '-->';
    lines.push(`  ${nodeId(edge.from)} ${arrow}|${edge.kind}| ${nodeId(edge.to)}`);
  }
  return lines.join('\n');
}
