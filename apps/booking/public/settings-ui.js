// Studio Settings: the sidebar while Settings is open, the phone list, Profile and Sign-in & data.
// Connected apps is in apps-ui.js and Notifications in integrations-ui.js. Markup and small
// binders only; the Studio (host-ui.js) owns state and API calls.
import {esc} from './workspace-ui.js';
import {initials,themeChoicesMarkup} from './account-menu.js';
import {browserLabel} from './browser-label.js';
import {exportRowView} from './account-data-ui.js';

export const SETTINGS_PAGES=[['Profile','profile','Profile'],['Apps','apps','Connected apps'],['Notifications','notifications','Notifications'],['Account','account','Sign-in & data']];
export const pageTitle=page=>SETTINGS_PAGES.find(([id])=>id===page)?.[2]||'Settings';
const PAGE_BY_SLUG=Object.fromEntries(SETTINGS_PAGES.map(([id,slug])=>[slug,id]));
/** #settings, #settings/<page> or #settings/apps/<id>. The old #activity and #integrations land on their pages. */
export function parseSettingsHash(hash){
  if(hash==='#activity')return {page:'Apps',app:null};
  if(hash==='#integrations')return {page:'Notifications',app:null};
  const match=/^#settings(?:\/(profile|notifications|account)|\/(apps)(?:\/([-A-Za-z0-9_]{1,80}))?)?$/.exec(String(hash||''));
  if(!match)return null;
  return {page:match[1]||match[2]?PAGE_BY_SLUG[match[1]||match[2]]:null,app:match[3]||null};
}
export function settingsHash(page,app){
  const slug=SETTINGS_PAGES.find(([id])=>id===page)?.[1];
  return '#settings'+(slug?'/'+slug:'')+(slug==='apps'&&app?'/'+encodeURIComponent(app):'');
}

const icon=(paths,size=20)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
export const GLYPHS={
  laptop:icon('<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>'),
  phone:icon('<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>'),
  download:icon('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/>'),
  trash:icon('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>'),
  calendar:icon('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4m8-4v4M4 10h16"/>'),
  team:icon('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 19a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 13.6a6.5 6.5 0 0 1 3.5 5.4"/>'),
  theme:icon('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>')
};
const backIcon='<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true" focusable="false"><path d="M12.5 4.5 7 10l5.5 5.5"/></svg>';
const chevron='<svg class="st-chev" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true" focusable="false"><path d="M7.5 4.5 13 10l-5.5 5.5"/></svg>';

/** While Settings is open the sidebar is Back, the Settings pages and the account row. */
export function settingsSidebarMarkup({pages,current,account}){
  return `<button type="button" class="sb-row sb-back" data-settings-back>${backIcon}<span>Back</span></button><nav class="sb-nav" aria-label="Settings">${pages.map(page=>`<button type="button" class="sb-row" data-settings-page="${page}" ${page===current?'aria-current="page"':''}>${esc(pageTitle(page))}</button>`).join('')}</nav><div class="sb-bottom">${account}</div>`;
}
/** Phones: "‹ Settings" above each page. Hidden on wider screens, where the sidebar does this. */
export const phoneBack=()=>`<button type="button" class="st-phone-back" data-settings-page="">${backIcon}Settings</button>`;
export const pageHead=(title,action='')=>`<div class="st-head"><h1>${esc(title)}</h1>${action}</div>`;
/** In a team, pages that change the team say so right under the heading. */
export const forTeam=workspace=>workspace&&!workspace.personal?`<p class="st-for">For ${esc(workspace.name)}</p>`:'';
export function settingsListMarkup(items){
  return `${pageHead('Settings')}<div class="st-list">${items.map(item=>`<button type="button" class="st-list-row" data-settings-page="${item.page}"><span class="st-text"><span class="st-name">${esc(pageTitle(item.page))}</span><span class="st-line">${esc(item.summary)}</span></span>${chevron}</button>`).join('')}</div>`;
}
const row=(tile,name,line,control='',attrs='')=>`<div class="st-row"${attrs}><span class="st-tile">${tile}</span><span class="st-text"><span class="st-name">${name}</span>${line?`<span class="st-line">${line}</span>`:''}</span>${control}</div>`;

