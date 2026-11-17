import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, weekdayOf, mondayOf, weekDates, snap, normalize, addRange, removeRange, replaceRange, moveRange, rangesFor, withRanges,
  dayOff, useUsualHours, weekChanges, undoWeek, openMinutes, hoursText, weeklySummary, weekMarkup, zonedEpoch, dayLabel, freeSpot, labelPlace
} from '../public/week-calendar.js';
import { bookingsMarkup, setupMarkup, expiresIn, isRequest, isUpcoming, isPast, isCancelled } from '../public/bookings-ui.js';
import { linksMarkup, linkMenuItems } from '../public/links-ui.js';
import { minutesText, lengthMarkup, editorMarkup, ownHoursOf, previewSlots } from '../public/link-editor-ui.js';
import { availabilityPageMarkup } from '../public/availability-page.js';
import { DEFAULT } from '../public/policy.js';

const nineToFive = [{ start: 540, end: 1020 }];
const workweek = { 0: [], 1: nineToFive, 2: nineToFive, 3: nineToFive, 4: nineToFive, 5: nineToFive, 6: [] };
const schedule = () => ({ id: 'availability', zone: 'Europe/Oslo', weeklyHours: structuredClone(workweek), dateOverrides: {} });

test('week dates are plain calendar keys that cross months and years', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekdayOf('2026-11-16'), 1);
  assert.equal(mondayOf('2026-11-22'), '2026-11-16');
  assert.equal(mondayOf('2026-11-16'), '2026-11-16');
  assert.deepEqual(weekDates('2026-11-30'), ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06']);
  assert.equal(dayLabel('2026-11-16'), 'Mon 16 Nov');
});

test('ranges snap to 15 minutes, merge when they touch and stay inside the day', () => {
  assert.equal(snap(547), 540);
  assert.equal(snap(553), 555);
  assert.equal(snap(-30), 0);
  assert.equal(snap(1500), 1440);
  assert.deepEqual(normalize([{ start: 780, end: 900 }, { start: 540, end: 720 }, { start: 700, end: 790 }]), [{ start: 540, end: 900 }]);
  assert.deepEqual(normalize([{ start: 540, end: 545 }]), [], 'shorter than one step is dropped');
  assert.deepEqual(addRange(nineToFive, { start: 1080, end: 1140 }), [{ start: 540, end: 1020 }, { start: 1080, end: 1140 }]);
  assert.deepEqual(addRange(nineToFive, { start: 1020, end: 1080 }), [{ start: 540, end: 1080 }]);
  assert.deepEqual(removeRange([{ start: 540, end: 720 }, { start: 780, end: 1020 }], 0), [{ start: 780, end: 1020 }]);
  assert.deepEqual(replaceRange(nineToFive, 0, { start: 600, end: 1020 }), [{ start: 600, end: 1020 }]);
});

test('every-week edits change the weekday; this-week edits only that date, without mutating the input', () => {
  const s = schedule();
  const weekly = withRanges(s, '2026-11-17', 'every', [{ start: 600, end: 720 }]);
  assert.deepEqual(weekly.weeklyHours[2], [{ start: 600, end: 720 }]);
  assert.deepEqual(weekly.dateOverrides, {});
  const once = withRanges(s, '2026-11-17', 'week', [{ start: 600, end: 720 }]);
  assert.deepEqual(once.weeklyHours[2], nineToFive, 'usual Tuesday unchanged');
  assert.deepEqual(once.dateOverrides['2026-11-17'], [{ start: 600, end: 720 }]);
  assert.deepEqual(rangesFor(once, '2026-11-17', 'week'), [{ start: 600, end: 720 }]);
  assert.deepEqual(rangesFor(once, '2026-11-17', 'every'), nineToFive, 'every-week view shows the usual hours');
  assert.deepEqual(rangesFor(once, '2026-11-24', 'week'), nineToFive, 'next Tuesday is untouched');
  assert.deepEqual(s, schedule(), 'input unchanged');
});

