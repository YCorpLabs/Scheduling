// Links: one row per booking link with its last-30-day numbers, Copy link as
// the main action and the rest in a ••• menu.
import { durationSummary } from './durations-ui.js';
import { linkStateLabel, accessFor } from './link-access-ui.js';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function linkPlace(t) {
  return t.locationType === 'google_meet' ? 'Google Meet' : t.location || '';
}

export function linksMarkup({ settings, stats = {}, savedIds, canEdit = true, copied = '' }) {
  const types = settings.meetingTypes ?? [];
  const head = `<header class="host-heading"><h1>Links</h1><div class="lk-tools"><button type="button" class="link-button" data-section="Analytics">Stats</button>${canEdit ? '<button type="button" class="primary compact-button" id="add-type">New link</button>' : ''}</div></header>`;
  if (!types.length) return `${head}<div class="card bk-empty">No links yet.</div>`;
  return `${head}<div class="card lk-card">${types.map((t, i) => {
    const state = linkStateLabel(savedIds.has(t.id) ? t : { ...t, expiresAt: null, singleUse: false }, accessFor(settings, t.id)), on = state.live, s = stats[t.id] ?? { views: 0, confirmed: 0 };
    const meta = [durationSummary(t), linkPlace(t), `/${t.slug}`, t.requiresApproval ? 'You approve each booking' : ''].filter(Boolean).join(' · ');
    return `<div class="lk-row${on ? '' : ' off'}" data-link-row="${i}">
<button type="button" class="lk-main" data-type="${i}" aria-label="Edit ${esc(t.title)}"><span class="lk-title">${esc(t.title)}${on ? '' : ` <span class="pill off">${esc(state.state === 'paused' ? 'Off' : state.label)}</span>`}</span><span class="lk-meta">${esc(meta)}</span></button>
<div class="lk-stat"><b>${s.confirmed}</b>booked</div><div class="lk-stat"><b>${s.views}</b>views</div>
${on ? `<button type="button" class="primary compact-button lk-copy" data-copy-booking-link="${i}" aria-label="Copy link to ${esc(t.title)}">${copied === t.id ? 'Copied' : 'Copy link'}</button>` : canEdit && state.state === 'paused' ? `<button type="button" class="secondary compact-button lk-copy" data-turn-on="${i}" aria-label="Turn on ${esc(t.title)}">Turn on</button>` : '<span class="lk-copy"></span>'}
<button type="button" class="row-menu" data-link-menu="${i}" aria-label="More for ${esc(t.title)}" aria-haspopup="menu">•••</button>
</div>`;
  }).join('')}</div><p class="lk-foot">Last 30 days</p>`;
}

export function linkMenuItems(t, { canEdit = true, live = false } = {}) {
  return [['preview', 'Preview'], ['embed', 'Embed'], ...(canEdit ? [['duplicate', 'Duplicate'], [t.published ? 'off' : 'on', t.published ? 'Turn off' : 'Turn on'], ['delete', 'Delete', true]] : [])].filter(([id]) => live || id !== 'embed' || t.published);
}
