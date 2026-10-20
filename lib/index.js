/**
 * dsh-lantai · 兰台
 *
 * A DeepSeek Harness plugin that turns one session's hard-won experience into a
 * durable skill — through a gate that rejects vague advice, duplicates, and any
 * sentence that would grant future sessions more permission than they should have.
 *
 * The name is a place: 兰台 was the Han-dynasty archive where Ban Gu compiled the
 * Book of Han. It stores history; it does not command.
 */
import os from 'node:os';
import path from 'node:path';
import { buildTools } from './tools.js';

/** Cordis plugin name. */
export const name = 'lantai';

/**
 * `tools` is required. Everything else is optional and reached through
 * `optionalService()` — never through `ctx.<name>`, because Cordis throws on a
 * property access for a service that was not declared here. That throw happens
 * inside `apply()` and takes the whole row down with it.
 */
export const inject = ['tools'];

const DEFAULTS = {
  /** Where skills are written. The filesystem skill provider scans this root. */
  skillRoot: path.join(os.homedir(), '.dsh', 'skills'),
  /** Overwriting an existing skill needs this, plus an explicit per-call `replace: true`. */
  allowReplace: false,
  /** Inject a short standing instruction so the agent knows the archive exists. */
  nudge: true,
};

/**
 * The standing instruction. Deliberately three lines: every session pays for it in
 * context, so it earns its place only by changing behaviour the tool cannot force.
 */
const NUDGE = `兰台 (lantai) 已在本机启用：
- 会话开始时若 skill_audit 报出到期的 skill，先处理到期项，再开始新工作。
- 任务收尾时若得到可复用的经验（尤其是本机或本项目特有的坑、命令、配置），调用 skill_distill 沉淀；不值得复用就不要写。
- 核对完一条 skill 并确认仍然成立时，用 skill_attest 盖章，复核间隔会自动拉长。`;

/**
 * Reach an optional service without touching a property.
 *
 * `ctx.get(name)` is the only safe lookup: an undeclared service accessed as
 * `ctx.<name>` throws `cannot get property "..." without inject`, and a throw here
 * means the plugin never activates.
 */
function optionalService(ctx, serviceName, method) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined;
    if (service && typeof service[method] === 'function') return service;
  } catch {
    // The service exists but is not reachable from this scope: treat as absent.
  }
  return null;
}

function safeLogger(ctx) {
  try {
    const logger = ctx.logger;
    return logger && typeof logger.warn === 'function' ? logger : null;
  } catch {
    return null;
  }
}

function normalizeConfig(raw) {
  const config = { ...DEFAULTS };
  const problems = [];
  if (raw === undefined || raw === null) return { config, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { config, problems: ['config 必须是一个映射（YAML 对象）'] };
  }
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      problems.push(`未知配置项 "${key}"（可用：${Object.keys(DEFAULTS).join(', ')}）`);
    }
  }
  if (raw.skillRoot !== undefined) {
    if (typeof raw.skillRoot !== 'string' || raw.skillRoot.trim() === '') {
      problems.push('"skillRoot" 必须是非空路径字符串');
    } else {
      config.skillRoot = raw.skillRoot.startsWith('~')
        ? path.join(os.homedir(), raw.skillRoot.slice(1).replace(/^[\\/]/, ''))
        : path.resolve(raw.skillRoot);
    }
  }
  for (const key of ['allowReplace', 'nudge']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') problems.push(`"${key}" 必须是 true 或 false`);
    else config[key] = raw[key];
  }
  return { config, problems };
}

/**
 * Register the 兰台 tools.
 * @param ctx plugin context carrying the tool registry.
 * @param rawConfig the `config` block of the profile row.
 */
export function apply(ctx, rawConfig) {
  const { config, problems } = normalizeConfig(rawConfig);
  const logger = safeLogger(ctx);

  if (problems.length > 0 && logger) {
    // Never throw during start: a bad config must not take the profile down.
    logger.warn(`lantai: 配置有问题，工具会在调用时报错：${problems.join('；')}`);
  }

  // The approval service is the channel that actually reaches the user from a
  // root-level plugin: it is the same one a sandbox escalation uses, and it accepts
  // a custom human-readable reason. userQuestions does not route here.
  const approval = optionalService(ctx, 'approval', 'request');
  const requestApproval = approval ? (request) => approval.request(request) : undefined;

  const tools = buildTools({ config, problems, requestApproval });
  for (const tool of tools) {
    ctx.tools.register(tool);
  }

  if (config.nudge && problems.length === 0) {
    const systemPrompt = optionalService(ctx, 'systemPrompt', 'section');
    if (systemPrompt) {
      try {
        // `interpolate: false` keeps any braces in the text from being parsed as
        // prompt variables, which would throw during assembly.
        systemPrompt.section({ name: 'lantai', order: 900, interpolate: false, text: NUDGE });
      } catch (error) {
        if (logger) logger.warn(`lantai: 提示词段落注册失败（工具仍可用）：${error.message}`);
      }
    }
  }
}
