/**
 * 兰台 · storage.
 *
 * A skill on disk is a directory bundle (`<root>/<name>/SKILL.md`) or a flat file
 * (`<root>/<name>.md`). Both shapes are read; bundles are written, because a skill
 * usually grows references later.
 */
import { mkdir, readFile, readdir, stat, writeFile, copyFile, access, rename, cp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const SOURCE_TAG = 'lantai';

function yamlScalar(value) {
  return JSON.stringify(String(value).replace(/\s+/g, ' ').trim());
}

/** Render a skill file with a frontmatter block the filesystem provider can parse. */
export function renderSkill({ name, description, whenToUse, body, provenance = {} }) {
  const frontmatter = ['---', `name: ${yamlScalar(name)}`, `description: ${yamlScalar(description)}`];
  if (whenToUse) frontmatter.push(`whenToUse: ${yamlScalar(whenToUse)}`);
  const meta = { source: SOURCE_TAG, ...provenance };
  const metaLines = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `  ${key}: ${yamlScalar(value)}`);
  if (metaLines.length > 0) {
    frontmatter.push('metadata:', ...metaLines);
  }
  frontmatter.push('---', '');
  const normalized = body.replace(/\r\n/g, '\n').trimEnd();
  return `${frontmatter.join('\n')}\n${normalized}\n`;
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

/** Minimal frontmatter reader: top-level scalars plus one level of `metadata`. */
export function parseSkill(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: {}, metadata: {}, body: normalized, hasFrontmatter: false };
  }
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) {
    return { frontmatter: {}, metadata: {}, body: normalized, hasFrontmatter: false };
  }
  const block = normalized.slice(4, end).split('\n');
  const frontmatter = {};
  const metadata = {};
  let inMetadata = false;
  for (const line of block) {
    if (line.trim() === '') continue;
    const indented = /^\s+/.test(line);
    const match = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!indented && key === 'metadata' && rawValue.trim() === '') {
      inMetadata = true;
      continue;
    }
    if (!indented) {
      inMetadata = false;
      frontmatter[key] = unquote(rawValue);
      continue;
    }
    if (inMetadata) metadata[key] = unquote(rawValue);
  }
  const body = normalized.slice(normalized.indexOf('\n---', 3) + 4).replace(/^\n/, '');
  return { frontmatter, metadata, body, hasFrontmatter: true };
}

async function exists(target) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate one skill's file, in either supported shape.
 * @returns {Promise<string|null>}
 */
export async function findSkillFile(root, name) {
  const bundle = path.join(root, name, 'SKILL.md');
  if (await exists(bundle)) return bundle;
  const flat = path.join(root, `${name}.md`);
  if (await exists(flat)) return flat;
  return null;
}

/**
 * 兰台·勘 — stamp a skill as re-checked.
 *
 * This records a *claim* that the verification was run, not the run itself: 兰台
 * deliberately executes nothing. The stage advances only here, which is what keeps
 * the review ladder from stalling.
 */
export async function attestSkill(root, name, { now = new Date(), stage, reviewCount, note } = {}) {
  const file = await findSkillFile(root, name);
  if (file === null) {
    const error = new Error(`skill "${name}" does not exist`);
    error.code = 'ENOENT_SKILL';
    throw error;
  }
  const text = await readFile(file, 'utf8');
  const parsed = parseSkill(text);
  if (!parsed.hasFrontmatter) {
    const error = new Error(`skill "${name}" has no frontmatter to stamp`);
    error.code = 'EFRONTMATTER_SKILL';
    throw error;
  }

  const provenance = {
    ...parsed.metadata,
    reviewedAt: now.toISOString(),
    stage: String(stage),
    reviewCount: String(reviewCount),
    ...(note ? { reviewNote: note } : {}),
  };

  const backup = `${file}.bak`;
  await copyFile(file, backup);
  const rendered = renderSkill({
    name: parsed.frontmatter.name ?? name,
    description: parsed.frontmatter.description ?? '',
    whenToUse: parsed.frontmatter.whenToUse,
    body: parsed.body,
    provenance,
  });
  await writeFile(file, rendered, 'utf8');
  return { path: file, backup, reviewedAt: provenance.reviewedAt, stage, reviewCount };
}


/** Every skill id present under `root`, in either supported shape. */
export async function listSkillNames(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (await exists(path.join(root, entry.name, 'SKILL.md'))) names.push(entry.name);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      names.push(entry.name.slice(0, -3));
    }
  }
  return names.sort();
}

