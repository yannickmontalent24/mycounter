// Gym programme reference data. This is fixed content, not user data — identical for both
// accounts and never edited in the app — so it ships with the build rather than living in
// Firestore. That keeps it instantly available offline and costs no reads.
//
// Adding a later phase: append another object to PHASES with its own startDate and weeks.
// The active phase and week are worked out from the date, so nothing else needs changing.
//
// `image` is a path relative to the app root (e.g. 'images/exercises/back-squat.svg'), left
// null until artwork exists. It must stay relative — the app is served from a GitHub Pages
// subpath, where a leading slash would resolve to the domain root and 404.

export const PHASES = [
  {
    id: 'phase-1-build',
    name: 'Phase 1 — Build',
    startDate: '2026-08-24',
    weeks: 3,
    days: [
      {
        weekday: 'tue',
        dayLabel: 'Tuesday',
        label: 'Leg day',
        exercises: [
          {
            name: 'Back squat',
            instructions: 'Bar on upper back, feet shoulder-width, squat down until thighs are at least parallel to floor, drive back up.',
            weeks: { 1: '3x8', 2: '3x6', 3: '3x5 (heavier)' },
            image: null,
          },
          {
            name: 'Leg press',
            instructions: 'Seated on machine, feet shoulder-width on platform, lower until knees at ~90°, press back up without locking knees.',
            weeks: { 1: '3x10', 2: '3x8', 3: '3x6' },
            image: null,
          },
          {
            name: 'Bulgarian split squat',
            instructions: 'Rear foot elevated on bench, front foot forward, lower back knee toward floor, drive up through front leg.',
            weeks: { 1: '3x10/leg', 2: '3x10/leg', 3: '3x8/leg' },
            image: null,
          },
          {
            name: 'Romanian deadlift',
            instructions: 'Slight knee bend, hinge at hips lowering bar/dumbbells along legs, keep back flat, return to standing.',
            weeks: { 1: '3x8', 2: '3x8', 3: '3x6' },
            image: null,
          },
          {
            name: 'Calf raises',
            instructions: 'Standing, rise onto toes, pause, lower under control.',
            weeks: { 1: '3x15', 2: '3x15', 3: '3x15' },
            image: null,
          },
        ],
      },
      {
        weekday: 'thu',
        dayLabel: 'Thursday',
        label: 'Core day',
        exercises: [
          {
            name: 'Plank',
            instructions: 'Forearms and toes on floor, body in a straight line head to heels, hold.',
            weeks: { 1: '3x45-60s', 2: '3x45-60s', 3: '3x45-60s' },
            image: null,
          },
          {
            name: 'Side plank',
            instructions: 'Lie on side, prop up on forearm, hips lifted so body forms a straight line, hold, switch sides.',
            weeks: { 1: '3x30-45s/side', 2: '3x30-45s/side', 3: '3x30-45s/side' },
            image: null,
          },
          {
            name: 'Dead bug (bodyweight)',
            instructions: 'Lie on back, arms up and knees bent 90°, lower one arm and opposite leg toward floor keeping lower back flat, return, alternate.',
            weeks: { 1: '3x10/side', 2: '3x10/side', 3: '3x10/side' },
            image: null,
          },
          {
            name: 'Russian twist (one dumbbell)',
            instructions: 'Sit with knees bent, lean back slightly, feet lifted or planted, hold one dumbbell with both hands, rotate side to side tapping floor near hip.',
            weeks: { 1: '3x15/side', 2: '3x15/side', 3: '3x15/side' },
            image: null,
          },
        ],
      },
    ],
  },
];

function parseISO(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function phaseEndDate(phase) {
  const end = parseISO(phase.startDate);
  end.setDate(end.getDate() + phase.weeks * 7 - 1);
  return toISO(end);
}

// The phase covering today; otherwise the most recent one to have started, so a finished
// programme still shows rather than the screen going blank.
export function activePhase(phases, todayStr) {
  if (!phases.length) return null;
  const current = phases.find(p => todayStr >= p.startDate && todayStr <= phaseEndDate(p));
  if (current) return current;
  const started = phases.filter(p => todayStr >= p.startDate);
  if (started.length) return started[started.length - 1];
  return phases[0];
}

// Which week of the phase today falls in, clamped so a date before or after the programme
// still lands on a real week rather than 0 or 4.
export function weekNumberFor(phase, todayStr) {
  const days = Math.floor((parseISO(todayStr) - parseISO(phase.startDate)) / 86400000);
  const week = Math.floor(days / 7) + 1;
  return Math.min(Math.max(week, 1), phase.weeks);
}

// Today's session if there is one, otherwise the next one due — what you want on screen when
// you open this in the changing room.
export function defaultDayIndex(phase, todayStr) {
  const order = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const todayIdx = parseISO(todayStr).getDay();
  const dayIdxOf = d => order.indexOf(d.weekday);

  const exact = phase.days.findIndex(d => dayIdxOf(d) === todayIdx);
  if (exact !== -1) return exact;

  let best = 0;
  let bestGap = Infinity;
  phase.days.forEach((d, i) => {
    const gap = (dayIdxOf(d) - todayIdx + 7) % 7;
    if (gap < bestGap) { bestGap = gap; best = i; }
  });
  return best;
}
