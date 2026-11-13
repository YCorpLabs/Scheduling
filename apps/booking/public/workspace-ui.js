import {profileWebsite,profileName} from './profile-identity.js';
// Company workspaces in Studio: switcher, Team section, invitations and shared dialog helpers.
// Account identity stays personal. A company is a separate host selected per request with the
// X-Scheduling-Workspace header. Every action is confirmed by the backend before the UI changes.
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const WORKSPACE_HEADER='X-Scheduling-Workspace';
const STORE_KEY='scheduling-workspace';
export const ROLES={
  owner:{label:'Owner',summary:'Full access, including ownership.'},
  admin:{label:'Admin',summary:'Manages settings, calendars, members and integrations.'},
  member:{label:'Member',summary:'Views bookings and approves requests.'},
  viewer:{label:'Viewer',summary:'Views bookings and analytics.'}
};
export const ASSIGNABLE_ROLES=['admin','member','viewer'];
export const roleLabel=role=>ROLES[role]?.label||String(role||'');
// Backend capabilities win; the role map is the fallback for older responses.
const fallbackCaps=role=>({manageSettings:role==='owner'||role==='admin',manageMembers:role==='owner'||role==='admin',manageIntegrations:role==='owner'||role==='admin',approveBookings:role!=='viewer',transferOwnership:role==='owner',grantAdmin:role==='owner'});
export const can=(workspace,capability)=>!!workspace&&(workspace.personal||!!(workspace.capabilities||fallbackCaps(workspace.role))[capability]);
export const canAdminister=workspace=>can(workspace,'manageMembers');
export const inviteRoles=workspace=>ASSIGNABLE_ROLES.filter(r=>r!=='admin'||can(workspace,'grantAdmin'));
const PERSONAL_SECTIONS=['Meetings','Availability','Calendars','Bookings','Analytics','Status','Integrations'];
export function sectionsFor(workspace){
  if(!workspace||workspace.personal)return PERSONAL_SECTIONS;
  if(can(workspace,'manageSettings'))return ['Meetings','Availability','Calendars','Bookings','Analytics','Status','Team',...(can(workspace,'manageIntegrations')?['Integrations']:[])];
  return [...(can(workspace,'manageOwnCalendar')?['Availability','Calendars']:[]),'Bookings','Analytics','Team'];
}
export const PERSONAL_FALLBACK=Object.freeze({id:'personal',name:'Your profile',role:'owner',personal:true});
const cleanWorkspace=w=>w&&typeof w.id==='string'&&w.id?{id:w.id,name:String(w.name||'').trim()||'Profile',role:ROLES[w.role]?w.role:'viewer',personal:!!w.personal,...(w.capabilities&&typeof w.capabilities==='object'?{capabilities:{...w.capabilities}}:{})}:null;
export {cleanWorkspace};

// Decides the active workspace from the signed-in account's own listing. A stored choice is used
// only when it was made by the same account and is still in that listing.
export function resolveWorkspaces(listing,{account,stored}={}){
  const supported=!!listing&&Array.isArray(listing.workspaces);
  const list=supported?listing.workspaces.map(cleanWorkspace).filter(Boolean):[];
  if(!list.some(w=>w.personal))list.unshift({...PERSONAL_FALLBACK});
  list.sort((a,b)=>a.personal===b.personal?a.name.localeCompare(b.name):a.personal?-1:1);
  const personal=list.find(w=>w.personal);
  const mine=stored&&stored.account===account?stored:null;
  let active=mine&&list.find(w=>w.id===mine.id);
  const stale=!!mine&&!active&&mine.id!==personal.id?{id:mine.id,name:mine.name||'That profile'}:null;
  if(!active&&!mine&&supported)active=list.find(w=>w.id===listing.activeWorkspaceId);
  return {supported,workspaces:list,active:active||personal,personal,stale};
}
export function readStoredWorkspace(){try{const value=JSON.parse(localStorage.getItem(STORE_KEY)||'null');return value&&typeof value.account==='string'&&typeof value.id==='string'?value:null;}catch{return null;}}
export function storeWorkspace(account,workspace){try{if(!workspace)localStorage.removeItem(STORE_KEY);else localStorage.setItem(STORE_KEY,JSON.stringify({account,id:workspace.id,name:workspace.name}));}catch{}}
export function clearStoredWorkspace(){try{localStorage.removeItem(STORE_KEY);}catch{}}

