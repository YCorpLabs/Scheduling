// The link editor: one page instead of six tabs. Field names match
// readMeetingForm, so saving works exactly as before.
import { COMMON_DURATIONS, MAX_DURATION_OPTIONS, guestDurations } from './durations-ui.js';
import { changeRulesMarkup } from './change-policy-ui.js';
import { linkAccessMarkup, accessFor } from './link-access-ui.js';
import { questionsEditorMarkup } from './intake-ui.js';
import { remindersMarkup } from './reminder-ui.js';
import { teamMarkup as teamEditorMarkup } from './team-ui.js';
import { readMeetingForm, capacityMarkup, hoursFor } from './host-editor.js';
import { DEFAULT, validateConfig, policySlots } from './policy.js';
import { normalizeDurationOptions, selectDuration } from './durations.js';
import { weeklySummary } from './week-calendar.js';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const FOLLOW = '__account_default__';

export function minutesText(value) {
  if (value === 0) return '0 min';
  if (value % 1440 === 0) return `${value / 1440} day${value === 1440 ? '' : 's'}`;
  if (value % 60 === 0) return `${value / 60} hour${value === 60 ? '' : 's'}`;
  return `${value} min`;
}
const horizonText = days => days % 7 === 0 ? `${days / 7} week${days === 7 ? '' : 's'}` : `${days} days`;
function choice(name, label, values, current, text = minutesText) {
  const list = [...new Set([...values, current])].filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  return `<label class="sr-only" for="edit-${name}">${esc(label)}</label><select class="inline-select" id="edit-${name}" name="${name}">${list.map(v => `<option value="${v}" ${v === current ? 'selected' : ''}>${esc(text(v))}</option>`).join('')}</select>`;
}

const validLength = v => Number.isInteger(v) && v >= 5 && v <= 480;
function lengthChips(chosen, extra = []) {
  const full = chosen.length >= MAX_DURATION_OPTIONS;
  return [...new Set([...COMMON_DURATIONS, ...extra, ...chosen])].filter(validLength).sort((a, b) => a - b).map(v => { const on = chosen.includes(v); return `<label class="len-chip"><input type="checkbox" name="durationOption" value="${v}" ${on ? 'checked' : ''} ${!on && full ? 'disabled' : ''}><span>${v} min</span></label>`; }).join('');
}
/** Length chips. Several on means guests choose; the hidden default keeps today's pre-selected length. */
export function lengthMarkup(t) {
  const duration = validLength(t.duration) ? t.duration : 30, chosen = guestDurations({ ...t, duration });
  return `<div class="le-line le-length" role="group" aria-labelledby="le-length-key" data-duration-editor><span class="le-key" id="le-length-key">Length</span><div><input type="hidden" name="duration" value="${duration}"><span class="len-chips" data-len-chips>${lengthChips(chosen)}</span><button type="button" class="len-add" data-len-add aria-label="Other length">+</button><span class="len-custom" data-len-custom hidden><input type="text" inputmode="numeric" aria-label="Minutes" placeholder="min"></span><p class="len-note" data-len-note role="status">${chosen.length > 1 ? 'Guests choose' : ''}</p></div></div>`;
}
/** Keeps at least one length, at most four, and a default that is one of them. */
export function bindLength(form) {
  const box = form.querySelector('[data-duration-editor]');
  if (!box) return;
  const hidden = form.elements.duration, chips = box.querySelector('[data-len-chips]'), note = box.querySelector('[data-len-note]'), custom = box.querySelector('[data-len-custom]'), input = custom.querySelector('input');
  const extra = new Set(), chosen = () => [...chips.querySelectorAll('input:checked')].map(i => Number(i.value));
  const redraw = list => { chips.innerHTML = lengthChips(list, [...extra]); if (!list.includes(Number(hidden.value))) hidden.value = String(Math.min(...list)); note.textContent = list.length > 1 ? 'Guests choose' : ''; };
  chips.addEventListener('change', event => {
    const list = chosen();
    if (!list.length) { event.target.checked = true; return; }
    redraw(list);
    chips.querySelector(`input[value="${event.target.value}"]`)?.focus();
  });
  const add = () => {
    const value = Number(input.value.trim());
    custom.hidden = true; input.value = '';
    if (!validLength(value)) return;
    const list = chosen();
    if (!list.includes(value) && list.length < MAX_DURATION_OPTIONS) list.push(value);
    extra.add(value); redraw(list);
    form.dispatchEvent(new Event('change'));
  };
  box.querySelector('[data-len-add]').onclick = () => { custom.hidden = false; input.focus(); };
  for (const type of ['input', 'change']) input.addEventListener(type, event => event.stopPropagation());
  input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); add(); } if (event.key === 'Escape') { custom.hidden = true; input.value = ''; } };
  input.onblur = add;
}