// ----- Profile -----
const meetingLine=meeting=>[`${Number(meeting?.duration)||30} minutes`,meeting?.locationType==='google_meet'?'Google Meet':meeting?.locationType==='custom'?String(meeting.location||'').trim():''].filter(Boolean).join(' · ');
/** What a guest sees at the top of a booking page, updated as the form changes. */
export function profileCardMarkup(values,meeting){
  return `${values.bannerImage?`<img class="pf-card-banner" src="${esc(values.bannerImage)}" alt="">`:''}<span class="pf-card-avatar">${values.avatarImage?`<img src="${esc(values.avatarImage)}" alt="">`:esc(initials(values.name))}</span><span class="pf-card-name">${esc(values.name||'Your name')}</span>${values.company?`<span class="pf-card-company">${esc(values.company)}</span>`:''}<span class="pf-card-title">${esc(meeting?.title||'Meeting')}</span><span class="pf-card-meta">${esc(meetingLine(meeting))}</span>`;
}
export function profilePageMarkup({values,meeting,head,status,error='',saving=false}){
  const image=(key,label,empty)=>`<div class="pf-buttons"><button type="button" class="st-pill" data-pick-image="${key}" ${saving?'disabled':''}>${values[key]?`Change ${label}`:empty}</button><button type="button" class="st-text-button" data-remove-image="${key}" aria-label="Remove ${label}" ${values[key]?'':'hidden'} ${saving?'disabled':''}>Remove</button></div>`;
  return `${head}<p class="st-lead">Guests see this on your booking pages.</p>${status}<div class="pf-grid"><form class="pf-form" id="profile-form" novalidate><div class="pf-photo"><span class="pf-avatar">${values.avatarImage?`<img src="${esc(values.avatarImage)}" alt="">`:esc(initials(values.name))}</span>${image('avatarImage','photo','Change photo')}</div><div class="pf-field"><label for="profile-name">Name</label><input id="profile-name" name="name" value="${esc(values.name)}" maxlength="160" required aria-required="true" autocomplete="off" aria-describedby="profile-error"></div><div class="pf-field"><label for="profile-company">Company</label><input id="profile-company" name="company" value="${esc(values.company)}" maxlength="160" autocomplete="off"></div><div class="pf-field"><span class="pf-label">Banner</span><div class="pf-photo"><span class="pf-banner">${values.bannerImage?`<img src="${esc(values.bannerImage)}" alt="">`:''}</span>${image('bannerImage','banner','Add banner')}</div></div><p class="pf-error" id="profile-error" role="alert">${esc(error)}</p><div><button type="submit" class="st-pill dark" ${saving?'disabled':''}>${saving?'Saving…':'Save'}</button></div></form><div class="pf-preview"><p class="pf-cap">Preview</p><div class="pf-card" data-profile-card>${profileCardMarkup(values,meeting)}</div></div></div>`;
}

