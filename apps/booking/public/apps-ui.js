// Settings → Connected apps: the Email desktop app and AI apps (MCP clients) that can use this
// account, what each changed recently, and how to add another. Apps come from the device
// session registry; changes come from the activity log, matched to the app's session.
// Client marks: Claude, OpenAI and Cursor from Simple Icons (CC0 1.0).
import {esc,copyText,confirmAction} from './workspace-ui.js';

const DAY=86400000;
const SCOPES={
  'booking:read booking:settings booking:manage':{write:true,can:'Can change your links, hours and bookings.'},
  'booking:read email:tracking booking:settings':{write:true,can:'Can change your links and hours.'}
};
export const canChange=scope=>!!SCOPES[scope]?.write;
export const accessLine=scope=>canChange(scope)?'Can make changes':'Read only';
export const capability=scope=>SCOPES[scope]?.can||'Can see your links and bookings.';

const svg=(path,color)=>`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="${color}" d="${path}"/></svg>`;
const MARKS={
  claude:svg('m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z','#D97757'),
  openai:svg('M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z','currentColor'),
  cursor:svg('M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23','currentColor')
};
// Any other client: a plain app window, never a letter.
const GENERIC='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M3.5 9h17"/><path d="M6.5 7h.01M9 7h.01"/></svg>';
/** Which bundled mark a client name gets, matched case-insensitively. */
export function clientMark(name){const n=String(name||'').toLowerCase();return /claude/.test(n)?'claude':/chatgpt|openai/.test(n)?'openai':/cursor/.test(n)?'cursor':'';}
export function appTile(view){
  if(view.desktop)return '<span class="st-tile st-tile-image"><img src="/email-app-icon.png" alt="" width="40" height="40"></span>';
  return `<span class="st-tile${view.mark?' st-tile-mark mark-'+view.mark:''}">${MARKS[view.mark]||GENERIC}</span>`;
}

// Older entries have no session id; they match on the app's name.
const changedBy=(entry,app)=>entry?.actor?.sessionId?entry.actor.sessionId===app.id:!!app.name&&entry?.actor?.name===app.name;
/** Name, one line and recent changes for one connected app. Desktop sessions are the Email app. */
export function appView(app,{activity=null,now=Date.now()}={}){
  const desktop=app.kind!=='mcp',name=String(app.name||'').trim();
  const device=desktop?name.replace(/^email\s+on\s+/i,'').trim()||name:'';
  const changes=Array.isArray(activity)?activity.filter(entry=>changedBy(entry,app)).sort((a,b)=>b.at-a.at):null;
  const week=changes?changes.filter(entry=>entry.at>=now-7*DAY).length:0;
  const line=desktop?[device,accessLine(app.scope)].filter(Boolean).join(' · '):[accessLine(app.scope),week?`${week} this week`:''].filter(Boolean).join(' · ');
  return {id:app.id,title:desktop?'Email':name||'AI app',line,device,desktop,mark:desktop?'':clientMark(name),changes,scope:app.scope,createdAt:app.createdAt};
}

