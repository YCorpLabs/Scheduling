// Activity: what connected apps changed, newest first, and the apps connected to this account.
// The Studio is where people check what their MCP client did; the MCP itself does the work.
import {esc,copyText,confirmAction} from './workspace-ui.js';

const ACCESS={'booking:read booking:settings booking:manage':'Full access','booking:read email:tracking booking:settings':'Links and hours','booking:read email:tracking':'Read only','booking:read':'Read only'};
const initial=name=>esc((String(name||'?').trim()[0]||'?').toUpperCase());
export function accessLabel(scope){return ACCESS[scope]||'Read only';}

export function activityMarkup(data,{loading,error,formatTime,formatDate,origin,showAccount=false}){
  if(loading&&!data)return '<div class="team-state" role="status">Loading activity…</div>';
  if(!data)return `<div class="team-state"><p class="error" role="alert">${esc(error||'Activity is unavailable.')}</p><button type="button" class="secondary compact-button" data-activity-retry>Try again</button></div>`;
  const entries=data.activity||[],apps=data.apps;
  const list=entries.length?`<div class="card activity-card">${entries.map(a=>{
    const booking=a.target?.type==='booking'&&a.target.id;
    const main=`<span class="lk-title activity-summary">${esc(a.summary)}</span><span class="lk-meta">${esc(a.actor?.name||'Connected app')}${showAccount&&a.actor?.email?` · ${esc(a.actor.email)}`:''} · ${esc(formatTime(a.at))}</span>`;
    return `<div class="lk-row activity-row"><span class="activity-avatar" aria-hidden="true">${initial(a.actor?.name)}</span>${booking?`<button type="button" class="lk-main" data-activity-booking="${esc(booking)}">${main}</button>`:`<div class="lk-main activity-static">${main}</div>`}</div>`;
  }).join('')}</div>`:'<div class="card bk-empty">No changes yet</div>';
  const endpoint=`${origin}/mcp`;
  const connect=`<div class="activity-endpoint"><span class="activity-endpoint-label">MCP server</span><code>${esc(endpoint)}</code><button type="button" class="secondary compact-button" data-copy-mcp="${esc(endpoint)}">Copy</button></div>`;
  const appRows=apps===null?'':apps?.length?`<div class="card activity-card">${apps.map(app=>`<div class="lk-row activity-row"><span class="activity-avatar" aria-hidden="true">${initial(app.name)}</span><div class="lk-main activity-static"><span class="lk-title">${esc(app.name)}</span><span class="lk-meta">${app.kind==='mcp'?'MCP':'Desktop app'} · ${esc(accessLabel(app.scope))} · Connected ${esc(formatDate(app.createdAt))}</span></div><button type="button" class="secondary compact-button lk-copy" data-disconnect-app="${esc(app.id)}" aria-label="Disconnect ${esc(app.name)}">Disconnect</button></div>`).join('')}</div>`:'<div class="card bk-empty">No apps connected</div>';
  return `<div class="activity-page">${list}<section class="activity-apps" aria-labelledby="activity-apps-title"><h2 class="bk-section" id="activity-apps-title">Connected apps</h2>${connect}${appRows}</section></div>`;
}

export function bindActivity(container,{data,reload,status,openBooking}){
  const retry=container.querySelector('[data-activity-retry]');if(retry)retry.onclick=reload;
  container.querySelectorAll('[data-activity-booking]').forEach(b=>b.onclick=()=>openBooking(b.dataset.activityBooking,b));
  container.querySelectorAll('[data-copy-mcp]').forEach(b=>b.onclick=async()=>{const ok=await copyText(b.dataset.copyMcp);b.textContent=ok?'Copied':'Copy';status(ok?'MCP server address copied':'Copy blocked by the browser');});
  container.querySelectorAll('[data-disconnect-app]').forEach(b=>b.onclick=()=>{const app=data()?.apps?.find(a=>a.id===b.dataset.disconnectApp);if(!app)return;
    confirmAction({title:`Disconnect ${app.name}?`,body:'It loses access right away.',confirmLabel:'Disconnect',trigger:b,restore:()=>container.querySelector('[data-disconnect-app]')||container.querySelector('h1'),
      run:async()=>{const r=await fetch('/api/device/revoke',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:app.id})});if(!r.ok)throw Error((await r.json().catch(()=>({}))).error||'That did not work.');await reload();status(`${app.name} disconnected`);}});});
}
export async function loadActivity(api){
  const [activity,apps]=await Promise.all([api('activity'),fetch('/api/device/sessions',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).catch(()=>null)]);
  if(!Array.isArray(activity?.activity))throw Error('Activity is not available on this service yet.');
  return {activity:activity.activity,apps:apps?.sessions?apps.sessions.sort((a,b)=>b.createdAt-a.createdAt):null};
}
