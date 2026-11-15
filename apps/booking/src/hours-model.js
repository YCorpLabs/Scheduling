// Hours model, version 2: each person has one availability, and a link either
// uses it ("Any time I'm available", useDefaultSchedule) or carries its own
// times inline (zone, weeklyHours, dateOverrides on the link).
//
// The data stays in the format older code and the Email desktop app already
// understand:
// - personal workspace: one schedule, the owner's availability, is the default;
// - company workspace: no shared schedule; a member's availability is the
//   memberSchedule on their own calendar account;
// - a team host with special hours on one link keeps pointing at a hidden
//   schedule (host.scheduleId), exactly as before.
//
// migrateHoursModel and restoreHoursModel are pure so they can be tested and
// reversed. The ledger stores the backup next to the data.
import { DEFAULT, validZone } from '../public/policy.js';

export const HOURS_MODEL_VERSION = 2;
export const ALL_WEEK_ID = '__all_week';
const HOURS = ['zone', 'weeklyHours', 'dateOverrides'];
const clone = value => value == null ? value : structuredClone(value);

/** Mon–Fri 09:00–17:00, the default for anyone who hasn't set hours. */
export function workdayHours(zone) {
  return {
    zone: validZone(zone) ? zone : DEFAULT.zone,
    weeklyHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(day => [day, day > 0 && day < 6 ? [{ start: 540, end: 1020 }] : []])),
    dateOverrides: {}
  };
}

/** Base hours for "Any time I'm available" on a team workspace link: each host's availability does the limiting. */
export function allWeekSchedule() {
  return { id: ALL_WEEK_ID, name: 'All week', zone: 'UTC', weeklyHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(day => [day, [{ start: 0, end: 1440 }]])), dateOverrides: {} };
}

/** The schedules and default a link resolves against, including the team "any time" base. */
export function hoursSources(kind, schedules = [], defaultId = null) {
  if (kind === 'company' && !defaultId) return { schedules: [...schedules, allWeekSchedule()], defaultId: ALL_WEEK_ID };
  return { schedules, defaultId };
}

/** The hours that limit one host on one link, or null for no limit. */
export function hostLimit({ kind, account, type }) {
  if (account?.memberSchedule) return account.memberSchedule;
  if (kind === 'company' && type?.useDefaultSchedule) return workdayHours(type.zone);
  return null;
}

function hoursOf(schedule) {
  return Object.fromEntries(HOURS.map(key => [key, clone(schedule[key] ?? (key === 'dateOverrides' ? {} : null))]));
}

function usage(types, schedules, defaultId) {
  const counts = new Map(schedules.map(s => [s.id, 0]));
  for (const type of types) {
    const id = type.useDefaultSchedule ? defaultId : type.scheduleId;
    if (counts.has(id)) counts.set(id, counts.get(id) + 1);
  }
  return counts;
}

/**
 * Moves a workspace from named schedules to one availability per person.
 * Returns the new state plus a backup that restoreHoursModel can put back.
 * No link gains or loses a bookable time: links keep the exact hours they
 * resolve to today.
 */
export function migrateHoursModel({ kind = 'personal', availabilitySchedules = [], defaultAvailabilityScheduleId = null, meetingTypes = [] }) {
  const company = kind === 'company';
  const schedules = availabilitySchedules.map(clone), byId = new Map(schedules.map(s => [s.id, s]));
  const defaultId = byId.has(defaultAvailabilityScheduleId) ? defaultAvailabilityScheduleId : null;
  const backup = {
    from: 1,
    availabilitySchedules: clone(availabilitySchedules),
    defaultAvailabilityScheduleId,
    links: Object.fromEntries(meetingTypes.map(t => [t.id, { scheduleId: t.scheduleId ?? null, useDefaultSchedule: t.useDefaultSchedule ?? false, ...hoursOf(t) }]))
  };

  // The person's availability (personal workspaces only).
  let availability = null;
  if (!company) {
    if (defaultId) availability = byId.get(defaultId);
    else if (schedules.length) {
      const counts = usage(meetingTypes, schedules, null);
      availability = [...schedules].sort((a, b) => counts.get(b.id) - counts.get(a.id))[0];
    } else {
      const zone = meetingTypes.find(t => validZone(t.zone))?.zone ?? DEFAULT.zone;
      availability = { id: 'availability', name: 'Availability', ...workdayHours(zone) };
    }
  }

  const types = meetingTypes.map(type => {
    const id = type.useDefaultSchedule ? defaultId : type.scheduleId, schedule = id ? byId.get(id) : null;
    // Inline hours or a broken reference: leave exactly as it is.
    if (!schedule) return clone(type);
    if (!company && schedule.id === availability.id) return { ...clone(type), scheduleId: null, useDefaultSchedule: true };
    return { ...clone(type), ...hoursOf(schedule), scheduleId: null, useDefaultSchedule: false };
  });

  // Keep only the availability and the hidden schedules team hosts point at.
  const hostIds = new Set(types.flatMap(t => (t.teamScheduling?.hosts ?? []).map(h => h.scheduleId).filter(Boolean)));
  const kept = [...(availability ? [availability] : []), ...schedules.filter(s => hostIds.has(s.id) && s.id !== availability?.id)];
  return {
    availabilitySchedules: kept,
    defaultAvailabilityScheduleId: availability?.id ?? null,
    meetingTypes: types,
    backup
  };
}

/**
 * Puts back the named schedules and each surviving link's original hours
 * fields. Links created after the migration keep their current fields.
 */
export function restoreHoursModel({ meetingTypes = [] }, backup) {
  if (!backup || backup.from !== 1) throw Error('No hours backup to restore.');
  return {
    availabilitySchedules: clone(backup.availabilitySchedules),
    defaultAvailabilityScheduleId: backup.defaultAvailabilityScheduleId ?? null,
    meetingTypes: meetingTypes.map(type => {
      const saved = backup.links[type.id];
      return saved ? { ...clone(type), ...clone(saved) } : clone(type);
    })
  };
}

/**
 * Normalizes a settings write from an older client (the Email desktop app,
 * or a stale Studio tab) that still sends named schedules, so stored data
 * stays in the version 2 shape.
 */
export function normalizeHoursWrite(state) {
  const { backup, ...next } = migrateHoursModel(state);
  return next;
}