// ----- Sign-in & data -----
const DAY=86400000;
export function lastUsed(ms,now=Date.now()){
  if(!Number.isFinite(ms))return '';
  const days=Math.floor((now-ms)/DAY);
  return days<1?'Last used today':days<2?'Last used yesterday':`Last used ${days} days ago`;
}
/** The current browser has no stored label until it signs in again; name it from this page. */
export function browserRow(s,{now=Date.now(),userAgent=globalThis.navigator?.userAgent}={}){
  const own=s.current&&!s.device?browserLabel(userAgent):null,name=s.device||own?.name||'Browser',mobile=s.device?s.mobile===true:own?.mobile===true;
  return row(mobile?GLYPHS.phone:GLYPHS.laptop,esc(name),esc(s.current?'This browser':lastUsed(s.lastSeenAt??s.createdAt,now)),s.current?'':`<button type="button" class="st-pill" data-revoke-session="${esc(s.id)}" aria-label="Sign out ${esc(name)}">Sign out</button>`);
}
export function accountPageMarkup({email,head,status,sessions,sessionsError='',contributions=[],workspaceName=()=>'Former team',review='',legal='',teams=null}){
  const browsers=sessions?sessions.map(s=>browserRow(s)).join('')+(sessions.filter(s=>!s.current).length>1?'<div class="st-after"><button type="button" class="st-pill" data-revoke-others>Sign out other browsers</button></div>':''):sessionsError?`<p class="st-note error" role="alert">${esc(sessionsError)}</p><div class="st-after"><button type="button" class="st-pill" data-sessions-retry>Try again</button></div>`:'<p class="st-note" role="status">Loading…</p>';
  const access=contributions.length?`<section class="st-sec" aria-labelledby="calendar-access-title"><h2 id="calendar-access-title">Calendar access</h2><div class="st-rows">${contributions.map((c,i)=>row(GLYPHS.calendar,esc(c.email),esc(c.withdrawn?`${workspaceName(c.workspaceId)} · Calendar sharing stopped`:workspaceName(c.workspaceId)),c.unavailable?'<button type="button" class="st-pill" data-contribution-retry>Retry</button>':c.withdrawn?'':`<button type="button" class="st-pill" data-withdraw="${i}" aria-label="Stop sharing ${esc(c.email)} with ${esc(workspaceName(c.workspaceId))}">Stop sharing</button>`)).join('')}</div>${review?`<p class="st-note" role="status">${esc(review)}</p>`:''}</section>`:'';
  return `${head}<p class="st-lead">You sign in with Google as ${esc(email)}.</p>${status}<section class="st-sec" aria-labelledby="browsers-title"><h2 id="browsers-title">Browsers</h2><div class="st-rows">${browsers}</div></section>${access}<section class="st-sec" aria-labelledby="your-data-title"><h2 id="your-data-title">Your data</h2><div class="st-rows"><div class="st-row" data-account-export></div>${row(GLYPHS.trash,'Delete your account','Your Google Calendar events stay','<button type="button" class="st-pill red" data-delete-account>Delete…</button>')}</div></section><section class="st-sec" aria-label="Theme, teams and sign out"><div class="st-rows">${row(GLYPHS.theme,'<span id="phone-theme-label">Theme</span>','',themeChoicesMarkup('phone-theme-label'))}${teams?row(GLYPHS.team,'Teams',esc(teams.length?teams.join(', '):'Share links and bookings with others'),'<button type="button" class="st-pill" data-create-workspace>New team</button>'):''}</div><div class="st-after st-phone-only"><button type="button" class="st-pill" data-sign-out>Sign out</button></div></section>${legal?`<p class="st-legal">${legal}</p>`:''}`;
}

/** Download your data: one control that follows the export (Download, Cancel, Try again). */
export function bindSettingsExport(row,controller,{productName}){
  row.innerHTML=`<span class="st-tile">${GLYPHS.download}</span><span class="st-text"><span class="st-name">Download your data</span><span class="st-line" role="status" aria-live="polite" data-export-status></span><span class="st-line error" role="alert" data-export-alert></span></span><span class="st-control" data-export-actions></span>`;
  const draw=(state=controller.state)=>{
    if(!row.isConnected)return;
    const view=exportRowView(state,{actionLabel:'Download your data'}),actions=row.querySelector('[data-export-actions]'),hadFocus=actions.contains(document.activeElement);
    row.querySelector('[data-export-status]').textContent=view.alert?'':view.status==='Ready'?'Ready':view.status||`Everything ${productName} stores about you`;
    row.querySelector('[data-export-alert]').textContent=view.alert;
    actions.innerHTML=state.status==='preparing'?'<button type="button" class="st-pill" data-export-cancel>Cancel</button>'
      :state.status==='ready'&&state.url?`<a class="st-pill" data-export-download href="${esc(state.url)}" download="${esc(state.filename)}">Download</a>`
      :state.status==='paused'?'<button type="button" class="st-pill" data-export-retry>Try again</button>'
      :state.status==='stopped'?(state.accountChanged?'':'<button type="button" class="st-pill" data-export-start>Try again</button>')
      :'<button type="button" class="st-pill" data-export-start aria-label="Download your data">Download</button>';
    actions.querySelector('[data-export-start]')?.addEventListener('click',event=>{event.currentTarget.focus();controller.start();});
    actions.querySelector('[data-export-retry]')?.addEventListener('click',event=>{event.currentTarget.focus();controller.retry();});
    actions.querySelector('[data-export-cancel]')?.addEventListener('click',event=>{event.currentTarget.focus();controller.cancel();});
    if(hadFocus)actions.querySelector('a,button')?.focus();
  };
  draw();return draw;
}