test('a day off and "use usual hours" are one-week changes that can be undone', () => {
  const dates = weekDates('2026-11-16');
  let s = dayOff(schedule(), '2026-11-19');
  s = withRanges(s, '2026-11-20', 'week', [{ start: 540, end: 720 }]);
  assert.deepEqual(rangesFor(s, '2026-11-19', 'week'), []);
  assert.deepEqual(weekChanges(s, dates), ['2026-11-19', '2026-11-20']);
  assert.deepEqual(weekChanges(useUsualHours(s, '2026-11-19'), dates), ['2026-11-20']);
  assert.deepEqual(undoWeek(s, dates).dateOverrides, {});
  const later = dayOff(s, '2026-11-26');
  assert.deepEqual(Object.keys(undoWeek(later, dates).dateOverrides), ['2026-11-26'], 'only this week is undone');
});

test('moving a block keeps its length, changes the weekday or only that date, and merges where it lands', () => {
  const split = { ...schedule(), weeklyHours: { ...workweek, 2: [{ start: 540, end: 675 }, { start: 795, end: 1005 }] } };
  const later = moveRange(split, 'every', '2026-11-17', 0, '2026-11-17', { start: 600, end: 735 });
  assert.deepEqual(later.weeklyHours[2], [{ start: 600, end: 735 }, { start: 795, end: 1005 }]);
  const toSaturday = moveRange(split, 'every', '2026-11-17', 1, '2026-11-21', { start: 600, end: 810 });
  assert.deepEqual(toSaturday.weeklyHours[2], [{ start: 540, end: 675 }]);
  assert.deepEqual(toSaturday.weeklyHours[6], [{ start: 600, end: 810 }]);
  assert.deepEqual(toSaturday.dateOverrides, {});
  const once = moveRange(split, 'week', '2026-11-17', 0, '2026-11-18', { start: 480, end: 615 });
  assert.deepEqual(once.dateOverrides, { '2026-11-17': [{ start: 795, end: 1005 }], '2026-11-18': [{ start: 480, end: 1020 }] }, 'lands on Wednesday and merges with its hours');
  assert.deepEqual(once.weeklyHours, split.weeklyHours, 'usual hours unchanged');
  assert.deepEqual(split.weeklyHours[2], [{ start: 540, end: 675 }, { start: 795, end: 1005 }], 'input unchanged');
});

test('open hours subtract busy events once, in the schedule time zone', () => {
  const s = schedule(), dates = weekDates('2026-11-16');
  assert.equal(openMinutes(s, dates), 5 * 8 * 60);
  const start = zonedEpoch('2026-11-16', 600, 'Europe/Oslo');
  assert.equal(start, Date.UTC(2026, 10, 16, 9), '10:00 Oslo is 09:00 UTC in November');
  const busy = [{ start, end: start + 3600000 }, { start: start + 1800000, end: start + 5400000 }, { start, end: start + 86400000, allDay: true }];
  assert.equal(openMinutes(s, dates, busy), 5 * 8 * 60 - 90, 'overlapping events count once; all-day events are ignored');
  assert.equal(openMinutes(dayOff(s, '2026-11-16'), dates), 4 * 8 * 60);
  assert.equal(hoursText(32.5 * 60), '32.5 hours');
  assert.equal(hoursText(60), '1 hour');
});

test('weekly summaries group matching days', () => {
  assert.equal(weeklySummary(workweek), 'Mon–Fri 09:00–17:00');
  assert.equal(weeklySummary({ ...workweek, 3: [{ start: 540, end: 720 }, { start: 780, end: 1020 }] }), 'Mon–Tue 09:00–17:00, Wed 09:00–12:00, 13:00–17:00, Thu–Fri 09:00–17:00');
  assert.equal(weeklySummary({}), 'No hours');
});

