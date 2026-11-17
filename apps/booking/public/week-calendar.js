// Availability as a week calendar: drag on empty space to add hours, drag an
// edge to resize, drag a block to move it to another time or day, click a
// block to remove it. Real calendar events sit
// underneath. Works on one schedule {zone, weeklyHours, dateOverrides}, either
// "Every week" (weeklyHours) or "This week only" (dateOverrides).
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const SNAP = 15;
const DAY_MINUTES = 1440;
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ----- dates as 'YYYY-MM-DD' keys -----
const parse = key => key.split('-').map(Number);
export function addDays(key, days) {
  const [y, m, d] = parse(key);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
export function weekdayOf(key) {
  const [y, m, d] = parse(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function mondayOf(key) {
  return addDays(key, -((weekdayOf(key) + 6) % 7));
}
export function weekDates(monday) {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
export function todayKey(zone, now = Date.now()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(k => p.find(x => x.type === k).value).join('-');
}
export function weekLabel(monday) {
  const end = addDays(monday, 6), [, m1, d1] = parse(monday), [, m2, d2] = parse(end);
  return m1 === m2 ? `${d1}–${d2} ${MONTHS[m2 - 1]}` : `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]}`;
}
export function dayLabel(key) {
  const [, m, d] = parse(key);
  return `${WEEKDAYS[weekdayOf(key)]} ${d} ${MONTHS[m - 1]}`;
}

// ----- time zones -----
function offsetMinutes(ms, zone) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms);
  const get = type => Number(p.find(x => x.type === type).value);
  return (Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ms / 1000) * 1000) / 60000;
}
/** The instant a wall-clock time on a date happens in a zone. */
export function zonedEpoch(key, minute, zone) {
  const [y, m, d] = parse(key), wall = Date.UTC(y, m - 1, d, 0, minute);
  let guess = wall;
  for (let i = 0; i < 3; i++) guess = wall - offsetMinutes(guess, zone) * 60000;
  return guess;
}
/** Date key and minute of the day for an instant in a zone. */
export function localParts(ms, zone) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(ms);
  const get = type => p.find(x => x.type === type).value;
  return { key: `${get('year')}-${get('month')}-${get('day')}`, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

// ----- ranges in minutes since midnight -----
export const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
export const rangeText = r => `${clock(r.start)}–${clock(r.end)}`;
export const snap = minute => Math.max(0, Math.min(DAY_MINUTES, Math.round(minute / SNAP) * SNAP));
/** Sorted, merged, within the day, at least one step long. */
export function normalize(ranges) {
  const sorted = (ranges ?? [])
    .map(r => ({ start: Math.max(0, Math.min(DAY_MINUTES, Math.round(r.start))), end: Math.max(0, Math.min(DAY_MINUTES, Math.round(r.end))) }))
    .filter(r => r.end - r.start >= SNAP)
    .sort((a, b) => a.start - b.start), merged = [];
  for (const r of sorted) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}
export const addRange = (ranges, range) => normalize([...(ranges ?? []), range]);
export const removeRange = (ranges, index) => normalize((ranges ?? []).filter((_, i) => i !== index));
export const replaceRange = (ranges, index, range) => normalize((ranges ?? []).map((r, i) => i === index ? range : r));

// ----- schedules -----
const overrides = schedule => schedule?.dateOverrides ?? {};
export const hasOverride = (schedule, key) => Object.hasOwn(overrides(schedule), key);
/** What the grid shows for a date: the usual hours, or this week's change. */
export function rangesFor(schedule, key, mode) {
  if (mode === 'week' && hasOverride(schedule, key)) return overrides(schedule)[key];
  return schedule?.weeklyHours?.[weekdayOf(key)] ?? [];
}
export function withRanges(schedule, key, mode, ranges) {
  if (mode === 'every') return { ...schedule, weeklyHours: { ...schedule.weeklyHours, [weekdayOf(key)]: normalize(ranges) } };
  return { ...schedule, dateOverrides: { ...overrides(schedule), [key]: normalize(ranges) } };
}
/** Moves one block to a new time, on the same day or another day of the view. */
export function moveRange(schedule, mode, fromKey, index, toKey, range) {
  const source = rangesFor(schedule, fromKey, mode);
  if (fromKey === toKey) return withRanges(schedule, fromKey, mode, replaceRange(source, index, range));
  const without = withRanges(schedule, fromKey, mode, removeRange(source, index));
  return withRanges(without, toKey, mode, addRange(rangesFor(without, toKey, mode), range));
}
export function useUsualHours(schedule, key) {
  const next = { ...overrides(schedule) };
  delete next[key];
  return { ...schedule, dateOverrides: next };
}
export const dayOff = (schedule, key) => ({ ...schedule, dateOverrides: { ...overrides(schedule), [key]: [] } });
export const weekChanges = (schedule, dates) => dates.filter(key => hasOverride(schedule, key));
export function undoWeek(schedule, dates) {
  const next = { ...overrides(schedule) };
  for (const key of dates) delete next[key];
  return { ...schedule, dateOverrides: next };
}
/** Minutes open across dates: the hours that apply minus busy events. */
export function openMinutes(schedule, dates, events = []) {
  let total = 0;
  const busy = events.filter(e => !e.allDay).map(e => [e.start, e.end]);
  for (const key of dates) {
    const ranges = hasOverride(schedule, key) ? overrides(schedule)[key] : schedule.weeklyHours?.[weekdayOf(key)] ?? [];
    for (const r of ranges) {
      const start = zonedEpoch(key, r.start, schedule.zone), end = zonedEpoch(key, r.end, schedule.zone);
      let free = end - start;
      const overlaps = busy.map(([s, e]) => [Math.max(s, start), Math.min(e, end)]).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
      let cursor = start;
      for (const [s, e] of overlaps) {
        if (e <= cursor) continue;
        free -= e - Math.max(s, cursor);
        cursor = e;
      }
      total += free / 60000;
    }
  }
  return Math.max(0, Math.round(total));
}
export function hoursText(minutes) {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hour${hours === 1 ? '' : 's'}`;
}
/** "Mon–Fri 09:00–17:00" style summary for one schedule. */
export function weeklySummary(weeklyHours) {
  const groups = [];
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    const text = (weeklyHours?.[day] ?? []).map(rangeText).join(', ');
    if (!text) continue;
    const last = groups.at(-1);
    if (last && last.text === text && last.days.at(-1) === (day + 6) % 7) last.days.push(day);
    else groups.push({ text, days: [day] });
  }
  return groups.map(g => `${WEEKDAYS[g.days[0]]}${g.days.length > 1 ? '–' + WEEKDAYS[g.days.at(-1)] : ''} ${g.text}`).join(', ') || 'No hours';
}

// ----- a block's label and the events drawn over it (sizes in px) -----
// Busy events sit on top of availability blocks. A block's time label goes in
// the first stretch of the block that no event covers. If events cover all of
// it, the label sits over them, clear of their titles.
const EVENT_MIN = 14, EVENT_LINE = 12, LABEL_GAP = 4, LABEL_LINE = 17;
/** Start of the first stretch from `from` to `to`, `need` tall, that no [start, end] span overlaps; null if none fits. */
export function freeSpot(from, to, spans, need) {
  let at = from;
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (end <= at) continue;
    if (start >= at + need) break;
    at = end;
  }
  return at + need <= to ? at : null;
}
/** Where a block's label goes: its top inside the block, and whether it has to sit over events. */
export function labelPlace(blockTop, blockBottom, spans, labelHeight = LABEL_LINE) {
  const need = labelHeight + 2 * LABEL_GAP, from = blockTop + LABEL_GAP;
  const clear = freeSpot(from, blockBottom, spans, need);
  if (clear !== null) return { top: clear + LABEL_GAP - blockTop, over: false };
  const titles = freeSpot(from, blockBottom, spans.map(([start]) => [start, start + EVENT_MIN]), need);
  return { top: (titles ?? from) + LABEL_GAP - blockTop, over: true };
}
/** Places labels again with measured sizes: in a narrow column a label wraps onto two lines. */
export function placeLabels(grid) {
  for (const col of grid.querySelectorAll('[data-col]')) {
    const top = col.getBoundingClientRect().top;
    const spans = [...col.querySelectorAll('.wk-event')].map(event => { const r = event.getBoundingClientRect(); return [r.top - top, r.bottom - top]; });
    for (const block of col.querySelectorAll('.wk-block')) {
      const label = block.querySelector('.wk-label');
      if (!label?.offsetHeight) continue;
      const r = block.getBoundingClientRect(), place = labelPlace(r.top - top, r.bottom - top, spans, label.offsetHeight);
      label.style.top = `${Math.round(place.top)}px`;
      label.classList.toggle('over', place.over);
    }
  }
}

// ----- events placed on the grid -----
function placeEvents(events, dates, zone) {
  const placed = new Map(dates.map(key => [key, []])), allDay = new Map(dates.map(key => [key, []]));
  for (const event of events ?? []) {
    if (event.allDay) {
      for (const key of dates) if (key >= event.startDate && key < event.endDate) allDay.get(key).push(event);
      continue;
    }
    for (const key of dates) {
      const dayStart = zonedEpoch(key, 0, zone), dayEnd = zonedEpoch(addDays(key, 1), 0, zone);
      const start = Math.max(event.start, dayStart), end = Math.min(event.end, dayEnd);
      if (end <= start) continue;
      placed.get(key).push({ ...event, top: localParts(start, zone).minute, bottom: end >= dayEnd ? DAY_MINUTES : localParts(end, zone).minute });
    }
  }
  for (const list of placed.values()) {
    list.sort((a, b) => a.top - b.top);
    list.forEach((event, i) => { event.lane = list.slice(0, i).filter(other => other.bottom > event.top).length % 3; });
  }
  return { placed, allDay };
}

function visibleHours(schedule, dates, mode, placed) {
  let first = 8 * 60, last = 18 * 60;
  for (const key of dates) {
    for (const r of rangesFor(schedule, key, mode)) { first = Math.min(first, r.start); last = Math.max(last, r.end); }
    for (const e of placed.get(key) ?? []) { first = Math.min(first, e.top); last = Math.max(last, e.bottom); }
  }
  return { from: Math.max(0, Math.floor(first / 60) - (first % 60 ? 0 : 1)), to: Math.min(24, Math.ceil(last / 60) + 1) };
}

/** Markup for the grid. Pure, so pages can render it with the rest of the page. */
export function weekMarkup({ schedule, mode = 'every', monday, events = [], today = '', editable = true, label = 'Availability' }) {
  const dates = weekDates(monday), { placed, allDay } = placeEvents(events, dates, schedule.zone), { from, to } = visibleHours(schedule, dates, mode, placed);
  const hourHeight = 44, minuteTop = minute => ((minute - from * 60) / 60) * hourHeight, height = (to - from) * hourHeight;
  const anyAllDay = [...allDay.values()].some(list => list.length);
  return `<div class="wk${editable ? '' : ' wk-readonly'}" data-week data-mode="${mode}" data-from="${from}" data-to="${to}" style="--hour:${hourHeight}px" aria-label="${esc(label)}">
<div class="wk-head"><div class="wk-gut"></div>${dates.map(key => {
    const off = mode === 'week' ? hasOverride(schedule, key) && !rangesFor(schedule, key, mode).length : false;
    const changed = hasOverride(schedule, key), [, , d] = parse(key), past = mode === 'week' && today && key < today;
    return `<button type="button" class="wk-day${off ? ' off' : ''}${changed ? ' chg' : ''}${key === today ? ' today' : ''}" data-day="${key}" aria-haspopup="menu" ${past ? 'disabled' : ''} aria-label="${LONG_DAYS[weekdayOf(key)]} ${d}${changed ? ', changed this week' : ''}">${WEEKDAYS[weekdayOf(key)]}<small>${d}${off ? ' · Off' : ''}</small></button>`;
  }).join('')}</div>${anyAllDay ? `<div class="wk-allday"><div class="wk-gut"></div>${dates.map(key => `<div>${allDay.get(key).map(e => `<span class="wk-chip" style="--c:${esc(e.color || '#8a8a90')}" title="${esc(e.title || 'Busy')}">${esc(e.title || 'Busy')}</span>`).join('')}</div>`).join('')}</div>` : ''}
<div class="wk-body" style="height:${height}px"><div class="wk-times" aria-hidden="true">${Array.from({ length: to - from }, (_, i) => `<span style="top:${i * hourHeight}px">${String(from + i).padStart(2, '0')}</span>`).join('')}</div>${dates.map(key => {
    const ranges = rangesFor(schedule, key, mode), offDay = mode === 'week' && hasOverride(schedule, key) && !ranges.length, past = mode === 'week' && today && key < today, canEdit = editable && !past;
    const dayEvents = (placed.get(key) ?? []).map(e => ({ ...e, y: minuteTop(e.top), h: Math.max(EVENT_MIN, minuteTop(e.bottom) - minuteTop(e.top)) })), spans = dayEvents.map(e => [e.y, e.y + e.h]);
    const block = (r, i) => {
      const top = minuteTop(r.start), bottom = minuteTop(r.end), place = labelPlace(top, bottom, spans);
      return `<button type="button" class="wk-block" data-block="${i}" style="top:${top}px;height:${bottom - top}px" aria-label="${esc(dayLabel(key))} ${rangeText(r)}${canEdit ? '. Remove' : ''}" ${canEdit ? '' : 'disabled'}><span class="wk-label${place.over ? ' over' : ''}" style="top:${Math.round(place.top)}px">${rangeText(r)}</span>${canEdit ? '<i class="wk-handle" data-handle="start" aria-hidden="true"></i><i class="wk-handle" data-handle="end" aria-hidden="true"></i>' : ''}</button>`;
    };
    // A long title gets as many lines as the event is tall and ends in an ellipsis; the tooltip and screen readers get all of it.
    const event = e => {
      const name = e.title || 'Busy', time = `${clock(e.top)}–${clock(Math.min(e.bottom, DAY_MINUTES))}`, lines = Math.max(1, Math.floor((e.h - 2) / EVENT_LINE));
      const onBlock = ranges.some(r => e.top < r.end && e.bottom > r.start);
      return `<div class="wk-event${e.booking ? ' wk-booked' : ''}" data-lane="${e.lane}"${onBlock ? ' data-on-block' : ''} style="top:${e.y}px;height:${e.h}px;--c:${esc(e.color || '#8a8a90')}" title="${esc(name)} ${time}"><span class="wk-event-title"${lines > 1 ? ` style="-webkit-line-clamp:${lines}"` : ''}>${esc(name)}</span><span class="sr-only">, ${time}</span></div>`;
    };
    return `<div class="wk-col${offDay ? ' offday' : ''}${past ? ' past' : ''}" data-col="${key}" role="group" aria-label="${esc(dayLabel(key))}">${ranges.map(block).join('')}${dayEvents.map(event).join('')}</div>`;
  }).join('')}</div></div>`;
}

/**
 * Wires drag, resize and remove on a rendered grid. onChange receives the next
 * schedule; the page saves it and re-renders. onDay(key, button) opens the
 * day menu. On touch screens there is no dragging: taps open the day editor.
 */
export function bindWeek(root, { schedule, mode, onChange, onDay, editable = true, coarse = matchMedia?.('(pointer: coarse)').matches }) {
  const grid = root.querySelector('[data-week]');
  if (!grid) return () => {};
  placeLabels(grid);
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => placeLabels(grid)) : null;
  resize?.observe(grid);
  const unobserve = () => resize?.disconnect();
  const from = Number(grid.dataset.from), to = Number(grid.dataset.to), hourHeight = 44;
  const minuteAt = (col, clientY) => snap(from * 60 + ((clientY - col.getBoundingClientRect().top) / hourHeight) * 60);
  // Events take the pointer only for their tooltip: a press goes to the block or empty column underneath.
  const under = event => event.target.closest?.('.wk-event') ? document.elementsFromPoint(event.clientX, event.clientY).find(el => !el.closest('.wk-event')) || event.target : event.target;
  grid.querySelectorAll('[data-day]').forEach(button => button.onclick = () => onDay?.(button.dataset.day, button));
  if (!editable) return unobserve;
  if (coarse) {
    grid.querySelectorAll('[data-col]:not(.past)').forEach(col => col.onclick = event => onDay?.(col.dataset.col, under(event).closest('.wk-block') || col, { edit: true }));
    return unobserve;
  }
  let drag = null;
  const ghost = document.createElement('div');
  ghost.className = 'wk-ghost';
  const place = (top, bottom) => {
    const y = minute => ((minute - from * 60) / 60) * hourHeight;
    ghost.style.top = `${y(top)}px`;
    ghost.style.height = `${Math.max(4, y(bottom) - y(top))}px`;
    ghost.textContent = `${clock(top)}–${clock(bottom)}`;
  };
  const reset = () => {
    drag = null;
    ghost.remove();
    grid.classList.remove('dragging', 'moving');
    grid.querySelectorAll('.resizing,.lifted').forEach(b => b.classList.remove('resizing', 'lifted'));
  };
  // The column under the pointer, clamped to the first and last day.
  const columnAt = clientX => {
    const cols = [...grid.querySelectorAll('[data-col]')], i = cols.findIndex(col => clientX < col.getBoundingClientRect().right);
    return cols[i < 0 ? cols.length - 1 : i];
  };
  function down(event) {
    if (event.button !== 0) return;
    const target = under(event), col = target.closest('[data-col]'), block = target.closest('.wk-block'), handle = target.closest('[data-handle]');
    if (!col || col.classList.contains('past')) return;
    const key = col.dataset.col, ranges = rangesFor(schedule, key, mode), start = minuteAt(col, event.clientY);
    // A press on a block is a click (remove) until the pointer travels a few pixels; then it moves the block.
    if (block && !handle) {
      const index = Number(block.dataset.block);
      drag = { kind: 'press', key, block, index, range: ranges[index], target: col, x: event.clientX, y: event.clientY };
      return;
    }
    event.preventDefault();
    if (handle) {
      const index = Number(block.dataset.block), range = ranges[index];
      drag = { kind: 'resize', key, col, index, edge: handle.dataset.handle, top: range.start, bottom: range.end, moved: false };
      block.classList.add('resizing');
    } else drag = { kind: 'create', key, col, anchor: start, top: start, bottom: start, moved: false };
    col.setPointerCapture?.(event.pointerId);
    col.append(ghost);
    place(drag.top, drag.bottom);
    grid.classList.add('dragging');
  }
  const travelled = event => Math.abs(event.clientX - drag.x) >= 4 || Math.abs(event.clientY - drag.y) >= 4;
  function move(event) {
    if (!drag) return;
    if (drag.kind === 'press') {
      if (!travelled(event) || !drag.range) return;
      drag.kind = 'move';
      grid.setPointerCapture?.(event.pointerId);
      drag.block.classList.add('lifted');
      grid.classList.add('dragging', 'moving');
    }
    if (drag.kind === 'move') {
      const col = columnAt(event.clientX), length = drag.range.end - drag.range.start;
      if (!col.classList.contains('past')) drag.target = col;
      const shift = Math.round(((event.clientY - drag.y) / hourHeight) * 60 / SNAP) * SNAP;
      drag.top = Math.max(from * 60, Math.min(to * 60 - length, drag.range.start + shift));
      drag.bottom = drag.top + length;
      if (ghost.parentNode !== drag.target) drag.target.append(ghost);
      place(drag.top, drag.bottom);
      return;
    }
    const minute = minuteAt(drag.col, event.clientY);
    if (drag.kind === 'create') { drag.top = Math.min(drag.anchor, minute); drag.bottom = Math.max(drag.anchor, minute); }
    else if (drag.edge === 'start') drag.top = Math.min(minute, drag.bottom - SNAP);
    else drag.bottom = Math.max(minute, drag.top + SNAP);
    drag.moved = true;
    place(drag.top, drag.bottom);
  }
  function up(event) {
    if (!drag) return;
    const current = drag;
    if (current.kind === 'press' && travelled(event)) return reset();
    reset();
    const ranges = rangesFor(schedule, current.key, mode);
    if (current.kind === 'press') return onChange(withRanges(schedule, current.key, mode, removeRange(ranges, current.index)), { action: 'remove', key: current.key });
    if (current.kind === 'move') {
      const toKey = current.target.dataset.col;
      if (toKey !== current.key || current.top !== current.range.start) onChange(moveRange(schedule, mode, current.key, current.index, toKey, { start: current.top, end: current.bottom }), { action: 'move', key: toKey, from: current.key });
      return;
    }
    if (current.kind === 'create' && current.bottom - current.top >= SNAP) onChange(withRanges(schedule, current.key, mode, addRange(ranges, { start: current.top, end: current.bottom })), { action: 'add', key: current.key });
    if (current.kind === 'resize' && current.moved) onChange(withRanges(schedule, current.key, mode, replaceRange(ranges, current.index, { start: current.top, end: current.bottom })), { action: 'resize', key: current.key });
  }
  const keyBlock = event => {
    const block = event.target.closest('.wk-block'), col = event.target.closest('[data-col]');
    if (!block || !col || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    onChange(withRanges(schedule, col.dataset.col, mode, removeRange(rangesFor(schedule, col.dataset.col, mode), Number(block.dataset.block))), { action: 'remove', key: col.dataset.col });
  };
  grid.addEventListener('pointerdown', down);
  grid.addEventListener('pointermove', move);
  grid.addEventListener('pointerup', up);
  grid.addEventListener('pointercancel', reset);
  grid.addEventListener('keydown', keyBlock);
  // Escape drops whatever is being dragged and leaves the hours as they were.
  const cancel = event => { if (drag && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); reset(); } };
  document.addEventListener('keydown', cancel, true);
  return () => {
    unobserve();
    grid.removeEventListener('pointerdown', down);
    grid.removeEventListener('pointermove', move);
    grid.removeEventListener('pointerup', up);
    grid.removeEventListener('pointercancel', reset);
    grid.removeEventListener('keydown', keyBlock);
    document.removeEventListener('keydown', cancel, true);
  };
}

/** Day menu: "Off all day", "Use usual hours", "Set times…". */
export function showDayMenu(button, { key, mode, schedule, onPick }) {
  document.querySelector('.wk-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'wk-menu';
  menu.setAttribute('role', 'menu');
  const off = mode === 'week' ? hasOverride(schedule, key) && !rangesFor(schedule, key, mode).length : !(schedule.weeklyHours?.[weekdayOf(key)] ?? []).length;
  const items = mode === 'week'
    ? [['off', 'Off all day', off], ['usual', 'Use usual hours', !hasOverride(schedule, key)], ['times', 'Set times…', false]]
    : [['off', `Off every ${LONG_DAYS[weekdayOf(key)]}`, off], ['times', 'Set times…', false]];
  menu.innerHTML = items.map(([id, label, checked]) => `<button type="button" role="menuitemradio" aria-checked="${checked}" data-pick="${id}">${esc(label)}${checked ? ' <span aria-hidden="true">✓</span>' : ''}</button>`).join('');
  // Inside a modal dialog the menu must live in that dialog (the top layer), placed in viewport coordinates.
  const rect = button.getBoundingClientRect(), host = button.closest('dialog[open]');
  if (host) {
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - 208))}px`;
  } else {
    menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
    menu.style.left = `${Math.min(rect.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - 200)}px`;
  }
  (host || document.body).append(menu);
  const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
  const outside = event => { if (!menu.contains(event.target) && event.target !== button) close(); };
  const escape = event => { if (event.key === 'Escape') { event.preventDefault(); close(); button.focus(); } };
  menu.querySelectorAll('[data-pick]').forEach(item => item.onclick = () => { close(); onPick(item.dataset.pick); });
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escape, true);
  menu.querySelector('[data-pick]')?.focus();
  return close;
}

