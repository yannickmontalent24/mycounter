import assert from 'node:assert/strict';
import {
  PHASES, activePhase, weekNumberFor, defaultDayIndex, phaseEndDate,
} from '../js/workouts.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const phase1 = PHASES[0];

test('phase 1 runs the three weeks stated in the brief', () => {
  assert.equal(phase1.startDate, '2026-08-24');
  assert.equal(phase1.weeks, 3);
  assert.equal(phaseEndDate(phase1), '2026-09-13');
});

test('phase 1 carries both sessions with the right exercise counts', () => {
  assert.deepEqual(phase1.days.map(d => d.weekday), ['tue', 'thu']);
  assert.equal(phase1.days[0].exercises.length, 5, 'leg day has five exercises');
  assert.equal(phase1.days[1].exercises.length, 4, 'core day has four');
});

test('every exercise has sets/reps for all three weeks', () => {
  for (const day of phase1.days) {
    for (const ex of day.exercises) {
      for (const week of [1, 2, 3]) {
        assert.ok(ex.weeks[week], `${ex.name} is missing week ${week}`);
      }
      assert.ok(ex.instructions.length > 10, `${ex.name} needs instructions`);
    }
  }
});

test('every exercise links to its own distinct guide over https', () => {
  const links = [];
  for (const day of phase1.days) {
    for (const ex of day.exercises) {
      assert.ok(ex.link, `${ex.name} has no link`);
      assert.ok(ex.link.startsWith('https://'), `${ex.name} link must be https`);
      links.push(ex.link);
    }
  }
  assert.equal(new Set(links).size, links.length, 'each exercise needs its own URL, not a shared one');
});

test('instructions stand alone, since the links need a connection the gym may not have', () => {
  for (const day of phase1.days) {
    for (const ex of day.exercises) {
      assert.ok(ex.instructions.length > 40, `${ex.name} instructions are too thin to use offline`);
    }
  }
});

test('weekNumberFor: maps dates onto weeks 1-3', () => {
  assert.equal(weekNumberFor(phase1, '2026-08-24'), 1, 'first day');
  assert.equal(weekNumberFor(phase1, '2026-08-30'), 1, 'last day of week 1');
  assert.equal(weekNumberFor(phase1, '2026-08-31'), 2, 'first day of week 2');
  assert.equal(weekNumberFor(phase1, '2026-09-06'), 2);
  assert.equal(weekNumberFor(phase1, '2026-09-07'), 3);
  assert.equal(weekNumberFor(phase1, '2026-09-13'), 3, 'last day');
});

test('weekNumberFor: clamps outside the programme rather than returning 0 or 4', () => {
  assert.equal(weekNumberFor(phase1, '2026-08-01'), 1, 'before the start');
  assert.equal(weekNumberFor(phase1, '2026-10-25'), 3, 'after the end');
});

test('defaultDayIndex: picks today when it is a session day', () => {
  assert.equal(defaultDayIndex(phase1, '2026-08-25'), 0, 'Tuesday -> leg day');
  assert.equal(defaultDayIndex(phase1, '2026-08-27'), 1, 'Thursday -> core day');
});

test('defaultDayIndex: otherwise picks the next session due', () => {
  assert.equal(defaultDayIndex(phase1, '2026-08-24'), 0, 'Monday -> Tuesday next');
  assert.equal(defaultDayIndex(phase1, '2026-08-26'), 1, 'Wednesday -> Thursday next');
  assert.equal(defaultDayIndex(phase1, '2026-08-28'), 0, 'Friday -> Tuesday next');
  assert.equal(defaultDayIndex(phase1, '2026-08-30'), 0, 'Sunday -> Tuesday next');
});

test('activePhase: returns the phase covering today', () => {
  assert.equal(activePhase(PHASES, '2026-09-01').id, 'phase-1-build');
});

test('activePhase: keeps showing the last programme after it ends, not nothing', () => {
  assert.equal(activePhase(PHASES, '2026-10-25').id, 'phase-1-build');
});

test('activePhase: with several phases, picks the one covering the date', () => {
  const phases = [
    { id: 'p1', startDate: '2026-08-24', weeks: 3, days: [] },
    { id: 'p2', startDate: '2026-09-14', weeks: 4, days: [] },
  ];
  assert.equal(activePhase(phases, '2026-09-01').id, 'p1');
  assert.equal(activePhase(phases, '2026-09-20').id, 'p2');
  assert.equal(activePhase(phases, '2026-08-01').id, 'p1', 'before everything, show the first');
});

console.log(`\n${passed} passed`);