// Pending invitation: this tab only, short-lived, never in localStorage, a query string or a log.
const INVITE_KEY='scheduling-pending-invite',INVITE_TTL=30*60000;
export function stashInviteToken(token,now=Date.now()){if(!token)return;try{sessionStorage.setItem(INVITE_KEY,JSON.stringify({token,until:now+INVITE_TTL}));}catch{}}
export function takePendingInvite(now=Date.now()){try{const value=JSON.parse(sessionStorage.getItem(INVITE_KEY)||'null');if(!value||typeof value.token!=='string'||!(value.until>now)){sessionStorage.removeItem(INVITE_KEY);return null;}return value.token;}catch{return null;}}
export function clearPendingInvite(){try{sessionStorage.removeItem(INVITE_KEY);}catch{}}
// Takes an invitation token from the URL fragment and removes it before anything else runs.
export function captureInviteToken(loc=location,hist=history){
  if(!String(loc.hash||'').startsWith('#invite='))return null;
  const match=/^#invite=([-A-Za-z0-9_.~]{16,512})$/.exec(loc.hash);
  hist.replaceState(null,'',loc.pathname+loc.search);
  return match?match[1]:null;
}

const mark=w=>w.avatarImage?`<img src="${esc(w.avatarImage)}" alt="">`:esc((w.name.trim().slice(0,1)||'?').toUpperCase());
const chevron='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>';
const check='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
export function switcherMarkup(state){
  if(!state?.supported)return '';
  const a=state.active;
  return `<div class="workspace-switch"><button type="button" class="workspace-trigger" id="workspace-trigger" aria-haspopup="menu" aria-expanded="false" aria-controls="workspace-menu" aria-label="Profile: ${esc(a.name)}${a.personal?'':', '+esc(roleLabel(a.role))}"><span class="workspace-mark ${a.personal?'personal':''}" aria-hidden="true">${mark(a)}</span><span class="workspace-name"><strong>${esc(a.name)}</strong>${a.personal?'':`<small>${esc(roleLabel(a.role))}</small>`}</span>${chevron}</button><div class="workspace-menu" id="workspace-menu" role="menu" aria-label="Profiles" hidden>${state.workspaces.map(w=>`<button type="button" role="menuitemradio" aria-checked="${w.id===a.id}" tabindex="-1" data-workspace="${esc(w.id)}"><span class="workspace-mark ${w.personal?'personal':''}" aria-hidden="true">${mark(w)}</span><span class="workspace-name"><strong>${esc(w.name)}</strong>${w.personal?'':`<small>${esc(roleLabel(w.role))}</small>`}</span><span class="workspace-check">${w.id===a.id?check:''}</span></button>`).join('')}<div class="workspace-menu-rule" role="separator"></div><button type="button" role="menuitem" tabindex="-1" data-create-workspace><span class="workspace-mark add" aria-hidden="true">+</span><span class="workspace-name"><strong>New profile</strong></span></button></div></div>`;
}
export function bindSwitcher(root,{onSelect,onCreate}){
  const trigger=root.querySelector('#workspace-trigger'),menu=root.querySelector('#workspace-menu');if(!trigger||!menu)return;
  const items=()=>[...menu.querySelectorAll('[role^=menuitem]')];
  const outside=e=>{if(!menu.hidden&&!e.target.closest('.workspace-switch'))close(false);};
  function close(focus=true){if(menu.hidden)return;menu.hidden=true;trigger.setAttribute('aria-expanded','false');document.removeEventListener('pointerdown',outside,true);if(focus)trigger.focus();}
  function open(target){menu.hidden=false;trigger.setAttribute('aria-expanded','true');document.addEventListener('pointerdown',outside,true);const list=items();(target==='last'?list.at(-1):menu.querySelector('[aria-checked=true]')||list[0])?.focus();}
  trigger.onclick=()=>menu.hidden?open():close();
  trigger.onkeydown=e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();open(e.key==='ArrowUp'?'last':undefined);}};
  menu.onkeydown=e=>{const list=items(),i=list.indexOf(document.activeElement);let n;if(e.key==='ArrowDown')n=(i+1)%list.length;if(e.key==='ArrowUp')n=(i-1+list.length)%list.length;if(e.key==='Home')n=0;if(e.key==='End')n=list.length-1;if(n!==undefined){e.preventDefault();list[n].focus();}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}if(e.key==='Tab')close(false);};
  menu.querySelectorAll('[data-workspace]').forEach(b=>b.onclick=()=>{const id=b.dataset.workspace;close();if(b.getAttribute('aria-checked')!=='true')onSelect(id);});
  menu.querySelector('[data-create-workspace]').onclick=()=>{close();onCreate(trigger);};
}