/** Full catalog: parsed frontmatter for every skill, tolerant of broken files. */
export async function listSkills(root) {
  const names = await listSkillNames(root);
  const catalog = [];
  for (const name of names) {
    const bundle = path.join(root, name, 'SKILL.md');
    const flat = path.join(root, `${name}.md`);
    const file = (await exists(bundle)) ? bundle : flat;
    try {
      const text = await readFile(file, 'utf8');
      const parsed = parseSkill(text);
      const info = await stat(file);
      catalog.push({
        name: parsed.frontmatter.name ?? name,
        description: parsed.frontmatter.description ?? null,
        whenToUse: parsed.frontmatter.whenToUse ?? null,
        source: parsed.metadata.source ?? null,
        distilledAt: parsed.metadata.distilledAt ?? null,
        session: parsed.metadata.session ?? null,
        reviewedAt: parsed.metadata.reviewedAt ?? null,
        stage: Number.isInteger(Number(parsed.metadata.stage)) ? Number(parsed.metadata.stage) : 0,
        reviewCount: Number.isInteger(Number(parsed.metadata.reviewCount)) ? Number(parsed.metadata.reviewCount) : 0,
        status: parsed.metadata.status ?? 'active',
        path: file,
        body: parsed.body,
        hasFrontmatter: parsed.hasFrontmatter,
        modifiedAt: info.mtime.toISOString(),
      });
    } catch (error) {
      catalog.push({ name, path: file, error: error.message });
    }
  }
  return catalog;
}

/**
 * Write one skill. Never overwrites silently: with `replace: false` an existing
 * file is an error, and with `replace: true` the old file is kept as `.bak`.
 */
export async function writeSkill(root, { name, description, whenToUse, body, provenance }, { replace = false } = {}) {
  const directory = path.join(root, name);
  const target = path.join(directory, 'SKILL.md');
  const flat = path.join(root, `${name}.md`);
  const alreadyThere = (await exists(target)) || (await exists(flat));
  if (alreadyThere && !replace) {
    const error = new Error(`skill "${name}" already exists`);
    error.code = 'EEXIST_SKILL';
    throw error;
  }

  let backup = null;
  await mkdir(directory, { recursive: true });
  if (alreadyThere) {
    if (await exists(target)) {
      backup = `${target}.bak`;
      await copyFile(target, backup);
    } else {
      backup = `${flat}.bak`;
      await copyFile(flat, backup);
    }
  }

  const text = renderSkill({ name, description, whenToUse, body, provenance });
  await writeFile(target, text, 'utf8');
  return { path: target, backup, bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * 兰台·削 — archive one skill instead of erasing it.
 *
 * Deletion is irreversible and a skill is re-injected into every future session, so
 * "remove" here means "move aside": the bundle lands in `<root>.retired/<name>-<stamp>`
 * and the caller gets the exact path back. Nothing is ever unlinked.
 */
export async function archiveSkill(root, name, { now = new Date(), reason } = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const retiredRoot = `${root}.retired`;
  await mkdir(retiredRoot, { recursive: true });

  const bundle = path.join(root, name);
  const flat = path.join(root, `${name}.md`);
  const source = (await exists(bundle)) ? bundle : (await exists(flat)) ? flat : null;
  if (source === null) {
    const error = new Error(`skill "${name}" does not exist`);
    error.code = 'ENOENT_SKILL';
    throw error;
  }
  if (await exists(path.join(root, name, 'SKILL.md')) === false && source === bundle) {
    const error = new Error(`"${name}" is not a skill bundle`);
    error.code = 'ENOTBUNDLE_SKILL';
    throw error;
  }

  const target = path.join(retiredRoot, `${name}-${stamp}${source === flat ? '.md' : ''}`);
  try {
    await rename(source, target);
  } catch {
    // Different volume: fall back to copy + remove.
    await cp(source, target, { recursive: true });
    await rm(source, { recursive: true, force: true });
  }
  // Why it was archived travels with it: a bare timestamp later is a mystery.
  const record = [
    '# 归档记录',
    '',
    `- skill: ${name}`,
    `- 归档时间: ${now.toISOString()}`,
    `- 原因: ${typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : '(未填写)'}`,
    `- 归档自: ${source}`,
    `- 恢复方式: 把本目录搬回 ${path.join(root, name)}`,
    '',
  ].join('\n');
  const recordPath = source === flat ? `${target}.retired.md` : path.join(target, 'RETIRED.md');
  await writeFile(recordPath, record, 'utf8');

  return { name, archivedTo: target, retiredRoot, record: recordPath };
}