const chevron='<svg class="st-chev" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M7.5 4.5 13 10l-5.5 5.5"/></svg>';
const back='<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5"/></svg>';
/** The address an AI app connects to: shown without the scheme, copied in full. */
export const mcpAddress=origin=>({full:String(origin||'').replace(/\/+$/,'')+'/mcp',shown:String(origin||'').replace(/^https?:\/\//,'').replace(/\/+$/,'')+'/mcp'});
export function addAppSteps(origin){
  const address=mcpAddress(origin);
  return `<ol class="st-steps"><li><span>In Claude, open Settings, then Connectors, then Add custom connector. Other AI apps have a similar option.</span></li><li><span>Paste this address:</span><div class="st-copy"><code>${esc(address.shown)}</code><button type="button" data-copy-mcp="${esc(address.full)}" aria-label="Copy ${esc(address.full)}">Copy</button></div></li><li><span>Sign in to Scheduling and approve it. It shows up here.</span></li></ol>`;
}

export function appsPageMarkup(data,{loading,error,origin,head,status}){
  if(loading&&!data)return `${head('')}${status}<p class="st-note" role="status">Loading…</p>`;
  if(!data||data.apps===null)return `${head('')}${status}<p class="st-note error" role="alert">${esc(error||'Connected apps could not be loaded.')}</p><button type="button" class="st-pill" data-apps-retry>Try again</button>`;
  const views=data.apps.map(app=>appView(app,{activity:data.activity}));
  if(!views.length)return `${head('')}${status}${addAppSteps(origin)}`;
  const action=`<div class="st-pop-anchor"><button type="button" class="st-pill dark" data-add-app aria-haspopup="dialog" aria-expanded="false" aria-controls="add-app-pop">Add AI app</button><div class="st-pop" id="add-app-pop" role="dialog" aria-labelledby="add-app-title" hidden><h3 id="add-app-title">Add an AI app</h3>${addAppSteps(origin)}</div></div>`;
  return `${head(action)}${status}<div class="st-rows">${views.map(view=>`<button type="button" class="st-row st-link" data-app="${esc(view.id)}">${appTile(view)}<span class="st-text"><span class="st-name">${esc(view.title)}</span><span class="st-line">${esc(view.line)}</span></span>${chevron}</button>`).join('')}</div>`;
}

/** Today, 08:12 · Yesterday · 12 Nov */
export function changeTime(ms,{fmt,now=Date.now()}){
  const key=t=>fmt(t,{year:'numeric',month:'2-digit',day:'2-digit'});
  if(key(ms)===key(now))return `Today, ${fmt(ms,{hour:'2-digit',minute:'2-digit',hour12:false})}`;
  if(key(ms)===key(now-DAY))return 'Yesterday';
  return fmt(ms,{day:'numeric',month:'short'});
}
// A change as a sentence with Studio times ("Mon 17 Nov, 15:00"). New entries carry structured detail;
// older ones only a summary with machine times ("2026-11-17 15:00", host wall clock) and link paths,
// so those known shapes are rewritten and anything else is shown as recorded.
const STAMP='(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2})';
// Old stamps are already host wall clock, so they are formatted as UTC in the Studio's own locale.
export function changeSummary(entry,{fmt,wall=(ms,o)=>fmt(ms,{...o,timeZone:'UTC'})}){
  const when=(ms,format)=>`${format(ms,{weekday:'short',day:'numeric',month:'short'})}, ${format(ms,{hour:'2-digit',minute:'2-digit',hour12:false})}`;
  const d=entry?.detail,summary=String(entry?.summary||''),person=x=>`${x.title||'Booking'}${x.name?` with ${x.name}`:''}`;
  if(d&&typeof d==='object'){
    if(entry.action==='reschedule_booking'&&Number.isFinite(d.to))return `Moved ${person(d)}${Number.isFinite(d.from)?` from ${when(d.from,fmt)}`:''} to ${when(d.to,fmt)}`;
    if((entry.action==='cancel_booking'||entry.action==='decide_booking')&&Number.isFinite(d.at)){const verb=entry.action==='cancel_booking'?'Cancelled':d.decision==='approve'?'Approved':d.decision==='decline'?'Declined':'';if(verb)return `${verb} ${person(d)} on ${when(d.at,fmt)}`;}
    const linkVerb={create_link:'Created',update_link:'Changed',delete_link:'Deleted'}[entry.action];
    if(linkVerb&&d.link)return `${linkVerb} the ${d.link} link`;
  }
  const stamp=(y,m,day,h,min)=>when(Date.UTC(+y,+m-1,+day,+h,+min),wall);
  let match=new RegExp(`^Moved (.+) on ${STAMP} to ${STAMP}$`).exec(summary);
  if(match)return `Moved ${match[1]} from ${stamp(...match.slice(2,7))} to ${stamp(...match.slice(7,12))}`;
  match=new RegExp(`^(Approved|Declined|Cancelled) (.+) on ${STAMP}$`).exec(summary);
  if(match)return `${match[1]} ${match[2]} on ${stamp(...match.slice(3,8))}`;
  match=/^(Created|Updated|Deleted) link (.+) \(\/[^()]*\)$/.exec(summary);
  if(match)return `${match[1]==='Updated'?'Changed':match[1]} the ${match[2]} link`;
  return summary;
}
export function appDetailMarkup(view,{fmt,status,phone=false}){
  const connected=Number.isFinite(view.createdAt)?` Connected ${fmt(view.createdAt,{day:'numeric',month:'short'})}.`:'';
  const changes=view.changes===null?'':`<section class="st-sec" aria-labelledby="app-changes-title"><h2 id="app-changes-title">Recent changes</h2>${view.changes.length?`<div class="st-changes">${view.changes.slice(0,50).map(entry=>{const booking=entry.target?.type==='booking'&&entry.target.id;return `<div class="st-change">${booking?`<button type="button" class="st-change-what" data-activity-booking="${esc(booking)}">${esc(changeSummary(entry,{fmt}))}</button>`:`<span class="st-change-what">${esc(changeSummary(entry,{fmt}))}</span>`}<span class="st-change-when">${esc(changeTime(entry.at,{fmt}))}</span></div>`;}).join('')}</div>`:'<p class="st-note">No changes yet.</p>'}</section>`;
  return `<button type="button" class="st-crumb" data-apps-back>${back}Connected apps</button><div class="st-head"><h1>${esc(view.title)}</h1></div><p class="st-lead">${view.desktop&&view.device?`On ${esc(view.device)}. `:''}${esc(capability(view.scope))}${esc(connected)}</p>${status}${changes}<div class="st-danger"><button type="button" class="st-pill red" data-disconnect-app="${esc(view.id)}">Disconnect ${esc(view.title)}</button></div>`;
}

export async function loadApps(api,{activity=true}={}){
  const sessions=fetch('/api/device/sessions',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).catch(()=>null);
  const log=activity?api('activity').then(r=>Array.isArray(r?.activity)?r.activity:null,()=>null):Promise.resolve(null);
  const [apps,entries]=await Promise.all([sessions,log]);
  return {apps:Array.isArray(apps?.sessions)?apps.sessions.sort((a,b)=>b.createdAt-a.createdAt):null,activity:entries};
}
export async function revokeApp(id){
  const r=await fetch('/api/device/revoke',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:id})});
  if(!r.ok)throw Error((await r.json().catch(()=>({}))).error||'That did not work.');
}