// Dialog helpers shared by Team and Integrations. Dismissal never silently drops typed input.
export function createDialog({label,className='booking-dialog',trigger,restore}){
  const dialog=document.createElement('dialog');dialog.className=className;dialog.setAttribute('aria-label',label);document.body.append(dialog);
  const state={working:false,isDirty:()=>false,confirmingDiscard:false};
  dialog.addEventListener('cancel',e=>{if(state.working){e.preventDefault();return;}if(state.isDirty()){e.preventDefault();askDiscard();}});
  dialog.addEventListener('click',e=>{if(e.target===dialog)dismiss();});
  dialog.addEventListener('close',()=>{dialog.remove();const target=trigger?.isConnected?trigger:restore?.();target?.focus?.();});
  function askDiscard(){if(dialog.querySelector('.discard-confirm'))return dialog.querySelector('[data-discard-keep]').focus();const bar=document.createElement('div');bar.className='discard-confirm';bar.setAttribute('role','alertdialog');bar.setAttribute('aria-label','Discard changes');bar.innerHTML='<span>Discard your changes?</span><div class="row"><button type="button" class="secondary compact-button" data-discard-keep>Keep editing</button><button type="button" class="danger-button compact-button" data-discard-confirm>Discard</button></div>';const footer=dialog.querySelector('.booking-detail-footer');if(footer)footer.before(bar);else dialog.append(bar);const focusBack=document.activeElement;bar.querySelector('[data-discard-keep]').onclick=()=>{bar.remove();(focusBack?.isConnected?focusBack:dialog.querySelector('input,button'))?.focus();};bar.querySelector('[data-discard-confirm]').onclick=()=>{state.isDirty=()=>false;dialog.close();};bar.querySelector('[data-discard-keep]').focus();}
  function dismiss(){if(state.working)return;if(state.isDirty())askDiscard();else dialog.close();}
  return {dialog,state,dismiss};
}
// Small confirmation that runs a backend action and shows its error in place.
export function confirmAction({title,body,confirmLabel,danger=true,trigger,restore,run}){
  const {dialog,state}=createDialog({label:title,className:'unsaved-dialog',trigger,restore});
  dialog.innerHTML=`<h2>${esc(title)}</h2>${body?`<p>${esc(body)}</p>`:''}<p class="error" role="alert"></p><div class="row"><button type="button" class="secondary" data-keep>Cancel</button><button type="button" class="${danger?'danger-button':'primary'}" data-confirm>${esc(confirmLabel)}</button></div>`;
  dialog.querySelector('[data-keep]').onclick=()=>dialog.close();
  const go=dialog.querySelector('[data-confirm]');
  go.onclick=async()=>{if(state.working)return;state.working=true;dialog.querySelectorAll('button').forEach(b=>b.disabled=true);go.textContent='Working…';dialog.querySelector('[role=alert]').textContent='';
    try{await run();state.working=false;dialog.close();}
    catch(error){state.working=false;dialog.querySelectorAll('button').forEach(b=>b.disabled=false);go.textContent=confirmLabel;dialog.querySelector('[role=alert]').textContent=error.message||'That did not work. Try again.';go.focus();}};
  dialog.showModal();dialog.querySelector('[data-keep]').focus();
  return dialog;
}
const closeIcon='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
export const dialogHead=(title,closeLabel)=>`<div class="booking-detail-head"><span>${esc(title)}</span><button type="button" class="icon-button" data-close aria-label="${esc(closeLabel)}">${closeIcon}</button></div>`;
export async function copyText(text,input){try{await navigator.clipboard.writeText(text);return true;}catch{if(input){input.focus();input.select();}return false;}}

