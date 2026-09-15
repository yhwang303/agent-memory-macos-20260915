import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextBeijingDailyRun, normalizeBeijingDailyTime } from '../src/services/shadowfolk/schedule.js';

test('nextBeijingDailyRun returns today when configured time has not passed in Beijing', () => {
  const now = new Date('2026-05-07T12:00:00.000Z'); // 20:00 Beijing
  const next = nextBeijingDailyRun('23:30', now);
  assert.equal(next.toISOString(), '2026-05-07T15:30:00.000Z');
});

test('nextBeijingDailyRun returns tomorrow when configured time already passed in Beijing', () => {
  const now = new Date('2026-05-07T16:00:00.000Z'); // 00:00 May 8 Beijing
  const next = nextBeijingDailyRun('23:30', now);
  assert.equal(next.toISOString(), '2026-05-08T15:30:00.000Z');
});

test('nextBeijingDailyRun falls back to 23:30 for invalid time', () => {
  const now = new Date('2026-05-07T12:00:00.000Z');
  const next = nextBeijingDailyRun('bad-input', now);
  assert.equal(next.toISOString(), '2026-05-07T15:30:00.000Z');
});

test('normalizeBeijingDailyTime pads single digit hour', () => {
  assert.equal(normalizeBeijingDailyTime('9:05'), '09:05');
});

test('normalizeBeijingDailyTime falls back to 23:30 for empty or invalid time', () => {
  assert.equal(normalizeBeijingDailyTime(''), '23:30');
  assert.equal(normalizeBeijingDailyTime('bad-input'), '23:30');
});

test('normalizeBeijingDailyTime falls back to 23:30 for out-of-range time', () => {
  assert.equal(normalizeBeijingDailyTime('24:00'), '23:30');
  assert.equal(normalizeBeijingDailyTime('23:60'), '23:30');
});

test('nextBeijingDailyRun returns tomorrow when now exactly equals configured time', () => {
  const now = new Date('2026-05-07T15:30:00.000Z'); // 23:30 Beijing
  const next = nextBeijingDailyRun('23:30', now);
  assert.equal(next.toISOString(), '2026-05-08T15:30:00.000Z');
});
