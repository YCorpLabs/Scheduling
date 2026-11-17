// Bookings home: requests waiting for an OK on top, then upcoming bookings by
// day. Past and Cancelled are one click away. Markup only; the Studio binds.
import { meetingLink } from './conference-ui.js';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DAY = 86400000;

export const isRequest = b => b.status === 'awaiting_approval';
export const isUpcoming = (b, now = Date.now()) => b.end >= now && ['confirmed', 'pending', 'cancelling'].includes(b.status);
export const isPast = (b, now = Date.now()) => b.end < now && b.status === 'confirmed';
export const isCancelled = b => b.status === 'cancelled';

function firstAnswer(b) {
  const answers = b.answers && typeof b.answers === 'object' ? Object.values(b.answers) : [];
  const text = [b.answer, ...answers].find(v => typeof v === 'string' && v.trim());
  return text ? `“${text.trim().length > 80 ? text.trim().slice(0, 79) + '…' : text.trim()}”` : '';
}
export function expiresIn(ms, now = Date.now()) {
  const left = ms - now;
  if (!Number.isFinite(left)) return '';
  if (left <= 0) return 'Expires now';
  const minutes = Math.round(left / 60000), hours = Math.round(left / 3600000);
  return minutes < 60 ? `Expires in ${Math.max(1, minutes)} min` : hours < 48 ? `Expires in ${hours} h` : `Expires in ${Math.round(hours / 24)} days`;
}
function placeOf(b) {
  if (meetingLink(b)) return 'Google Meet';
  if (b.conferenceStatus === 'pending') return 'Google Meet';
  return b.location || '';
}

