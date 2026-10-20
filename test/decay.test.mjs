/**
 * The review ladder.
 *
 * The regression these tests exist for: an interval keyed only on "days since the
 * last review" resets to zero on every review and therefore never reaches the later
 * stages. `stage` must drive the interval, and only an attest may move it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INTERVALS, STAGE_ACTIONS, computeSchedule, nextStage } from '../lib/decay.js';

const DAY = 86400000;
const at = (iso) => new Date(iso);

test('a fresh skill is not due and waits the first interval', () => {
  const schedule = computeSchedule({ distilledAt: '2026-10-01T00:00:00Z', stage: 0, now: at('2026-10-01T00:00:00Z') });
  assert.equal(schedule.ok, true);
  assert.equal(schedule.intervalDays, 7);
  assert.equal(schedule.due, false);
  assert.equal(schedule.stage, 0);
  assert.equal(schedule.action, STAGE_ACTIONS[0]);
  assert.equal(schedule.dueAt, new Date(Date.parse('2026-10-01T00:00:00Z') + 7 * DAY).toISOString());
});

test('the seventh day makes it due', () => {
  const schedule = computeSchedule({ distilledAt: '2026-10-01T00:00:00Z', stage: 0, now: at('2026-10-08T00:00:00Z') });
  assert.equal(schedule.due, true);
  assert.equal(schedule.overdueDays, 0);
});

test('after a review the interval grows: it does NOT fall back to 7 days', () => {
  // Reviewed on day 10 (stage 0 → 1). Ten days later the next review is still
  // 4 days away, because stage 1 waits 14 days. A "days since last review" design
  // would already be shouting at this point and every point after it.
  const schedule = computeSchedule({
    distilledAt: '2026-09-01T00:00:00Z',
    reviewedAt: '2026-10-01T00:00:00Z',
    stage: 1,
    reviewCount: 1,
    now: at('2026-10-11T00:00:00Z'),
  });
  assert.equal(schedule.intervalDays, 14);
  assert.equal(schedule.due, false);
  assert.equal(schedule.overdueDays, 0);
  assert.equal(schedule.action, STAGE_ACTIONS[1]);
});

test('the ladder reaches 180 days instead of stalling at the first rung', () => {
  const schedule = computeSchedule({
    distilledAt: '2025-01-01T00:00:00Z',
    reviewedAt: '2026-01-01T00:00:00Z',
    stage: 5,
    reviewCount: 6,
    now: at('2026-02-01T00:00:00Z'),
  });
  assert.equal(schedule.intervalDays, 180);
  assert.equal(schedule.due, false);
  assert.equal(schedule.action, STAGE_ACTIONS[5]);
});

test('each stage maps to its own interval', () => {
  for (const [stage, interval] of INTERVALS.entries()) {
    const schedule = computeSchedule({
      distilledAt: '2026-01-01T00:00:00Z',
      stage,
      now: at('2026-01-01T00:00:00Z'),
    });
    assert.equal(schedule.intervalDays, interval, `stage ${stage}`);
  }
});

test('a suspect skill is pulled back to the tightest interval', () => {
  const schedule = computeSchedule({
    distilledAt: '2026-01-01T00:00:00Z',
    stage: 4,
    status: 'suspect',
    now: at('2026-01-09T00:00:00Z'),
  });
  assert.equal(schedule.intervalDays, INTERVALS[0]);
  assert.equal(schedule.stage, 0);
  assert.equal(schedule.suspect, true);
  assert.equal(schedule.due, true);
});

test('retiring is suggested only after a whole ladder of neglect', () => {
  const justOverdue = computeSchedule({
    distilledAt: '2026-01-01T00:00:00Z',
    stage: 5,
    now: at('2026-07-01T00:00:00Z'),
  });
  assert.equal(justOverdue.due, true);
  assert.equal(justOverdue.retireSuggested, false);

  const abandoned = computeSchedule({
    distilledAt: '2020-01-01T00:00:00Z',
    stage: 5,
    now: at('2026-07-01T00:00:00Z'),
  });
  assert.equal(abandoned.retireSuggested, true);
});

test('missing timestamps are reported, not guessed', () => {
  const schedule = computeSchedule({ stage: 1, now: at('2026-01-01T00:00:00Z') });
  assert.equal(schedule.ok, false);
  assert.match(schedule.reason, /无法排出复核时间/);
});

test('nextStage caps at the last rung and never goes backwards', () => {
  assert.equal(nextStage(0), 1);
  assert.equal(nextStage(4), 5);
  assert.equal(nextStage(5), 5);
  assert.equal(nextStage(99), 5);
  assert.equal(nextStage(-3), 1);
  assert.equal(nextStage(undefined), 1);
});