/** Copy buttons, the Add AI app popover, app rows and the detail page's actions. */
export function bindApps(container,{status,onOpen,onBack,onRetry,openBooking,onDisconnect,getView}){
  container.querySelectorAll('[data-copy-mcp]').forEach(b=>b.onclick=async()=>{const ok=await copyText(b.dataset.copyMcp);b.textContent=ok?'Copied':'Copy';status(ok?'Address copied':'Copy blocked by the browser');});
  container.querySelectorAll('[data-app]').forEach(b=>b.onclick=()=>onOpen(b.dataset.app));
  container.querySelector('[data-apps-back]')?.addEventListener('click',onBack);
  container.querySelector('[data-apps-retry]')?.addEventListener('click',onRetry);
  container.querySelectorAll('[data-activity-booking]').forEach(b=>b.onclick=()=>openBooking(b.dataset.activityBooking,b));
  container.querySelectorAll('[data-disconnect-app]').forEach(b=>b.onclick=()=>{const view=getView(b.dataset.disconnectApp);if(!view)return;
    confirmAction({title:`Disconnect ${view.title}?`,body:'It loses access right away.',confirmLabel:'Disconnect',trigger:b,restore:()=>document.querySelector('[data-app]')||document.querySelector('#main h1'),run:async()=>{await revokeApp(view.id);await onDisconnect(view);}});});
  const opener=container.querySelector('[data-add-app]'),pop=container.querySelector('#add-app-pop');
  if(!opener||!pop)return()=>{};
  const outside=event=>{if(!pop.contains(event.target)&&!opener.contains(event.target))close(false);};
  const keys=event=>{if(event.key==='Escape'){event.preventDefault();close(true);}};
  function close(focus){if(pop.hidden)return;pop.hidden=true;opener.setAttribute('aria-expanded','false');document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',keys,true);if(focus)opener.focus();}
  function open(){pop.hidden=false;opener.setAttribute('aria-expanded','true');document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',keys,true);pop.querySelector('[data-copy-mcp]')?.focus();}
  opener.onclick=()=>pop.hidden?open():close(true);
  return()=>close(false);
}