/** fmt(ms, options) formats in the Studio time zone; zone labels the header. */
export function bookingsMarkup({ bookings, view = 'home', query = '', searching = false, fmt, zoneName, now = Date.now(), canDecide = false, deciding = {}, loading = false, setup = '', notices = '', stats = false }) {
  const time = ms => fmt(ms, { hour: '2-digit', minute: '2-digit', hour12: false });
  const dayKey = ms => fmt(ms, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = dayKey(now), tomorrow = dayKey(now + DAY);
  const dayTitle = ms => {
    const short = fmt(ms, { weekday: 'short', day: 'numeric', month: 'short' });
    return dayKey(ms) === today ? `Today · ${short}` : dayKey(ms) === tomorrow ? `Tomorrow · ${short}` : short;
  };
  const q = query.trim().toLocaleLowerCase(), matches = b => !q || [b.title, b.name, b.email].some(v => String(v || '').toLocaleLowerCase().includes(q));
  const head = `<header class="host-heading bk-heading">${view === 'home' ? '<h1>Bookings</h1>' : `<div><button type="button" class="back-to-links" data-bookings-view="home">← Bookings</button><h1>${view === 'past' ? 'Past' : 'Cancelled'}</h1></div>`}<div class="bk-tools"><span class="muted">Times in ${esc(zoneName)}</span>${searching || q ? `<label class="booking-search"><span class="sr-only">Search bookings</span><input id="booking-search" type="search" placeholder="Search" value="${esc(query)}" autocomplete="off"></label>` : '<button type="button" class="link-button" data-booking-search-open>Search</button>'}</div></header>`;
  if (loading) return `${head}${notices}<p class="bk-empty" role="status">Loading bookings…</p>`;
  const row = (b, { request = false } = {}) => {
    const join = !request && dayKey(b.start) === today && meetingLink(b), length = Math.round((b.end - b.start) / 60000);
    return `<div class="bk-row${request ? ' req' : ''}" data-booking="${esc(b.id)}">
<div class="bk-when"><b>${esc(request ? fmt(b.start, { weekday: 'short', day: 'numeric', month: 'short' }) : time(b.start))}</b><span>${esc(request ? `${time(b.start)}–${time(b.end)}` : `${length} min`)}</span></div>
<button type="button" class="bk-main" data-manage="${esc(b.id)}" aria-label="Details: ${esc(b.title)} with ${esc(b.name)}"><span class="bk-title">${esc(b.title)} · ${esc(b.name)}</span><span class="bk-sub">${esc([b.email, request ? firstAnswer(b) : placeOf(b)].filter(Boolean).join(' · '))}</span></button>
<div class="bk-acts">${request ? `<span class="bk-expiry">${esc(expiresIn(b.approvalExpiresAt ?? b.start, now))}</span>${canDecide ? deciding[b.id] === 'confirm-reject' ? `<span class="bk-confirm">Decline?</span><button type="button" class="secondary compact-button" data-decide-keep="${esc(b.id)}">Keep</button><button type="button" class="danger-button compact-button" data-decide="reject" data-booking-id="${esc(b.id)}">Decline</button>` : `<button type="button" class="secondary compact-button" data-decide-ask="${esc(b.id)}" ${deciding[b.id] ? 'disabled' : ''}>Decline</button><button type="button" class="primary compact-button" data-decide="approve" data-booking-id="${esc(b.id)}" ${deciding[b.id] ? 'disabled' : ''}>${deciding[b.id] === 'approve' ? 'Approving…' : 'Approve'}</button>` : ''}` : `${join ? `<a class="secondary compact-button" href="${esc(join)}" target="_blank" rel="noopener noreferrer">Join</a>` : ''}${b.status !== 'confirmed' ? `<span class="booking-badge state-${esc(b.status)}">${b.status === 'pending' ? 'Confirming' : 'Cancelling'}</span>` : ''}<button type="button" class="row-menu" data-row-menu="${esc(b.id)}" aria-label="More for ${esc(b.title)} with ${esc(b.name)}" aria-haspopup="menu">•••</button>`}</div>
</div>`;
  };
  const byDay = list => {
    let last = '', html = '';
    for (const b of list) {
      const key = dayKey(b.start);
      if (key !== last) { html += `${last ? '</div>' : ''}<h2 class="bk-day">${esc(dayTitle(b.start))}</h2><div class="card bk-card">`; last = key; }
      html += row(b);
    }
    return html ? html + '</div>' : '';
  };
  if (view !== 'home') {
    const list = bookings.filter(b => (view === 'past' ? isPast(b, now) : isCancelled(b)) && matches(b)).sort((a, b) => b.start - a.start);
    return `${head}<section class="bk-list" aria-label="${view === 'past' ? 'Past bookings' : 'Cancelled bookings'}">${list.length ? byDay(list) : `<p class="bk-empty">${q ? 'No matches.' : view === 'past' ? 'No past bookings.' : 'No cancelled bookings.'}</p>`}</section>`;
  }
  const requests = bookings.filter(b => isRequest(b) && matches(b)).sort((a, b) => (a.approvalExpiresAt ?? a.start) - (b.approvalExpiresAt ?? b.start));
  const upcoming = bookings.filter(b => isUpcoming(b, now) && matches(b)).sort((a, b) => a.start - b.start);
  const pastCount = bookings.filter(b => isPast(b, now)).length, cancelledCount = bookings.filter(isCancelled).length;
  return `${head}${notices}${setup}${requests.length ? `<section aria-label="Waiting for your OK"><h2 class="bk-section">Waiting for your OK</h2><div class="card bk-card req">${requests.map(b => row(b, { request: true })).join('')}</div></section>` : ''}<section class="bk-list" aria-label="Upcoming bookings">${upcoming.length ? byDay(upcoming) : `<p class="bk-empty">${q ? 'No matches.' : 'No upcoming bookings.'}</p>`}</section><p class="bk-more"><button type="button" class="link-button" data-bookings-view="past">Past${pastCount ? ` (${pastCount})` : ''}</button> · <button type="button" class="link-button" data-bookings-view="cancelled">Cancelled${cancelledCount ? ` (${cancelledCount})` : ''}</button>${stats ? ' · <button type="button" class="link-button" data-section="Analytics">Stats</button>' : ''}</p>`;
}

/** The three-step setup card shown until the first link is shared. */
export function setupMarkup({ account, destinationName, hours, zoneName, duration, linkUrl, connectHref, step }) {
  const item = (n, title, body, actions, state) => `<li class="step ${state}"><span class="n" aria-hidden="true">${state === 'done' ? '✓' : n}</span><b>${title}</b><p>${body}</p>${actions ? `<span class="step-actions">${actions}</span>` : ''}</li>`;
  return `<section class="setup-steps" aria-label="Get your booking link ready"><h2>Get your booking link ready</h2><ol class="steps">
${item(1, 'Connect your calendar', account ? `${esc(account)}. Bookings go on ${esc(destinationName || 'your calendar')}, and times you’re busy are hidden.` : 'Bookings go on your Google Calendar, and times you’re busy are hidden.', account ? '' : `<a class="primary compact-button" data-calendar-connect href="${esc(connectHref)}">Continue with Google</a>`, step > 1 ? 'done' : 'now')}
${item(2, 'Check your hours', `${esc(hours)} in ${esc(zoneName)}. People can book ${esc(duration)}-minute calls in that time.`, step === 2 ? '<button type="button" class="primary compact-button" data-setup-hours>Looks good</button><button type="button" class="secondary compact-button" data-section="Availability">Change hours</button>' : '', step > 2 ? 'done' : step === 2 ? 'now' : '')}
${item(3, step >= 3 ? 'Your link is ready' : 'Share your link', esc(linkUrl.replace(/^https?:\/\//, '')), step === 3 ? '<button type="button" class="primary compact-button" data-setup-copy>Copy link</button>' : '', step === 3 ? 'now' : '')}
</ol></section>`;
}

/** Small ••• menu anchored to a button. */
export function showRowMenu(button, items, onPick) {
  document.querySelector('.row-menu-pop')?.remove();
  const menu = document.createElement('div');
  menu.className = 'row-menu-pop';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map(([id, label, danger]) => `<button type="button" role="menuitem" data-pick="${esc(id)}" class="${danger ? 'danger' : ''}">${esc(label)}</button>`).join('');
  const rect = button.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  menu.style.left = `${Math.max(window.scrollX + 8, rect.right + window.scrollX - 180)}px`;
  document.body.append(menu);
  button.setAttribute('aria-expanded', 'true');
  const close = (focus = false) => {
    menu.remove();
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keys, true);
    if (focus && button.isConnected) button.focus();
  };
  const outside = event => { if (!menu.contains(event.target) && event.target !== button) close(); };
  const keys = event => {
    const items = [...menu.querySelectorAll('[data-pick]')], i = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    if (event.key === 'ArrowDown') { event.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  };
  menu.querySelectorAll('[data-pick]').forEach(item => item.onclick = () => { close(); onPick(item.dataset.pick); });
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keys, true);
  menu.querySelector('[data-pick]')?.focus();
  return close;
}