/** Hours a link has of its own, or null when it uses the person's availability. */
export function ownHoursOf(t) {
  if (t.useDefaultSchedule || t.scheduleId) return null;
  return { zone: t.zone, weeklyHours: structuredClone(hoursFor(t)), dateOverrides: structuredClone(t.dateOverrides ?? {}) };
}

function summaries(t) {
  const questions = (t.questions ?? []).length, reminders = t.reminder === false ? [] : t.reminderMinutes ?? (t.reminder ? [1440] : []);
  const capacity = ['daily', 'weekly', 'monthly', 'yearly'].reduce((n, p) => n + Number(Boolean(t[`${p}BookingLimit`])) + Number(Boolean(t[`${p}BookedMinutesLimit`])), 0) + Number(Boolean(t.singleUse || t.expiresAt));
  const cancel = t.cancellationNoticeMinutes ?? 0, move = t.rescheduleNoticeMinutes ?? 0;
  return {
    questions: `Name, email${questions ? `, ${questions} question${questions === 1 ? '' : 's'}` : ''}`,
    reminders: reminders.length ? reminders.map(m => `${minutesText(m)} before`).join(', ') : 'Off',
    changes: cancel === 0 && move === 0 ? 'Any time' : cancel === move ? `Up to ${minutesText(cancel)} before` : `Cancel ${cancel ? `up to ${minutesText(cancel)} before` : 'any time'} · move ${move ? `up to ${minutesText(move)} before` : 'any time'}`,
    limits: capacity ? `${capacity} limit${capacity === 1 ? '' : 's'}` : 'None',
    look: `${t.theme === 'dark' ? 'Dark' : 'Light'} · ${(t.accent || 'graphite').replace(/^./, c => c.toUpperCase())}`
  };
}