test('the week grid escapes event titles, marks bookings, and locks past days only for one-week changes', () => {
  const s = dayOff(schedule(), '2026-11-19');
  const events = [{ start: zonedEpoch('2026-11-17', 720, 'Europe/Oslo'), end: zonedEpoch('2026-11-17', 780, 'Europe/Oslo'), title: '<b>Lunch</b>' }, { start: zonedEpoch('2026-11-18', 600, 'Europe/Oslo'), end: zonedEpoch('2026-11-18', 630, 'Europe/Oslo'), title: 'Intro call', booking: true }];
  const every = weekMarkup({ schedule: s, mode: 'every', monday: '2026-11-16', events, today: '2026-11-18' });
  assert.ok(!every.includes('<b>Lunch'));
  assert.match(every, /&lt;b&gt;Lunch/);
  assert.match(every, /class="wk-event wk-booked"/);
  assert.doesNotMatch(every, /wk-col[^"]*past/, 'usual hours are editable on every day');
  assert.match(every, /data-day="2026-11-19"[^>]*aria-label="Thursday 19, changed this week"/, 'the changed day gets a dot');
  const week = weekMarkup({ schedule: s, mode: 'week', monday: '2026-11-16', events, today: '2026-11-18' });
  assert.match(week, /class="wk-col past" data-col="2026-11-16"/);
  assert.match(week, /class="wk-col past" data-col="2026-11-17"/);
  assert.match(week, /class="wk-col" data-col="2026-11-18"/, 'today stays editable');
  assert.match(week, /class="wk-col offday" data-col="2026-11-19"/);
  assert.match(week, /data-day="2026-11-16"[^>]*disabled/);
  assert.match(week, /<small>19 · Off<\/small>/);
});

test('availability page shows busy calendars, destination and hours; this-week mode lists changes', () => {
  const view = {
    schedule: dayOff(schedule(), '2026-11-19'), mode: 'every', monday: '2026-11-16', events: [], editable: true, status: '',
    calendars: [{ id: 'primary', summary: 'Riley', primary: true, checked: true, locked: true, color: '#4285f4' }, { id: 'family', summary: 'Family <3', checked: false, color: '#f4511e' }],
    destination: 'primary', destinations: [{ id: 'primary', summary: 'Riley' }], zones: ['Europe/Oslo'], openNextWeek: 1950, account: 'riley@example.com'
  };
  const every = availabilityPageMarkup(view);
  assert.match(every, /Every week/);
  assert.match(every, /This week only/);
  assert.ok(!every.includes('Family <3'));
  const week = availabilityPageMarkup({ ...view, mode: 'week' });
  assert.match(week, /1 change<\/b>to this week/);
  assert.match(week, /Thu 19<\/b> <span>Off/);
  assert.match(week, /Undo this week’s changes/);
});

test('booking lists put requests first, group upcoming by day and only offer Join for today', () => {
  const zone = 'Europe/Oslo', fmt = (ms, options) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, ...options }).format(ms);
  const now = Date.UTC(2026, 10, 16, 8), hour = 3600000, meet = 'https://meet.google.com/abc-defg-hij';
  const bookings = [
    { id: 'r', status: 'awaiting_approval', title: 'Consult', name: 'Sara', email: 'sara@example.com', start: now + 30 * hour, end: now + 31 * hour, approvalExpiresAt: now + 20 * hour, answers: { q: 'Site relaunch' } },
    { id: 'a', status: 'confirmed', title: 'Intro call', name: '<Maya>', email: 'maya@example.com', start: now + 2 * hour, end: now + 2.5 * hour, conferenceStatus: 'ready', meetingUrl: meet },
    { id: 'b', status: 'confirmed', title: 'Intro call', name: 'Jonas', email: 'jonas@example.net', start: now + 26 * hour, end: now + 26.5 * hour, conferenceStatus: 'ready', meetingUrl: meet },
    { id: 'p', status: 'confirmed', title: 'Old', name: 'Priya', email: 'priya@example.com', start: now - 48 * hour, end: now - 47 * hour },
    { id: 'c', status: 'cancelled', title: 'Gone', name: 'Leo', email: 'leo@example.org', start: now + 5 * hour, end: now + 6 * hour }
  ];
  assert.deepEqual(bookings.map(b => [isRequest(b), isUpcoming(b, now), isPast(b, now), isCancelled(b)].map(Number).join('')), ['1000', '0100', '0100', '0010', '0001']);
  const html = bookingsMarkup({ bookings, fmt, zoneName: 'Oslo (GMT+1)', now, canDecide: true });
  assert.ok(html.indexOf('Waiting for your OK') < html.indexOf('Today ·'), 'requests come first');
  assert.match(html, /data-decide="approve" data-booking-id="r"/);
  assert.match(html, /data-decide-ask="r"/);
  assert.match(html, /Expires in 20 h/);
  assert.match(html, /Today · Mon 16 Nov/);
  assert.match(html, /Tomorrow · Tue 17 Nov/);
  assert.equal((html.match(/>Join</g) || []).length, 1, 'only today gets Join');
  assert.ok(!html.includes('<Maya>'));
  assert.match(html, /Past \(1\)/);
  assert.match(html, /Cancelled \(1\)/);
  assert.match(html, /Times in Oslo \(GMT\+1\)/);
  const viewer = bookingsMarkup({ bookings, fmt, zoneName: 'Oslo', now, canDecide: false });
  assert.doesNotMatch(viewer, /data-decide/, 'viewers cannot approve');
  const past = bookingsMarkup({ bookings, view: 'past', fmt, zoneName: 'Oslo', now });
  assert.match(past, /Priya/);
  assert.doesNotMatch(past, /Jonas/);
  const found = bookingsMarkup({ bookings, fmt, zoneName: 'Oslo', now, query: 'jonas' });
  assert.match(found, /Jonas/);
  assert.doesNotMatch(found, /maya@example\.com/);
  assert.equal(expiresIn(now + 30 * 60000, now), 'Expires in 30 min');
  assert.equal(expiresIn(now + 72 * hour, now), 'Expires in 3 days');
  assert.equal(expiresIn(now - 1, now), 'Expires now');
});