/** Exact times for one day: used from the day menu, by keyboard, and on phones. */
export function showDayEditor({ key, mode, schedule, trigger, onSave }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'wk-day-editor';
  dialog.setAttribute('aria-label', `Times on ${dayLabel(key)}`);
  let ranges = rangesFor(schedule, key, mode).map(r => ({ ...r }));
  const field = (value, i, edge) => `<input type="time" step="900" value="${clock(value === DAY_MINUTES ? DAY_MINUTES - SNAP : value)}" data-range="${i}" data-edge="${edge}" aria-label="${edge === 'start' ? 'From' : 'To'} ${i + 1}">`;
  const draw = error => {
    dialog.innerHTML = `<h2>${esc(mode === 'every' ? `Every ${LONG_DAYS[weekdayOf(key)]}` : dayLabel(key))}</h2><div class="wk-day-rows">${ranges.length ? ranges.map((r, i) => `<div class="wk-day-row">${field(r.start, i, 'start')}<span aria-hidden="true">–</span>${field(r.end, i, 'end')}<button type="button" class="icon-button" data-drop="${i}" aria-label="Remove ${i + 1}">×</button></div>`).join('') : '<p class="muted">Off</p>'}</div><button type="button" class="secondary compact-button" data-add>Add hours</button>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}<div class="row"><button type="button" class="secondary" data-cancel>Cancel</button><button type="button" class="primary" data-save>Save</button></div>`;
    dialog.querySelectorAll('[data-range]').forEach(input => input.onchange = () => {
      const [h, m] = input.value.split(':').map(Number), minute = h * 60 + m;
      ranges[Number(input.dataset.range)][input.dataset.edge] = input.dataset.edge === 'end' && minute === 0 ? DAY_MINUTES : minute;
    });
    dialog.querySelectorAll('[data-drop]').forEach(button => button.onclick = () => { ranges.splice(Number(button.dataset.drop), 1); draw(); });
    dialog.querySelector('[data-add]').onclick = () => { const last = ranges.at(-1); ranges.push(last && last.end <= 1320 ? { start: last.end + 60, end: Math.min(DAY_MINUTES, last.end + 180) } : { start: 540, end: 1020 }); draw(); dialog.querySelector('[data-range]:last-of-type')?.focus(); };
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    dialog.querySelector('[data-save]').onclick = () => {
      if (ranges.some(r => r.end <= r.start)) return draw('Each end time must be after its start.');
      dialog.close();
      onSave(withRanges(schedule, key, mode, ranges));
    };
  };
  document.body.append(dialog);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  draw();
  dialog.showModal();
  dialog.querySelector('input,button')?.focus();
}
