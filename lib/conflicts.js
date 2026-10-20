/**
 * 兰台 · 议 (conflict detection).
 *
 * Two skills that disagree are worse than one that is wrong: the agent follows
 * whichever it loaded, and the user never learns the other one objected.
 *
 * Everything here is a *deterministic* comparison over the text of a skill — token
 * overlap, extracted options, extracted commands, extracted paths. Nothing infers
 * meaning. Semantic contradictions ("prefer caching" vs "avoid caching") are out of
 * scope on purpose: a probabilistic judgement would poison a layer whose only value
 * is that it always gives the same answer.
 *
 * The report is advisory. It names both sides and the evidence, and never edits.
 */

const FENCED = /```[a-z]*\n([\s\S]*?)```/g;
const INLINE = /`([^`\n]{2,200})`/g;

/** Everything the skill presents as "do this" — fenced blocks and inline spans. */
export function extractSnippets(body) {
  const snippets = [];
  for (const match of body.matchAll(FENCED)) snippets.push(match[1]);
  for (const match of body.matchAll(INLINE)) snippets.push(match[1]);
  return snippets.map((snippet) => snippet.trim()).filter(Boolean)
    .map((snippet) => snippet);
}

/** Section heading a piece of text sits under, so we know if it is advice or a caveat. */
export function sectionOf(body, needle) {
  const index = body.indexOf(needle);
  if (index === -1) return null;
  const before = body.slice(0, index);
  const headings = [...before.matchAll(/^#{1,6}\s*(.+)$/gm)];
  if (headings.length === 0) return null;
  return headings[headings.length - 1][1].trim();
}

const NEGATION = /(不要|禁止|别用|避免|切勿|don't|do not|never|avoid)/i;

/**
 * `key=value` pairs and long-form flags.
 * `-c http.sslBackend=openssl` yields { key: 'http.sslbackend', value: 'openssl' }
 * and `--force` yields { key: '--force', value: 'true' }.
 */
export function extractOptions(snippets) {
  const options = new Map();
  for (const snippet of snippets) {
    for (const match of snippet.matchAll(/([A-Za-z][\w.-]*)=("([^"]*)"|'([^']*)'|([^\s"';|)]+))/g)) {
      const key = match[1].toLowerCase();
      const value = (match[3] ?? match[4] ?? match[5] ?? '').toLowerCase();
      if (!options.has(key)) options.set(key, new Set());
      options.get(key).add(value);
    }
    for (const match of snippet.matchAll(/(?<!\S)(--?[A-Za-z][\w-]*)/g)) {
      const key = match[1].toLowerCase();
      if (!options.has(key)) options.set(key, new Set());
      options.get(key).add('true');
    }
  }
  return options;
}

/** True when two command lines talk about the same thing, not merely the same binary. */
function sharesSubject(aLine, bLine, command) {
  const tokens = (line) =>
    new Set(
      line
        .toLowerCase()
        .split(/[^\w.-]+/)
        .filter((token) => token.length >= 3 && token !== command),
    );
  const aTokens = tokens(aLine);
  const bTokens = tokens(bLine);
  for (const token of aTokens) if (bTokens.has(token)) return true;
  return false;
}
/** First word of each command-looking snippet: `git`, `pnpm`, `node` … */
export function extractCommands(snippets) {
  const commands = new Map();
  for (const snippet of snippets) {
    for (const line of snippet.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([a-z][\w.-]*)\s/);
      if (!match) continue;
      const key = match[1].toLowerCase();
      if (!commands.has(key)) commands.set(key, new Set());
      commands.get(key).add(trimmed);
    }
  }
  return commands;
}

/** Conservative path extraction: things with a separator or a leading `~/`. */
export function extractPaths(snippets) {
  const paths = new Set();
  for (const snippet of snippets) {
    for (const match of snippet.matchAll(/(~?[\\/][^\s"'`;|)]{2,}|[A-Za-z]:[\\/][^\s"'`;|)]{2,})/g)) {
      paths.add(match[1].replace(/[.,:]+$/, ''));
    }
  }
  return paths;
}

function tokenSet(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fa5]+/u)
      .filter((token) => token.length >= 2),
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** How alike two skills' triggers are, 0..1. */
export function triggerSimilarity(a, b) {
  return jaccard(tokenSet(`${a.whenToUse ?? ''} ${a.description ?? ''}`), tokenSet(`${b.whenToUse ?? ''} ${b.description ?? ''}`));
}

const TRIGGER_SIMILARITY_THRESHOLD = 0.34;

/**
 * Compare one pair of skills.
 * @returns {Array<{kind: string, severity: 'high'|'medium', a: string, b: string, evidence: string[], suggestion: string}>}
 */
