/**
 * 兰台 · 复核阶梯 (the review ladder).
 *
 * The obvious design — "audit every N days since the last audit" — is broken: the
 * clock resets on every review, so a skill that is reviewed promptly would sit in
 * the 7-day bucket forever and never reach the harder questions.
 *
 * The fix is to make the *interval* a function of how many times the skill has
 * already survived, not of the calendar:
 *
 *     stage 0 → 7 days → review → stage 1
 *     stage 1 → 14 days → review → stage 2
 *     stage 2 → 30 days → review → stage 3
 *     stage 3 → 60 days → review → stage 4
 *     stage 4 → 90 days → review → stage 5
 *     stage 5 → 180 days → review → stage 5 (steady state)
 *
 * Trust is earned in reviews, so the spaces between checks grow with the number of
 * checks — and because `stage` only moves on a review, the ladder can never stall.
 *
 * A failing review resets the skill to stage 0 and marks it `suspect`: a skill that
 * just proved wrong does not get the benefit of its history.
 */
export const INTERVALS = [7, 14, 30, 60, 90, 180];

/** What to actually do at each stage. Escalates from "does it still run" to "is it worth keeping". */
export const STAGE_ACTIONS = [
  '轻查：验证命令是否仍能通过',
  '复查：验证命令是否仍能通过',
  '环境复核：版本、路径、开关有没有变',
  '价值复核：是否已被更好的做法取代',
  '成本复核：命中率如何，还值得占上下文吗',
  '终审：重写、收缩，或删除',
];

const DAY_MS = 86400000;

function parseTime(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Where a skill stands right now.
 *
 * @param {{distilledAt?: string, reviewedAt?: string, stage?: number, status?: string,
 *          reviewCount?: number, now: Date}} input
 * @returns {{ok: true, stage: number, intervalDays: number, action: string, dueAt: string,
 *            overdueDays: number, due: boolean, retireSuggested: boolean, suspect: boolean}
 *          | {ok: false, reason: string}}
 */
export function computeSchedule({ distilledAt, reviewedAt, stage, status, reviewCount = 0, now }) {
  const reviewedMs = parseTime(reviewedAt);
  const createdMs = parseTime(distilledAt);
  const anchorMs = reviewedMs ?? createdMs;
  if (anchorMs === null) {
    return { ok: false, reason: '既没有 distilledAt 也没有 reviewedAt，无法排出复核时间' };
  }

  const suspect = status === 'suspect';
  const rawStage = Number.isInteger(stage) ? stage : 0;
  // A suspect skill is pulled back to the tightest interval until it is reviewed again.
  const bounded = Math.max(0, Math.min(suspect ? 0 : rawStage, INTERVALS.length - 1));
  const intervalDays = suspect ? INTERVALS[0] : INTERVALS[bounded];
  const dueMs = anchorMs + intervalDays * DAY_MS;
  const overdueDays = Math.floor((now.getTime() - dueMs) / DAY_MS);

  return {
    ok: true,
    stage: bounded,
    reviewCount,
    intervalDays,
    action: STAGE_ACTIONS[bounded],
    anchor: new Date(anchorMs).toISOString(),
    dueAt: new Date(dueMs).toISOString(),
    overdueDays: Math.max(0, overdueDays),
    due: overdueDays >= 0,
    // A whole ladder's worth of neglect means nobody is maintaining it: suggest retiring
    // rather than silently keeping a stale instruction in every session's context.
    retireSuggested: overdueDays > INTERVALS[INTERVALS.length - 1],
    suspect,
  };
}

/** The stage a successful review moves to. */
export function nextStage(stage) {
  const bounded = Number.isInteger(stage) ? Math.max(0, stage) : 0;
  return Math.min(bounded + 1, INTERVALS.length - 1);
}