export function showCreateWorkspace(api,{trigger,onCreated,onboarding=false}){
  const {dialog,state,dismiss}=createDialog({label:onboarding?'Create your profile':'New profile',className:'booking-dialog profile-create-dialog'+(onboarding?' profile-onboarding':''),trigger});
  dialog.innerHTML=`${dialogHead(onboarding?'Create your profile':'New profile','Close new profile')}<form class="workspace-form" novalidate><div class="booking-detail-body"><label class="field-label" for="workspace-name">Name</label><input id="workspace-name" name="name" maxlength="80" autocomplete="organization" placeholder="Company or your name"><label class="field-label" for="workspace-website">Website <span class="optional-label">Optional</span></label><input id="workspace-website" name="website" maxlength="2048" inputmode="url" autocomplete="url" placeholder="example.com"><p class="error" role="alert" id="workspace-create-error"></p></div><footer class="booking-detail-footer"><button type="button" class="secondary" data-cancel>${onboarding?'Later':'Cancel'}</button><button type="submit" class="primary">Create profile</button></footer></form>`;
  const form=dialog.querySelector('form'),input=form.elements.name,website=form.elements.website,error=dialog.querySelector('[role=alert]');
  state.isDirty=()=>!!input.value.trim()||!!website.value.trim();
  dialog.querySelectorAll('[data-close],[data-cancel]').forEach(b=>b.onclick=dismiss);
  form.onsubmit=async e=>{e.preventDefault();if(state.working)return;let url;try{url=profileWebsite(website.value);}catch(err){error.textContent=err.message;website.setAttribute('aria-invalid','true');website.focus();return;}
    const name=profileName(input.value,url);if(!name){error.textContent='Enter a name or website.';input.setAttribute('aria-invalid','true');input.focus();return;}
    state.working=true;const submit=form.querySelector('[type=submit]');form.querySelectorAll('input,button').forEach(b=>b.disabled=true);submit.textContent='Creating…';error.textContent='';input.removeAttribute('aria-invalid');website.removeAttribute('aria-invalid');
    try{const result=await api('workspaces',{name,website:url,...(onboarding?{firstProfile:true}:{})});const workspace=cleanWorkspace({role:'owner',...result.workspace});if(!workspace)throw Error('The profile could not be created. Try again.');state.working=false;state.isDirty=()=>false;dialog.close();await onCreated(workspace);}
    catch(err){state.working=false;form.querySelectorAll('input,button').forEach(b=>b.disabled=false);submit.textContent='Create profile';error.textContent=err.message||'The profile could not be created.';input.focus();}};
  dialog.showModal();input.focus();
}