/** ctx: {settings, calendars, team, features, notificationSender, ownHours, dirty, openRows} */
export function editorMarkup(t, ctx) {
  const { settings } = ctx, own = ctx.ownHours, s = summaries(t), connected = (settings.accounts ?? []).filter(a => a.connected && !a.ownerMemberId);
  const override = !t.teamScheduling && t.useDefaultCalendar === false && t.calendarId;
  const calendarName = (ctx.calendars ?? []).flatMap(a => (Array.isArray(a.calendars) ? a.calendars : a.calendars?.items ?? []).map(c => ({ ...c, accountId: a.id }))).find(c => c.id === t.calendarId)?.summary || t.calendarId;
  const approvalHolds = [60, 240, 720, 1440, 2880, 10080];
  const rowOpen = key => ctx.openRows?.has(key) ? 'open' : '';
  return `<form id="meeting-form" class="link-editor" novalidate>
<div class="le-head"><button type="button" class="back-to-links" id="back-to-links">← Links</button><div class="le-title"><h1>${esc(t.title)}</h1><label class="publish-toggle"><span data-publish-label>${t.published ? 'On' : 'Off'}</span><input type="checkbox" name="published" role="switch" aria-label="Accept bookings" ${t.published ? 'checked' : ''}><span class="publish-switch" aria-hidden="true"></span></label></div></div>
<div class="le-grid"><div class="le-main">
<section class="le-block" aria-labelledby="le-meeting"><h3 id="le-meeting">The meeting</h3>
<label class="sr-only" for="edit-title">Meeting name</label><input id="edit-title" name="title" class="le-name" value="${esc(t.title)}" required maxlength="160">
${lengthMarkup(t)}
<div class="le-line"><span class="le-key"><label for="edit-locationType">Where</label></span><div class="le-where"><select id="edit-locationType" name="locationType" class="inline-select">${[['google_meet', 'Google Meet'], ['custom', 'Link or place']].map(([v, l]) => `<option value="${v}" ${(t.locationType || 'custom') === v ? 'selected' : ''}>${l}</option>`).join('')}</select><span id="custom-location" ${(t.locationType || 'custom') === 'custom' ? '' : 'hidden'}><label class="sr-only" for="edit-location">Meeting link or place</label><input id="edit-location" name="location" value="${esc(t.location)}" placeholder="Link, phone or address"></span></div></div>
<div class="le-line"><span class="le-key"><label for="edit-slug">Link</label></span><div class="le-slug"><span aria-hidden="true">/</span><input id="edit-slug" name="slug" value="${esc(t.slug)}" required pattern="[a-z0-9][a-z0-9\\-]{0,63}"></div></div>
<div class="le-line le-top"><span class="le-key"><label for="edit-description">About</label></span><textarea id="edit-description" name="description" maxlength="600" rows="2">${esc(t.description)}</textarea></div>
</section>
<section class="le-block" aria-labelledby="le-when"><h3 id="le-when">When people can book</h3><div class="le-sentences">
<p><label class="sr-only" for="edit-hours">Hours</label><select class="inline-select" id="edit-hours" name="scheduleId" data-hours-mode><option value="__default__" ${own ? '' : 'selected'}>Any time I’m available</option><option value="" ${own ? 'selected' : ''}>Different times for this link…</option></select>${own ? ` <span class="le-own" data-own-hours-summary>${esc(weeklySummary(own.weeklyHours))}</span> <button type="button" class="link-button" data-edit-own-hours>Edit times</button>` : ''}</p>
<p>At least ${choice('notice', 'Earliest someone can book', [0, 30, 60, 120, 240, 720, 1440], t.notice)} ahead, and up to ${choice('horizon', 'How far ahead', [7, 14, 28, 30, 60], t.horizon, horizonText)} out.</p>
<p>Keep ${choice('bufferBefore', 'Free before each meeting', [0, 5, 10, 15, 30, 60], t.bufferBefore ?? t.buffer)} free before and ${choice('bufferAfter', 'Free after each meeting', [0, 5, 10, 15, 30, 60], t.bufferAfter ?? t.buffer)} after.</p>
<p><label class="switch-line"><input type="checkbox" name="requiresApproval" role="switch" ${t.requiresApproval ? 'checked' : ''}><span class="publish-switch" aria-hidden="true"></span> I approve each booking</label></p>
<p data-approval-expiry ${t.requiresApproval ? '' : 'hidden'}>Requests hold the time for ${choice('approvalExpiryMinutes', 'Hold requests for', approvalHolds, t.approvalExpiryMinutes || 1440)}</p>${ctx.features?.bookingEmails === false ? `<p class="le-note" data-approval-expiry ${t.requiresApproval ? '' : 'hidden'}>Email alerts are unavailable. Requests show in Bookings.</p>` : ''}
</div></section>
${ctx.team ? `<section class="le-block" aria-labelledby="le-hosts"><h3 id="le-hosts">Hosts</h3>${teamEditorMarkup(t, settings, ctx.calendars)}</section>` : ''}
${override ? `<p class="le-override" data-calendar-override>Bookings go to <b>${esc(calendarName)}</b> for this link · <button type="button" class="link-button" data-reset-calendar>Reset</button></p>` : ''}
<input type="hidden" name="destinationChoice" value="${esc(override ? t.calendarId : FOLLOW)}">
${!t.teamScheduling && connected.length > 1 ? `<p class="le-account"><label for="edit-account">Calendar account</label> <select id="edit-account" name="accountId" class="inline-select">${connected.map(a => `<option value="${esc(a.id)}" ${a.id === t.accountId ? 'selected' : ''}>${esc(a.email)}</option>`).join('')}</select></p>` : `<input type="hidden" name="accountId" value="${esc(t.accountId ?? '')}">`}
<input type="hidden" name="host" value="${esc(t.host)}"><input type="hidden" name="company" value="${esc(t.company)}">
<div class="le-rows">
<details class="le-row" data-row="questions" ${rowOpen('questions')}><summary>Questions <span>${esc(s.questions)}</span></summary><div class="le-row-body">${questionsEditorMarkup(t)}</div></details>
<details class="le-row" data-row="reminders" ${rowOpen('reminders')}><summary>Reminder emails <span>${esc(s.reminders)}</span></summary><div class="le-row-body">${remindersMarkup(t, ctx.features?.reminders, ctx.notificationSender)}</div></details>
<details class="le-row" data-row="changes" ${rowOpen('changes')}><summary>Cancelling and rescheduling <span>${esc(s.changes)}</span></summary><div class="le-row-body">${changeRulesMarkup(t)}</div></details>
<details class="le-row" data-row="limits" ${rowOpen('limits')}><summary>Limits <span>${esc(s.limits)}</span></summary><div class="le-row-body"><p class="le-sentence">Start times every ${choice('slotInterval', 'Offer start times every', [5, 10, 15, 20, 30, 45, 60], t.slotInterval ?? 15)}.</p>${capacityMarkup(t)}<p class="hint" data-time-limit-warning role="status" hidden></p>${linkAccessMarkup(t, { access: accessFor(settings, t.id) })}</div></details>
<details class="le-row" data-row="look" ${rowOpen('look')}><summary>Look <span>${esc(s.look)}</span></summary><div class="le-row-body appearance-controls">${[['theme', 'Theme', [['light', 'Light'], ['dark', 'Dark']]], ['accent', 'Accent', [['graphite', 'Graphite'], ['iris', 'Iris'], ['sage', 'Sage'], ['clay', 'Clay']]], ['motion', 'Transitions', [['smooth', 'Smooth'], ['none', 'Instant']]]].map(([name, label, choices]) => `<fieldset class="appearance-choice ${name === 'accent' ? 'accent-choice' : ''}"><legend>${label}</legend><div class="appearance-options">${choices.map(([value, title]) => `<label><input type="radio" name="${name}" value="${value}" ${(t[name] || (name === 'motion' ? 'smooth' : '')) === value ? 'checked' : ''}><span ${name === 'accent' ? `data-swatch="${value}"` : ''}>${name === 'accent' ? `<i aria-hidden="true"></i><span class="sr-only">${title}</span>` : title}</span></label>`).join('')}</div></fieldset>`).join('')}<button class="link-button" type="button" data-profile="appearance">Name and picture ↗</button></div></details>
</div>
<button type="button" class="danger-quiet le-delete" id="remove-type">Delete link</button>
</div>
<aside class="le-preview" aria-label="What guests see"><span class="le-lab">What guests see</span><div data-live-preview><p class="muted">Loading times…</p></div></aside>
</div>
<div class="le-save" data-save-bar><span id="editor-save-state" role="status">${ctx.dirty ? 'Unsaved changes' : ''}</span><button type="button" class="secondary compact-button" data-discard ${ctx.dirty ? '' : 'hidden'}>Discard</button><button type="submit" class="primary compact-button">Save</button></div>
</form>`;
}