test('first run has three steps and ends with Copy link', () => {
  const base = { hours: 'Mon–Fri 09:00–17:00', zoneName: 'Oslo', duration: 30, linkUrl: 'https://book.example.test/b/h_x/intro', connectHref: '/auth/google?x=<y>' };
  const one = setupMarkup({ ...base, step: 1 });
  assert.match(one, /Continue with Google/);
  assert.ok(!one.includes('<y>'));
  const three = setupMarkup({ ...base, account: 'riley@example.com', destinationName: 'Riley', step: 3 });
  assert.match(three, /Your link is ready/);
  assert.match(three, /data-setup-copy>Copy link/);
  assert.match(three, /book\.example\.test\/b\/h_x\/intro/);
  assert.equal((three.match(/class="step done"/g) || []).length, 2);
});

test('links show 30-day numbers, Copy link when on and Turn on when off', () => {
  const settings = {
    meetingTypes: [
      { id: 'intro', title: 'Intro <call>', slug: 'intro', duration: 30, published: true, locationType: 'google_meet' },
      { id: 'coffee', title: 'Coffee', slug: 'coffee', duration: 15, published: false, location: 'Café' }
    ]
  };
  const html = linksMarkup({ settings, stats: { intro: { views: 41, confirmed: 9 } }, savedIds: new Set(['intro', 'coffee']) });
  assert.ok(!html.includes('Intro <call>'));
  assert.match(html, /<b>9<\/b>booked/);
  assert.match(html, /<b>41<\/b>views/);
  assert.match(html, /data-copy-booking-link="0"/);
  assert.match(html, /data-turn-on="1"/);
  assert.match(html, /30 min · Google Meet · \/intro/);
  assert.match(html, /data-section="Analytics">Stats/);
  assert.deepEqual(linkMenuItems(settings.meetingTypes[0]).map(([id]) => id), ['preview', 'embed', 'duplicate', 'off', 'delete']);
  assert.deepEqual(linkMenuItems(settings.meetingTypes[1]).map(([, label]) => label), ['Preview', 'Duplicate', 'Turn on', 'Delete']);
  assert.deepEqual(linkMenuItems(settings.meetingTypes[0], { canEdit: false }).map(([id]) => id), ['preview', 'embed']);
});

test('editor copy uses singular units and one minute format', () => {
  assert.equal(minutesText(60), '1 hour');
  assert.equal(minutesText(120), '2 hours');
  assert.equal(minutesText(1440), '1 day');
  assert.equal(minutesText(2880), '2 days');
  assert.equal(minutesText(90), '90 min');
  assert.equal(minutesText(0), '0 min');
  const chips = lengthMarkup({ duration: 60, durationOptions: [45, 60, 90] });
  assert.match(chips, /name="duration" value="60"/);
  for (const v of [45, 60, 90]) assert.match(chips, new RegExp(`value="${v}" checked`));
  assert.match(chips, /value="15"\s+>/, 'unchecked lengths stay available');
  assert.match(chips, /Guests choose/);
  const full = lengthMarkup({ duration: 30, durationOptions: [15, 30, 45, 60] });
  assert.match(full, /value="90" [^>]*disabled/, 'no fifth length');
});