// Team section
const sameEmail=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
export const isSelf=(member,email)=>member.current===true||sameEmail(member.email,email);
export function canManageMember(actor,member,email){
  if(!actor||actor.personal||isSelf(member,email)||member.role==='owner'||!canAdminister(actor))return false;
  return member.role!=='admin'||can(actor,'grantAdmin');
}
export function teamMarkup(data,{workspace,email,loading,error,formatDate}){
  if(loading&&!data)return '<div class="team-state" role="status">Loading team…</div>';
  if(error&&!data)return `<div class="team-state"><p class="error" role="alert">${esc(error)}</p><button type="button" class="secondary compact-button" data-team-retry>Try again</button></div>`;
  if(!data)return '';
  const members=[...(data.members||[])].sort((a,b)=>(a.role==='owner'?-1:0)-(b.role==='owner'?-1:0)||String(a.email).localeCompare(String(b.email)));
  const admin=canAdminister(workspace),invites=admin?data.invitations||[]:[];
  return `${error?`<p class="error" role="alert">${esc(error)}</p>`:''}<section class="team-block" aria-labelledby="team-members-title"><div class="team-block-head"><h2 id="team-members-title">Members</h2><span class="team-count">${members.length}</span></div><ul class="team-list">${members.map(m=>`<li class="team-row"><span class="host-avatar" aria-hidden="true">${esc(String(m.email||'?').slice(0,1).toUpperCase())}</span><span class="team-person"><strong>${esc(m.email)}</strong>${isSelf(m,email)?'<small>You</small>':''}${m.readiness?`<small>${esc({ready:'Ready for bookings',not_connected:'Calendar not connected',choose_calendar:'Choose a booking calendar',reconnect:'Reconnect calendar',withdrawn:'Calendar access withdrawn',not_hosting:'Not a booking host'}[m.readiness]||'Calendar needs attention')}</small>`:''}${isSelf(m,email)&&can(workspace,'manageOwnCalendar')&&m.readiness&&m.readiness!=='ready'?'<button type="button" class="quiet-button" data-team-connect-own>Set up my calendar</button>':''}</span><span class="team-role">${esc(roleLabel(m.role))}</span>${canManageMember(workspace,m,email)?`<button type="button" class="quiet-button team-manage" data-manage-member="${esc(m.id)}" aria-label="Manage ${esc(m.email)}">Manage</button>`:isSelf(m,email)&&m.role!=='owner'?`<button type="button" class="quiet-button team-manage" data-leave-workspace="${esc(m.id)}" aria-label="Leave ${esc(workspace.name)}">Leave</button>`:'<span class="team-manage" aria-hidden="true"></span>'}</li>`).join('')}</ul></section>${admin&&invites.length?`<section class="team-block" aria-labelledby="team-invites-title"><div class="team-block-head"><h2 id="team-invites-title">Pending invitations</h2><span class="team-count">${invites.length}</span></div>${invites.length?`<ul class="team-list">${invites.map(i=>`<li class="team-row"><span class="host-avatar pending" aria-hidden="true">${esc(String(i.email||'?').slice(0,1).toUpperCase())}</span><span class="team-person"><strong>${esc(i.email)}</strong><small>Expires ${esc(formatDate(i.expiresAt))}</small></span><span class="team-role">${esc(roleLabel(i.role))}</span><button type="button" class="quiet-button team-manage" data-revoke-invite="${esc(i.id)}" aria-label="Revoke invitation for ${esc(i.email)}">Revoke</button></li>`).join('')}</ul>`:'<p class="team-empty">No pending invitations.</p>'}</section>`:''}`;
}
export function bindTeam(container,{api,getData,workspace,email,reload,status,formatDate,onOwnershipChanged,onLeft}){
  const retry=container.querySelector('[data-team-retry]');if(retry)retry.onclick=reload;
  container.querySelectorAll('[data-revoke-invite]').forEach(b=>b.onclick=()=>{const invite=(getData()?.invitations||[]).find(i=>i.id===b.dataset.revokeInvite);if(!invite)return;
    confirmAction({title:`Revoke invitation for ${invite.email}?`,body:'The invite link stops working.',confirmLabel:'Revoke invitation',trigger:b,restore:()=>document.querySelector('[data-revoke-invite]')||document.querySelector('#team-invite'),run:async()=>{await api('workspace/invitations/revoke',{id:invite.id});await reload();status('Invitation revoked');}});});
  const leave=container.querySelector('[data-leave-workspace]');if(leave)leave.onclick=()=>confirmAction({title:`Leave ${workspace.name}?`,body:'You lose access immediately. Rejoining needs a new invitation.',confirmLabel:`Leave ${workspace.name}`,trigger:leave,run:async()=>{await api('workspace/members',{action:'remove',memberId:leave.dataset.leaveWorkspace});await onLeft();}});
  container.querySelectorAll('[data-manage-member]').forEach(b=>b.onclick=()=>{const member=(getData()?.members||[]).find(m=>m.id===b.dataset.manageMember);if(member)showMemberDialog(member,b);});
  function showMemberDialog(member,trigger){
    const restore=()=>document.querySelector(`[data-manage-member="${CSS.escape(member.id)}"]`)||document.querySelector('#team-invite')||document.querySelector('h1');
    const {dialog,state,dismiss}=createDialog({label:`Manage ${member.email}`,trigger,restore});
    let step='role',error='';const owner=can(workspace,'transferOwnership'),roles=inviteRoles(workspace);
    state.isDirty=()=>step==='role'&&dialog.querySelector('[name=member-role]:checked')?.value!==member.role;
    function draw(){
      const chosen=dialog.querySelector('[name=member-role]:checked')?.value||member.role;
      dialog.innerHTML=`${dialogHead('Manage member',`Close manage ${member.email}`)}<div class="booking-detail-body"><h2 class="member-title">${esc(member.email)}</h2>${step==='role'?`<fieldset class="role-options"><legend>Role</legend>${roles.map(r=>`<label class="role-option"><input type="radio" name="member-role" value="${r}" ${r===chosen?'checked':''}><span><strong>${ROLES[r].label}</strong><small>${ROLES[r].summary}</small></span></label>`).join('')}</fieldset><div class="member-more">${owner?'<button type="button" class="quiet-button" data-step="transfer">Transfer ownership…</button>':''}<button type="button" class="danger-quiet" data-step="remove">Remove from ${esc(workspace.name)}…</button></div>`:step==='remove'?`<div class="member-confirm" role="group" aria-labelledby="member-confirm-title"><strong id="member-confirm-title">Remove ${esc(member.email)} from ${esc(workspace.name)}?</strong><p>They lose access immediately. Meeting links and bookings stay with ${esc(workspace.name)}.</p></div>`:`<div class="member-confirm" role="group" aria-labelledby="member-confirm-title"><strong id="member-confirm-title">Make ${esc(member.email)} the owner?</strong><p>You become an admin. Only the new owner can transfer ownership again.</p></div>`}<p class="error" role="alert">${esc(error)}</p></div><footer class="booking-detail-footer">${step==='role'?`<button type="button" class="secondary" data-cancel>Cancel</button><button type="button" class="primary" data-save-role ${chosen===member.role?'disabled':''}>${chosen===member.role?'Save role':`Change to ${ROLES[chosen].label}`}</button>`:`<button type="button" class="secondary" data-back>Back</button><button type="button" class="danger-button" data-confirm-step>${step==='remove'?'Remove member':'Transfer ownership'}</button>`}</footer>`;
      dialog.querySelector('[data-close]').onclick=dismiss;dialog.querySelector('[data-cancel]')?.addEventListener('click',dismiss);
      dialog.querySelectorAll('[name=member-role]').forEach(r=>r.onchange=()=>{const save=dialog.querySelector('[data-save-role]'),value=r.value;save.disabled=value===member.role;save.textContent=value===member.role?'Save role':`Change to ${ROLES[value].label}`;});
      dialog.querySelectorAll('[data-step]').forEach(s=>s.onclick=()=>{step=s.dataset.step;error='';draw();dialog.querySelector('[data-back]').focus();});
      const back=dialog.querySelector('[data-back]');if(back)back.onclick=()=>{const from=step;step='role';error='';draw();dialog.querySelector(`[data-step="${from}"]`)?.focus();};
      const save=dialog.querySelector('[data-save-role]');if(save)save.onclick=()=>act({action:'role',memberId:member.id,role:dialog.querySelector('[name=member-role]:checked').value},save,`Role changed to ${roleLabel(dialog.querySelector('[name=member-role]:checked').value)}`);
      const go=dialog.querySelector('[data-confirm-step]');if(go)go.onclick=()=>act(step==='remove'?{action:'remove',memberId:member.id}:{action:'transfer',memberId:member.id},go,step==='remove'?'Member removed':'Ownership transferred');
    }
    async function act(body,button,done){if(state.working)return;state.working=true;dialog.querySelectorAll('button,input').forEach(c=>c.disabled=true);button.textContent='Saving…';
      try{await api('workspace/members',body);state.working=false;state.isDirty=()=>false;dialog.close();if(body.action==='transfer')await onOwnershipChanged();else await reload();status(done);}
      catch(e){state.working=false;error=e.message||'That did not work. Try again.';const role=dialog.querySelector('[name=member-role]:checked')?.value;draw();if(role){const input=dialog.querySelector(`[name=member-role][value="${role}"]`);if(input){input.checked=true;input.dispatchEvent(new Event('change'));}}(dialog.querySelector('[data-confirm-step],[data-save-role]'))?.focus();}}
    draw();dialog.showModal();(dialog.querySelector('[name=member-role]:checked')||dialog.querySelector('[name=member-role]'))?.focus();
  }
}
export function showInviteDialog(api,{workspace,trigger,formatDate,onInvited}){
  const {dialog,state,dismiss}=createDialog({label:'Invite to '+workspace.name,trigger,restore:()=>document.querySelector('#team-invite')});
  dialog.innerHTML=`${dialogHead('Invite','Close invite')}<form class="workspace-form" novalidate><div class="booking-detail-body"><h2>Invite to ${esc(workspace.name)}</h2><label class="field-label" for="invite-email">Email</label><input id="invite-email" name="email" type="email" required maxlength="254" autocomplete="off" spellcheck="false"><fieldset class="role-options"><legend>Role</legend>${inviteRoles(workspace).map(r=>`<label class="role-option"><input type="radio" name="role" value="${r}" ${r==='member'?'checked':''}><span><strong>${ROLES[r].label}</strong><small>${ROLES[r].summary}</small></span></label>`).join('')}</fieldset><p class="error" role="alert"></p></div><footer class="booking-detail-footer"><button type="button" class="secondary" data-cancel>Cancel</button><button type="submit" class="primary">Create invite link</button></footer></form>`;
  const form=dialog.querySelector('form'),input=form.elements.email,error=dialog.querySelector('[role=alert]');
  state.isDirty=()=>!!input.value.trim();
  dialog.querySelectorAll('[data-close],[data-cancel]').forEach(b=>b.onclick=dismiss);
  form.onsubmit=async e=>{e.preventDefault();const email=input.value.trim();if(!input.checkValidity()||!email){error.textContent='Enter a valid email address.';input.setAttribute('aria-invalid','true');input.focus();return;}
    if(state.working)return;state.working=true;const submit=form.querySelector('[type=submit]');submit.disabled=true;submit.textContent='Creating…';error.textContent='';input.removeAttribute('aria-invalid');
    try{const result=await api('workspace/invitations',{email,role:form.elements.role.value});if(typeof result.url!=='string'||!result.url)throw Error('The invite link could not be created. Try again.');state.working=false;state.isDirty=()=>false;showLink(result);await onInvited();}
    catch(err){state.working=false;submit.disabled=false;submit.textContent='Create invite link';error.textContent=err.message||'The invite could not be created.';input.focus();}};
  function showLink({invitation={},url}){
    dialog.innerHTML=`${dialogHead('Invite','Close invite')}<div class="booking-detail-body"><h2>Invite link ready</h2><p class="muted">Send this link to ${esc(invitation.email||input.value.trim())}. It is shown only once${invitation.expiresAt?` and expires ${esc(formatDate(invitation.expiresAt))}`:''}.</p><div class="copy-field"><input id="invite-link" readonly value="${esc(url)}" aria-label="Invite link" spellcheck="false"><button type="button" class="secondary compact-button" data-copy>Copy link</button></div><p class="hint" role="status" data-copy-status></p></div><footer class="booking-detail-footer"><button type="button" class="primary" data-done>Done</button></footer>`;
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.querySelector('[data-done]').onclick=()=>dialog.close();
    const field=dialog.querySelector('#invite-link');dialog.querySelector('[data-copy]').onclick=async()=>{const ok=await copyText(url,field);dialog.querySelector('[data-copy-status]').textContent=ok?'Link copied':'Copy blocked by the browser. The link is selected.';};
    dialog.querySelector('[data-copy]').focus();
  }
  dialog.showModal();input.focus();
}
// Explicit acceptance after sign-in. The token stays in memory only.
export function showInviteAcceptance(api,token,{email,onAccepted,onSwitchAccount}){
  const {dialog,state}=createDialog({label:'Profile invitation',restore:()=>document.querySelector('#workspace-trigger')||document.querySelector('h1')});
  let info=null,error='',errorStatus=0,loading=true,keepPending=false;
  function draw(){
    const inv=info?.invitation||info||{},name=inv.workspaceName||inv.workspace?.name||'this profile';
    dialog.innerHTML=`${dialogHead('Invitation','Close invitation')}<div class="booking-detail-body">${loading?'<p role="status">Checking invitation…</p>':error&&!info?`<h2>${errorStatus===403?'Different account needed':'Invitation unavailable'}</h2><p class="error" role="alert">${esc(error)}</p>${errorStatus===403?`<p class="muted">Signed in as ${esc(email)}.</p>`:''}`:`<h2>Join ${esc(name)}?</h2><dl class="invite-facts"><dt>Role</dt><dd>${esc(roleLabel(inv.role))}</dd><dt>Signed in as</dt><dd>${esc(email)}</dd>${inv.email&&!sameEmail(inv.email,email)?`<dt>Invited</dt><dd>${esc(inv.email)}</dd>`:''}</dl><p class="error" role="alert">${esc(error)}</p>`}</div><footer class="booking-detail-footer">${loading||error&&!info?`<button type="button" class="secondary" data-cancel>${errorStatus===403?'Not now':'Close'}</button>${errorStatus===403&&onSwitchAccount?'<button type="button" class="primary" data-switch-account>Sign in with another account</button>':''}`:`<button type="button" class="secondary" data-cancel>Not now</button><button type="button" class="primary" data-accept>Join ${esc(name)}</button>`}</footer>`;
    dialog.querySelector('[data-close]').onclick=()=>{if(!state.working)dialog.close();};dialog.querySelector('[data-cancel]').onclick=()=>{if(!state.working)dialog.close();};
    const other=dialog.querySelector('[data-switch-account]');if(other)other.onclick=async()=>{if(state.working)return;state.working=true;other.disabled=true;other.textContent='Signing out…';keepPending=true;try{await onSwitchAccount(token);}catch(e){keepPending=false;state.working=false;error=e.message||'Sign out failed.';draw();}};
    const accept=dialog.querySelector('[data-accept]');if(accept)accept.onclick=async()=>{if(state.working)return;state.working=true;accept.disabled=true;accept.textContent='Joining…';
      try{const result=await api('workspace/invitations/accept',{token});state.working=false;token=null;dialog.close();await onAccepted(result.workspace?cleanWorkspace(result.workspace):null);}
      catch(e){state.working=false;error=e.message||'The invitation could not be accepted.';if(e.status===404){info=null;errorStatus=404;}draw();(dialog.querySelector('[data-accept]')||dialog.querySelector('[data-cancel]'))?.focus();}};
  }
  dialog.addEventListener('close',()=>{if(!keepPending)clearPendingInvite();token=null;});
  draw();dialog.showModal();
  (async()=>{try{info=await api('workspace/invitations/inspect',{token});}catch(e){error=e.message||'This invitation is no longer valid.';errorStatus=e.status||0;}loading=false;if(dialog.isConnected){draw();(dialog.querySelector('[data-accept]')||dialog.querySelector('[data-cancel]')).focus();}})();
  dialog.querySelector('[data-cancel]').focus();
}