/** Reads the form, then applies the link's own times (kept outside the form). */
export function readEditor(form, old, accounts, ownHours) {
  const t = readMeetingForm(form, old, accounts);
  if (!t.useDefaultSchedule && !t.scheduleId) {
    const hours = ownHours ?? ownHoursOf(old) ?? null;
    if (!hours) throw Error('Set the times for this link.');
    Object.assign(t, { zone: hours.zone, weeklyHours: hours.weeklyHours, dateOverrides: hours.dateOverrides });
    validateConfig(t);
  }
  return t;
}

/** Open times as a guest would see them, minus busy events when we have them. */
export function previewSlots(draft, { availability, busy = [], now = Date.now(), days = 14 } = {}) {
  const hours = draft.useDefaultSchedule ? availability : null;
  const config = validateConfig({ ...DEFAULT, ...draft, ...(hours ? { zone: hours.zone, weeklyHours: hours.weeklyHours, dateOverrides: hours.dateOverrides } : {}), expiresAt: null, singleUse: false, teamScheduling: null });
  config.durationOptions = normalizeDurationOptions(draft.durationOptions ?? null, draft.duration);
  config.duration = selectDuration({ duration: draft.duration, durationOptions: config.durationOptions });
  const before = (config.bufferBefore ?? config.buffer) * 60000, after = (config.bufferAfter ?? config.buffer) * 60000;
  const slots = policySlots(config, now, now, now + days * 86400000).filter(slot => !busy.some(b => slot.start - before < b.end && slot.end + after > b.start));
  return { config, slots };
}

export function previewMarkup({ config, slots }, { hostName, selected, fmt }) {
  const dayKey = ms => fmt(ms, { year: 'numeric', month: '2-digit', day: '2-digit' }), byDay = new Map();
  for (const slot of slots) { const key = dayKey(slot.start); if (!byDay.has(key)) byDay.set(key, []); byDay.get(key).push(slot); }
  const keys = [...byDay.keys()], chosen = byDay.has(selected) ? selected : keys[0], start = Date.now();
  const days = Array.from({ length: 14 }, (_, i) => start + i * 86400000);
  const lengths = guestDurations(config);
  return `<div class="mini"><div class="muted mini-host">${esc(hostName)}</div><div class="mini-title">${esc(config.title)}</div>${lengths.length > 1 ? `<div class="mini-chips">${lengths.map(m => `<span class="chip${m === config.duration ? ' on' : ''}">${m} min</span>`).join('')}</div>` : `<div class="muted mini-len">${config.duration} min</div>`}
<div class="mini-cal" role="group" aria-label="Days with open times">${days.map(ms => { const key = dayKey(ms), open = byDay.has(key); return `<button type="button" class="${open ? 'a' : ''}${key === chosen ? ' s' : ''}" data-preview-day="${key}" ${open ? '' : 'disabled'} aria-label="${esc(fmt(ms, { weekday: 'long', day: 'numeric', month: 'long' }))}${open ? '' : ', no times'}"><small>${esc(fmt(ms, { weekday: 'narrow' }))}</small>${esc(fmt(ms, { day: 'numeric' }))}</button>`; }).join('')}</div>
${chosen ? `<div class="mini-day">${esc(fmt(byDay.get(chosen)[0].start, { weekday: 'short', day: 'numeric', month: 'short' }))}</div><div class="mini-slots">${byDay.get(chosen).slice(0, 12).map(slot => `<span>${esc(fmt(slot.start, { hour: '2-digit', minute: '2-digit', hour12: false }))}</span>`).join('')}</div>` : '<p class="muted mini-none">No open times in the next two weeks.</p>'}</div>`;
}