test('the editor offers "any time I am available" or own times, hosts only for team links, and keeps calendar overrides visible', () => {
  const settings = { accounts: [{ id: 'g', email: 'riley@example.com', connected: true }], meetingTypes: [] };
  const base = { ...DEFAULT, id: 'x', title: 'Intro', slug: 'intro', duration: 30, published: true, accountId: 'g' };
  const any = editorMarkup({ ...base, useDefaultSchedule: true, scheduleId: null }, { settings });
  assert.match(any, /<option value="__default__" selected>Any time I’m available/);
  assert.doesNotMatch(any, /Hosts</);
  assert.doesNotMatch(any, /data-calendar-override/);
  assert.match(any, /At least <label/);
  const own = { ...base, useDefaultSchedule: false, scheduleId: null, zone: 'Europe/Oslo', weeklyHours: { ...workweek, 1: [{ start: 600, end: 660 }] }, dateOverrides: {} };
  assert.deepEqual(ownHoursOf(own).weeklyHours[1], [{ start: 600, end: 660 }]);
  assert.equal(ownHoursOf({ ...base, useDefaultSchedule: true }), null);
  const ownHtml = editorMarkup(own, { settings, ownHours: ownHoursOf(own) });
  assert.match(ownHtml, /<option value="" selected>Different times for this link…/);
  assert.match(ownHtml, /data-edit-own-hours/);
  const override = editorMarkup({ ...base, useDefaultCalendar: false, calendarId: 'team@group.calendar.google.com' }, { settings, calendars: [{ id: 'g', calendars: [{ id: 'team@group.calendar.google.com', summary: 'Team <cal>' }] }] });
  assert.match(override, /Bookings go to <b>Team &lt;cal&gt;<\/b> for this link/);
  assert.match(override, /name="destinationChoice" value="team@group.calendar.google.com"/);
});

test('the preview uses the person’s availability for "any time" links and hides busy times', () => {
  const now = Date.UTC(2026, 10, 15, 12);
  const availability = { zone: 'Europe/Oslo', weeklyHours: { 0: [], 1: [{ start: 540, end: 660 }], 2: [], 3: [], 4: [], 5: [], 6: [] }, dateOverrides: {} };
  const draft = { ...DEFAULT, title: 'Intro', duration: 60, useDefaultSchedule: true, notice: 0, horizon: 7, bufferBefore: 0, bufferAfter: 0, buffer: 0, slotInterval: 60, weeklyHours: workweek, zone: 'Europe/Oslo' };
  const { slots } = previewSlots(draft, { availability, now, days: 7 });
  assert.deepEqual(slots.map(s => new Date(s.start).toISOString()), ['2026-11-16T08:00:00.000Z', '2026-11-16T09:00:00.000Z']);
  const busy = [{ start: Date.UTC(2026, 10, 16, 8, 30), end: Date.UTC(2026, 10, 16, 8, 45) }];
  assert.deepEqual(previewSlots(draft, { availability, busy, now, days: 7 }).slots.map(s => new Date(s.start).toISOString()), ['2026-11-16T09:00:00.000Z']);
});

test('a block\'s time label goes in the first stretch no event covers, and over the events when they cover all of it', () => {
  const s = { ...schedule(), weeklyHours: { ...workweek, 3: [{ start: 540, end: 720 }] } };
  const at = (start, end, title = 'Busy') => ({ start: zonedEpoch('2026-11-18', start, 'Europe/Oslo'), end: zonedEpoch('2026-11-18', end, 'Europe/Oslo'), title });
  const label = events => weekMarkup({ schedule: s, mode: 'every', monday: '2026-11-16', events }).match(/<span class="wk-label( over)?" style="top:(\d+)px">09:00–12:00<\/span>/)?.slice(1);
  assert.deepEqual(label([]), [undefined, '8'], 'no events: at the top of the block');
  assert.deepEqual(label([at(540, 600, 'Planning')]), [undefined, '48'], 'one hour down, 4px below the event');
  assert.deepEqual(label([at(540, 600, 'Planning'), at(600, 630, 'Call')]), [undefined, '70'], 'follows back-to-back events');
  assert.deepEqual(label([at(540, 555, 'Standup')]), [undefined, '18'], 'a 15-minute event is drawn 14px tall and the label clears it');
  assert.deepEqual(label([at(660, 690, 'Lunch')]), [undefined, '8'], 'events lower in the block leave the label alone');
  assert.deepEqual(label([at(565, 600, 'Too close')]), [undefined, '48'], 'an event starting under the label pushes it down too');
  assert.deepEqual(label([at(510, 750, 'Offsite')]), [' over', '8'], 'covered from before the block: over the event, whose title is above the block');
  assert.deepEqual(label([at(540, 720, 'Offsite')]), [' over', '18'], 'covered from the block start: over the event, below its title');
});

