// The Availability page: one week calendar plus the panel that replaced the
// Calendars page. It holds no network code: the Studio passes load and save
// functions, so the same page serves personal profiles, team members, and a
// single link's own times.
import { weekMarkup, bindWeek, showDayMenu, showDayEditor, weekDates, weekLabel, mondayOf, addDays, todayKey, weekChanges, undoWeek, useUsualHours, dayOff, openMinutes, hoursText, dayLabel, rangesFor, rangeText } from './week-calendar.js';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const chevron = d => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="${d}"/></svg>`;

export function zoneLabel(zone, now = Date.now()) {
  try {
    const name = zone.split('/').at(-1).replaceAll('_', ' '), offset = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value ?? '';
    return `${name} (${offset.replace('GMT', 'GMT')})`;
  } catch { return zone; }
}
function zoneOptions(current) {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [...new Set([current, browser, 'UTC', ...zones].filter(Boolean))].map(z => `<option value="${esc(z)}" ${z === current ? 'selected' : ''}>${esc(zoneLabel(z))}</option>`).join('');
}

/** view: {schedule, mode, monday, events, nextWeek, calendars, accounts, status, scope, title, connectHref, editable, notice} */
export function availabilityPageMarkup(view) {
  const today = todayKey(view.schedule.zone), dates = weekDates(view.monday), changes = weekChanges(view.schedule, dates);
  const head = `<div class="av-head">${view.scope === 'link' ? `<h2>${esc(view.title)}</h2>` : ''}<div class="seg" role="group" aria-label="Which weeks">${[['every', 'Every week'], ['week', 'This week only']].map(([id, label]) => `<button type="button" data-mode="${id}" aria-pressed="${view.mode === id}">${label}</button>`).join('')}</div><div class="av-nav"><button type="button" class="arrow" data-week-step="-7" aria-label="Previous week">${chevron('m15 18-6-6 6-6')}</button><span data-week-label>${esc(weekLabel(view.monday))}</span><button type="button" class="arrow" data-week-step="7" aria-label="Next week">${chevron('m9 18 6-6-6-6')}</button></div><span class="av-status" role="status" data-av-status>${esc(view.status || '')}</span></div>`;
  const panel = view.mode === 'week'
    ? `<aside class="av-panel" aria-label="This week"><div class="av-sum"><b>${changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'No changes'}</b>to this week</div>${changes.length ? `<ul class="av-changes">${changes.map(key => `<li><b>${esc(dayLabel(key).split(' ').slice(0, 2).join(' '))}</b> <span>${esc(rangesFor(view.schedule, key, 'week').map(rangeText).join(', ') || 'Off')}</span></li>`).join('')}</ul><button type="button" class="link-button" data-undo-week>Undo this week’s changes</button>` : '<p class="muted">Drag to change this week’s hours, or click a day to take it off.</p>'}</aside>`
    : panelMarkup(view);
  return `<section class="availability-page" data-availability-page aria-label="Availability">${view.notice || ''}${head}<div class="av-wrap"><div class="av-grid"${view.calendarsLoading ? ' aria-busy="true"' : ''}>${weekMarkup({ schedule: view.schedule, mode: view.mode, monday: view.monday, events: view.events, today, editable: view.editable !== false, label: view.scope === 'link' ? view.title : 'Availability' })}</div>${panel}</div></section>`;
}

function panelMarkup(view) {
  if (view.scope === 'link') return `<aside class="av-panel" aria-label="Link times"><div class="av-sum"><b>${hoursText(openMinutes(view.schedule, weekDates(addDays(mondayOf(todayKey(view.schedule.zone)), 7)), view.nextWeek?.events ?? []))}</b>open next week</div><button type="button" class="secondary compact-button" data-use-availability>Use my availability</button></aside>`;
  const accounts = view.accounts ?? [];
  const busy = accounts.length ? accounts.map(account => {
    const own = (view.calendars ?? []).filter(c => c.accountId === account.id);
    if (account.reconnect) return `<div class="av-account-block">${accounts.length > 1 ? `<p class="av-account-name">${esc(account.email)}</p>` : ''}<p class="connection-state" data-state="reconnect">Reconnect needed</p><a class="primary compact-button" data-calendar-connect href="${esc(view.connectHref)}">Reconnect Google Calendar</a></div>`;
    if (!own.length) return `<div class="av-account-block">${accounts.length > 1 ? `<p class="av-account-name">${esc(account.email)}</p>` : ''}<p class="muted">${view.calendarsLoading ? 'Loading calendars…' : 'No calendars found.'}</p></div>`;
    return `<div class="av-account-block">${accounts.length > 1 ? `<p class="av-account-name">${esc(account.email)}</p>` : ''}${own.map(c => `<label class="av-check"><input type="checkbox" data-busy="${esc(account.id)}" value="${esc(c.id)}" ${c.busy || c.destination ? 'checked' : ''} ${c.destination ? 'disabled' : ''}><span class="av-box" style="--c:${esc(c.color || '#55555c')}" aria-hidden="true"></span><span class="av-cal-name">${esc(c.summary)}</span>${c.destination ? '<span class="av-lock" title="New bookings go here">Bookings</span>' : ''}</label>`).join('')}</div>`;
  }).join('') : view.notice ? '<p class="muted">No calendar connected.</p>' : `<a class="primary compact-button" data-calendar-connect href="${esc(view.connectHref)}">Continue with Google</a>`;
  const destinations = accounts.filter(a => !a.reconnect).map(account => {
    const writable = (view.calendars ?? []).filter(c => c.accountId === account.id && ['owner', 'writer'].includes(c.accessRole));
    return writable.length ? `<label class="sr-only" for="dest-${esc(account.id)}">New bookings go to${accounts.length > 1 ? ' for ' + esc(account.email) : ''}</label><select id="dest-${esc(account.id)}" data-destination="${esc(account.id)}">${writable.some(c => c.destination) ? '' : '<option value="" selected disabled>Choose a calendar</option>'}${writable.map(c => `<option value="${esc(c.id)}" ${c.destination ? 'selected' : ''}>${esc(c.summary)}</option>`).join('')}</select>` : '';
  }).join('');
  const next = view.nextWeek ? `<div class="av-sum"><b>${hoursText(openMinutes(view.schedule, weekDates(view.nextWeek.monday), view.nextWeek.events))}</b>open next week</div>` : '';
  return `<aside class="av-panel" aria-label="Calendars"><section><h3>Busy from</h3>${busy}</section>${destinations ? `<section><h3>New bookings go to</h3>${destinations}</section>` : ''}<section><h3><label for="av-zone">Time zone</label></h3><select id="av-zone" data-zone>${zoneOptions(view.schedule.zone)}</select></section>${next}<p class="av-accounts">${accounts.map(a => `${esc(a.email)}${view.canDisconnect ? ` <button type="button" class="link-button" data-disconnect="${esc(a.id)}" aria-label="Disconnect ${esc(a.email)}">Disconnect</button>` : ''}`).join(', ')}${accounts.length ? ' · ' : ''}<a href="${esc(view.connectHref)}" data-calendar-connect>Add account</a></p></aside>`;
}

/**
 * handlers: {onSchedule(next), onMode(mode), onWeek(monday), onBusy(accountId, ids), onDestination(accountId, id), onZone(zone), onUseAvailability(), coarse}
 */
export function bindAvailabilityPage(container, view, handlers) {
  const page = container.querySelector('[data-availability-page]');
  if (!page) return () => {};
  const unbind = bindWeek(page, {
    schedule: view.schedule,
    mode: view.mode,
    editable: view.editable !== false,
    coarse: handlers.coarse,
    onChange: next => handlers.onSchedule(next),
    onDay: (key, trigger, options = {}) => {
      if (view.editable === false) return;
      if (options.edit) return showDayEditor({ key, mode: view.mode, schedule: view.schedule, trigger, onSave: handlers.onSchedule });
      showDayMenu(trigger, {
        key, mode: view.mode, schedule: view.schedule, onPick: pick => {
          if (pick === 'times') return showDayEditor({ key, mode: view.mode, schedule: view.schedule, trigger, onSave: handlers.onSchedule });
          if (pick === 'usual') return handlers.onSchedule(useUsualHours(view.schedule, key));
          if (pick === 'off') return handlers.onSchedule(view.mode === 'week' ? dayOff(view.schedule, key) : { ...view.schedule, weeklyHours: { ...view.schedule.weeklyHours, [new Date(key + 'T12:00:00Z').getUTCDay()]: [] } });
        }
      });
    }
  });
  page.querySelectorAll('button[data-mode]').forEach(button => button.onclick = () => handlers.onMode(button.dataset.mode));
  page.querySelectorAll('[data-week-step]').forEach(button => button.onclick = () => handlers.onWeek(addDays(view.monday, Number(button.dataset.weekStep))));
  const undo = page.querySelector('[data-undo-week]');
  if (undo) undo.onclick = () => handlers.onSchedule(undoWeek(view.schedule, weekDates(view.monday)));
  page.querySelectorAll('[data-busy]').forEach(box => box.onchange = () => {
    const account = box.dataset.busy, ids = [...page.querySelectorAll(`[data-busy="${CSS.escape(account)}"]:checked`)].map(b => b.value);
    handlers.onBusy?.(account, ids);
  });
  page.querySelectorAll('[data-destination]').forEach(select => select.onchange = () => handlers.onDestination?.(select.dataset.destination, select.value));
  const zone = page.querySelector('[data-zone]');
  if (zone) zone.onchange = () => handlers.onZone?.(zone.value);
  const reset = page.querySelector('[data-use-availability]');
  if (reset) reset.onclick = () => handlers.onUseAvailability?.();
  return unbind;
}

export const currentMonday = zone => mondayOf(todayKey(zone));