export function compareSkills(a, b) {
  const conflicts = [];
  const aSnippets = extractSnippets(a.body ?? '');
  const bSnippets = extractSnippets(b.body ?? '');

  // 1. Same option, different value.
  const aOptions = extractOptions(aSnippets);
  const bOptions = extractOptions(bSnippets);
  for (const [key, aValues] of aOptions) {
    const bValues = bOptions.get(key);
    if (!bValues) continue;
    const conflict = [...aValues].some((value) => !bValues.has(value)) && [...bValues].some((value) => !aValues.has(value));
    if (conflict) {
      conflicts.push({
        kind: 'option-value',
        severity: 'high',
        a: a.name,
        b: b.name,
        evidence: [`${key}=${[...aValues].join('|')} vs ${key}=${[...bValues].join('|')}`],
        suggestion: `两条 skill 给同一个开关设了不同的值（${key}）；确认哪一条仍然成立，归档另一条或改写它的边界节`,
      });
    }
  }

  // 2. A command one skill prescribes while the other forbids it.
  //
  // Pairing is per command word, and the *subject* is the shared token: `git status`
  // in one skill is not evidence about `git push --force` in another, so the two
  // lines must overlap on something beyond the command itself.
  //
  // Prohibitions are usually prose around a snippet ("`git push --force` 不要用"),
  // so each prescribed command is also checked against every *prose line* of the
  // other skill, not only against its code snippets.
  const aCommands = extractCommands(aSnippets);
  const bCommands = extractCommands(bSnippets);
  const prohibitions = new Map();
  for (const [owner, skillBody] of [
    [a, a.body ?? ''],
    [b, b.body ?? ''],
  ]) {
    for (const line of skillBody.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '' || !NEGATION.test(trimmed)) continue;
      // Prose tends to quote the command: "`git push --force` 不要用". Peel the
      // backticks off the start before looking for the command word.
      const bare = trimmed.replace(/^[`*_]+/, '');
      const match = bare.match(/^([a-z][\w.-]*)\s/);
      if (!match) continue;
      const key = match[1].toLowerCase();
      if (!prohibitions.has(key)) prohibitions.set(key, []);
      prohibitions.get(key).push({ owner, line: trimmed });
    }
  }
  for (const [command, aLines] of aCommands) {
    const bLines = bCommands.get(command);
    const pairs = [];
    if (bLines) {
      for (const aLine of aLines) for (const bLine of bLines) pairs.push([aLine, bLine, a, b]);
    }
    for (const prohibition of prohibitions.get(command) ?? []) {
      if (prohibition.owner === a) continue;
      for (const aLine of aLines) pairs.push([aLine, prohibition.line, a, b]);
    }
    if (pairs.length === 0) continue;
    for (const [aLine, bLine] of pairs) {
      if (aLine === bLine) continue;
      if (!sharesSubject(aLine, bLine, command)) continue;
      const aNegative = NEGATION.test(aLine);
      const bNegative = NEGATION.test(bLine);
      if (aNegative === bNegative) continue;
      const negativeSide = aNegative ? a : b;
      const negativeHeading = sectionOf(negativeSide.body ?? '', aNegative ? aLine : bLine);
      const inBoundary = negativeHeading !== null && /(边界|禁止|注意|不宜|不要|never|avoid|don't)/i.test(negativeHeading);
      conflicts.push({
        kind: 'command-contrast',
        severity: inBoundary ? 'high' : 'medium',
        a: a.name,
        b: b.name,
        evidence: [`${a.name}: ${aLine}`, `${b.name}: ${bLine}`],
        suggestion: inBoundary
          ? `一条把 \`${command}\` 当做法，另一条在「${negativeHeading}」里否定它；这通常是真的矛盾`
          : `两条对 \`${command}\` 的说法一正一反，确认是否针对不同场景，若是则在边界节写清分工`,
      });
    }
  }

  // 3. Same trigger, but the verification differs — possibly two competing cures.
  const similarity = triggerSimilarity(a, b);
  if (similarity >= TRIGGER_SIMILARITY_THRESHOLD) {
    const aVerification = verificationOf(a.body ?? '');
    const bVerification = verificationOf(b.body ?? '');
    if (aVerification && bVerification && aVerification !== bVerification) {
      conflicts.push({
        kind: 'competing-cure',
        severity: 'medium',
        a: a.name,
        b: b.name,
        evidence: [
          `触发相似度 ${similarity.toFixed(2)}`,
          `${a.name} 验证: ${aVerification}`,
          `${b.name} 验证: ${bVerification}`,
        ],
        suggestion: '两条 skill 面向同一个触发却给出不同的判定方式；要么合并成一条（在不同条件下分叉），要么在边界节写清各自适用场景',
      });
    }
  }

  // 4. Same path, one says it exists, the other says it does not.
  const aPaths = extractPaths(aSnippets);
  const bPaths = extractPaths(bSnippets);
  for (const path of aPaths) {
    if (!bPaths.has(path)) continue;
    const aMissing = mentionsMissing(a.body ?? '', path);
    const bMissing = mentionsMissing(b.body ?? '', path);
    if (aMissing !== bMissing) {
      conflicts.push({
        kind: 'path-existence',
        severity: 'medium',
        a: a.name,
        b: b.name,
        evidence: [
          `${a.name}: ${aMissing ? '说它已不存在' : '把它当作存在'} (${path})`,
          `${b.name}: ${bMissing ? '说它已不存在' : '把它当作存在'}`,
        ],
        suggestion: '同一条路径在两条 skill 里存在性相反；很可能其中一条写于迁移之前，现在会把人带到错的地方',
      });
    }
  }

  return conflicts;
}

const MISSING_MARKERS = /(不存在|已删除|已移除|已迁移|不要再用|no longer|removed|deleted|deprecated)/i;

function mentionsMissing(body, path) {
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes(path)) continue;
    if (MISSING_MARKERS.test(line)) return true;
  }
  return false;
}

function verificationOf(body) {
  const match = body.match(/^#{1,6}\s*(?:验证|如何验证|核对|自检|verification|verify)[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|$)/im);
  if (!match) return null;
  const command = match[1].match(/`([^`\n]+)`/);
  return command ? command[1].trim() : match[1].trim().split('\n')[0]?.trim() || null;
}

/** All conflicting pairs in one catalog. */
export function detectConflicts(skills) {
  const usable = skills.filter((skill) => !skill.error && typeof skill.body === 'string');
  const conflicts = [];
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      conflicts.push(...compareSkills(usable[i], usable[j]));
    }
  }
  return conflicts;
}
