import {esc} from './workspace-ui.js';
// The name menu at the top of the Studio sidebar: who is signed in, which profile is
// open (only for people in a team), Settings and Sign out. Theme lives in Settings.

/** The signed-in person's name: the name on their own profile, else their email. Never a team's name. */
export function accountName({profileName,email}={}){
  const clean=value=>typeof value==='string'?value.trim():'';
  return clean(profileName)||clean(email)||'Your account';
}
/** Up to two letters, e.g. "Alex Morgan" → "AM", "alex@fernhill.example" → "A". */
export function initials(name){
  const text=String(name||'').trim();if(!text)return '?';
  if(text.includes('@'))return text[0].toUpperCase();
  const words=text.split(/\s+/).filter(Boolean);
  return ((words[0]?.[0]||'')+(words.length>1?words.at(-1)[0]:'')).toUpperCase()||'?';
}

export const THEMES=[['light','Light'],['dark','Dark'],['auto','Auto']];
const THEME_KEY='scheduling-theme';
export function storedTheme(){try{const value=localStorage.getItem(THEME_KEY);return THEMES.some(([id])=>id===value)?value:'light';}catch{return 'light';}}
const prefersDark=()=>{try{return matchMedia('(prefers-color-scheme: dark)').matches;}catch{return false;}};
/** Applies the stored choice; Auto follows the system setting. */
export function applyTheme(choice=storedTheme()){document.documentElement.dataset.theme=choice==='auto'?(prefersDark()?'dark':'light'):choice;return choice;}
export function setTheme(choice){if(!THEMES.some(([id])=>id===choice))return storedTheme();try{localStorage.setItem(THEME_KEY,choice);}catch{}applyTheme(choice);return choice;}
let followingSystem=false;
export function followSystemTheme(){if(followingSystem)return;followingSystem=true;try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(storedTheme()==='auto')applyTheme('auto');});}catch{}}
/** Light, Dark and Auto as one inline group; used in the menu and on phones in Settings. */
export function themeChoicesMarkup(labelId){
  const current=storedTheme();
  return `<span class="theme-choices seg" role="group" aria-labelledby="${esc(labelId)}">${THEMES.map(([id,label])=>`<button type="button" data-theme-choice="${id}" aria-pressed="${id===current}">${label}</button>`).join('')}</span>`;
}
export function syncThemeChoices(root=document){const current=storedTheme();root.querySelectorAll('[data-theme-choice]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.themeChoice===current)));}

export function accountMenuMarkup({name,email,avatar}){
  const shown=name||email||'Your account';
  return `<div class="host-account account-compact"><button type="button" class="account-trigger host-identity" id="account-trigger" aria-haspopup="dialog" aria-controls="account-menu" aria-expanded="false" aria-label="Account menu" aria-describedby="account-email"><span class="host-avatar">${avatar?`<img src="${esc(avatar)}" alt="">`:esc(initials(shown))}</span><span class="account-trigger-name"><strong>${esc(shown)}</strong><small class="sr-only" id="account-email">${esc(email)}</small></span></button><div class="account-popover" id="account-menu" role="dialog" aria-label="Account settings" hidden><div class="account-who"><strong>${esc(shown)}</strong>${email&&email!==shown?`<span>${esc(email)}</span>`:''}</div><div class="account-menu-divider"></div><div class="account-menu-row"><span id="account-theme-label">Theme</span>${themeChoicesMarkup('account-theme-label')}</div><button type="button" id="sign-out" data-sign-out>Sign out</button></div></div>`;
}
const chevronDown='<svg class="me-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>';
/** The one menu at the top of the sidebar. The trigger shows the open profile: you, or a team. */
export function meMenuMarkup({name,email,avatar,active=null,workspaces=[]}){
  const shown=name||email||'Your account';
  const person=`<span class="host-avatar">${avatar?`<img src="${esc(avatar)}" alt="">`:esc(initials(shown))}</span>`;
  const face=w=>!w||w.personal?person:`<span class="me-mark" aria-hidden="true">${esc(initials(w.name).slice(0,1))}</span>`;
  const team=active&&!active.personal?active:null,label=team?team.name:shown;
  const switcher=workspaces.length>1?`<div class="account-menu-divider"></div><p class="me-label" id="me-switch-label">Switch to</p><div role="group" aria-labelledby="me-switch-label">${workspaces.map(w=>{const on=w.id===active?.id;return `<button type="button" class="me-item" data-workspace="${esc(w.id)}" aria-pressed="${on}">${face(w)}<span class="me-item-name">${esc(w.personal?shown:w.name)}</span>${on?'<span class="me-check" aria-hidden="true">✓</span>':''}</button>`;}).join('')}</div>`:'';
  return `<div class="host-account me-menu"><button type="button" class="account-trigger host-identity me-trigger" id="account-trigger" aria-haspopup="dialog" aria-controls="account-menu" aria-expanded="false" aria-label="${esc(label)}, account menu">${face(team)}<span class="account-trigger-name"><strong>${esc(label)}</strong></span>${chevronDown}</button><div class="account-popover me-popover" id="account-menu" role="dialog" aria-label="Account" hidden><div class="account-who me-who">${person}<span><strong>${esc(shown)}</strong>${email&&email!==shown?`<span>${esc(email)}</span>`:''}</span></div>${switcher}<div class="account-menu-divider"></div><button type="button" class="me-item" data-section="Settings">Settings</button><button type="button" class="me-item" id="sign-out" data-sign-out>Sign out</button></div></div>`;
}
export function bindAccountMenu(root){const trigger=root.querySelector('#account-trigger'),menu=root.querySelector('#account-menu');if(!trigger||!menu)return()=>false;const items=()=>[...menu.querySelectorAll('button:not(:disabled)')].filter(b=>b.getClientRects().length);
 const outside=event=>{if(!menu.contains(event.target)&&!trigger.contains(event.target))close(false);};
 function position(){if(menu.hidden)return;const rect=trigger.getBoundingClientRect(),width=Math.max(240,Math.min(rect.width,innerWidth-24));menu.style.width=width+'px';menu.style.left=Math.max(12,Math.min(rect.left,innerWidth-width-12))+'px';const height=menu.getBoundingClientRect().height;menu.style.top=Math.max(12,Math.min(rect.top>=height+8?rect.top-height-8:rect.bottom+8,innerHeight-height-12))+'px';}
 function close(focus=true){const wasOpen=!menu.hidden;menu.hidden=true;trigger.setAttribute('aria-expanded','false');document.removeEventListener('pointerdown',outside,true);window.removeEventListener('resize',position);if(wasOpen&&focus&&trigger.isConnected)trigger.focus();return wasOpen;}
 function open(last=false){menu.hidden=false;trigger.setAttribute('aria-expanded','true');position();document.addEventListener('pointerdown',outside,true);window.addEventListener('resize',position);(last?items().at(-1):items()[0])?.focus();}
 trigger.onclick=()=>menu.hidden?open():close();trigger.onkeydown=event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();open(event.key==='ArrowUp');}};
 // A theme choice applies in place and keeps the menu open; every other button closes it.
 menu.addEventListener('click',event=>{const button=event.target.closest('button');if(button&&!button.dataset.themeChoice)close();},true);
 menu.onkeydown=event=>{const list=items(),index=list.indexOf(document.activeElement);let next;if(event.key==='ArrowDown')next=(index+1)%list.length;if(event.key==='ArrowUp')next=(index-1+list.length)%list.length;if(event.key==='Home')next=0;if(event.key==='End')next=list.length-1;if(next!=null){event.preventDefault();list[next]?.focus();}if(event.key==='Escape'||event.key==='Tab'&&(event.shiftKey&&index===0||!event.shiftKey&&index===list.length-1)){event.preventDefault();event.stopPropagation();close();}};
 return()=>close(false);
}