test('label spots are found with the measured label height, so a wrapped label moves to a bigger gap', () => {
  assert.equal(freeSpot(0, 100, [], 25), 0);
  assert.equal(freeSpot(0, 100, [[10, 20], [0, 5]], 25), 20, 'spans in any order');
  assert.equal(freeSpot(0, 100, [[0, 30], [10, 20]], 25), 30, 'a span inside another');
  assert.equal(freeSpot(0, 40, [[0, 20]], 25), null, 'no room before the end');
  const standupAndPlanning = [[0, 14], [44, 88]];
  assert.deepEqual(labelPlace(0, 352, standupAndPlanning), { top: 18, over: false }, 'one line fits between them');
  assert.deepEqual(labelPlace(0, 352, standupAndPlanning, 33), { top: 92, over: false }, 'two lines do not, so it goes below the planning');
  assert.deepEqual(labelPlace(0, 30, [[-10, 60]], 17), { top: 8, over: true });
});

test('events keep their whole title for tooltips and screen readers and clamp it to the lines their height allows', () => {
  const at = (start, end, title) => ({ start: zonedEpoch('2026-11-18', start, 'Europe/Oslo'), end: zonedEpoch('2026-11-18', end, 'Europe/Oslo'), title });
  const html = weekMarkup({ schedule: schedule(), mode: 'every', monday: '2026-11-16', events: [at(540, 555, 'Team standup'), at(600, 660, 'Weekly planning with the Fernhill leadership team'), at(780, 810, '')] });
  assert.match(html, /style="top:\d+px;height:14px;--c:#8a8a90" title="Team standup 09:00–09:15"><span class="wk-event-title">Team standup<\/span><span class="sr-only">, 09:00–09:15<\/span>/, 'a short event is one line');
  assert.match(html, /height:44px;[^"]*" title="Weekly planning with the Fernhill leadership team 10:00–11:00"><span class="wk-event-title" style="-webkit-line-clamp:3">Weekly planning with the Fernhill leadership team<\/span>/, 'an hour has room for three lines');
  assert.match(html, /title="Busy 13:00–13:30"><span class="wk-event-title">Busy<\/span>/, 'untitled busy time');
  assert.equal((html.match(/data-on-block/g) || []).length, 3, 'events over a block take its grab cursor');
});

test('the link times dialog and the Availability page both count hours open next week', () => {
  const link = availabilityPageMarkup({ schedule: schedule(), mode: 'every', monday: '2026-11-16', events: [], scope: 'link', title: 'Times for Intro', editable: true });
  assert.match(link, /<b>40 hours<\/b>open next week/);
  assert.doesNotMatch(link, /open this week/);
});

test('the approval hold picker is its own sentence, hidden until approval is on', () => {
  const settings = { accounts: [], meetingTypes: [] };
  const off = editorMarkup({ ...DEFAULT, id: 'x', title: 'Intro', slug: 'intro', requiresApproval: false }, { settings });
  assert.match(off, /I approve each booking<\/label><\/p>\n<p data-approval-expiry hidden>Requests hold the time for <label/);
  const on = editorMarkup({ ...DEFAULT, id: 'x', title: 'Intro', slug: 'intro', requiresApproval: true, approvalExpiryMinutes: 1440 }, { settings });
  assert.match(on, /<p data-approval-expiry >Requests hold the time for .*<option value="1440" selected>1 day<\/option>.*?<\/select><\/p>/);
  assert.doesNotMatch(on, / · requests/);
});
