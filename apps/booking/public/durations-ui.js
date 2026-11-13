// Duration authoring and guest choice. Validation authority stays in durations.js and the Worker.
import {validDuration,normalizeDurationOptions} from './durations.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const COMMON_DURATIONS=[15,30,45,60,90];
export const MAX_DURATION_OPTIONS=4;
export function durationLabel(minutes){const h=Math.floor(minutes/60),m=minutes%60;return h&&m?`${h} hr ${m} min`:h?`${h} hr`:`${m} min`;}
/** Allowed lengths without throwing; a malformed config falls back to its fixed default. */
export function guestDurations(config){try{return normalizeDurationOptions(config?.durationOptions??null,config?.duration)??[config.duration];}catch{return validDuration(config?.duration)?[config.duration]:[];}}
export function durationSummary(t){const list=guestDurations(t);return list.length>1?[...list].sort((a,b)=>a-b).map(durationLabel).join(' · '):durationLabel(t.duration);}

// ---- Host editor ----
function chips(duration,extras,palette=[]){const values=[...new Set([...COMMON_DURATIONS,...palette,...extras,duration])].filter(validDuration).sort((a,b)=>a-b),full=extras.length>=MAX_DURATION_OPTIONS-1;
 return values.map(v=>{const isDefault=v===duration,on=isDefault||extras.includes(v);return `<label class="duration-chip${isDefault?' is-default':''}"><input type="checkbox" name="durationOption" value="${v}" ${on?'checked':''} ${isDefault||!on&&full?'disabled':''}><span>${esc(durationLabel(v))}</span>${isDefault?'<span class="sr-only"> (default)</span>':''}</label>`;}).join('');}
/** Default-length field; place where the old fixed select was. */
export function durationDefaultMarkup(t){const duration=validDuration(t.duration)?t.duration:30;return `<div class="duration-default"><label for="edit-duration">Duration</label><div class="duration-input"><input id="edit-duration" name="duration" type="number" inputmode="numeric" min="5" max="480" step="1" required value="${duration}" aria-describedby="duration-error"><span aria-hidden="true">min</span></div></div>`;}
/** Optional guest choices (max four including the default). */
export function durationOptionsMarkup(t){const duration=validDuration(t.duration)?t.duration:30,extras=guestDurations(t).filter(v=>v!==duration);
 return `<fieldset class="duration-options" data-duration-editor><legend>Guests can choose</legend><div class="duration-row"><div class="duration-chips" data-duration-chips>${chips(duration,extras)}</div><div class="duration-custom"><input type="text" inputmode="numeric" placeholder="Other" aria-label="Other length in minutes" data-duration-custom><button type="button" class="secondary compact-button" data-duration-add>Add</button></div></div><p class="duration-error" id="duration-error" data-duration-error role="status"></p></fieldset>`;}
const intValue=input=>{const raw=String(input?.value??'').trim();return /^\d+$/.test(raw)?Number(raw):NaN;};
/** Reads {duration,durationOptions}. One selected length is the legacy fixed form (null). */
export function readDurations(form){
 const editor=form.querySelector('[data-duration-editor]'),duration=intValue(form.elements.duration);
 if(!validDuration(duration))throw Error('Choose a duration between 5 and 480 minutes.');
 if(!editor)return {duration};
 const extras=[...editor.querySelectorAll('input[name=durationOption]:checked:not(:disabled)')].map(i=>Number(i.value)).filter(v=>v!==duration);
 const list=[...new Set([duration,...extras])].sort((a,b)=>a-b);
 if(list.length>MAX_DURATION_OPTIONS)throw Error('Guests can choose up to four lengths.');
 return {duration,durationOptions:list.length>1?normalizeDurationOptions(list,duration):null};
}
/** Keeps chips consistent with the default and the four-length limit. Native input events reach the form's dirty tracking. */
export function bindDurationEditor(form){
 const editor=form.querySelector('[data-duration-editor]');if(!editor)return ()=>{};
 const input=form.elements.duration,custom=editor.querySelector('[data-duration-custom]'),message=editor.querySelector('[data-duration-error]');
 let current=intValue(input);const palette=new Set([...editor.querySelectorAll('[name=durationOption]')].map(i=>Number(i.value)));
 const extras=()=>[...editor.querySelectorAll('input[name=durationOption]:checked:not(:disabled)')].map(i=>Number(i.value));
 const say=(text,invalid=false)=>{message.textContent=text;input.setAttribute('aria-invalid',String(invalid));};
 const redraw=(duration,list)=>{const focused=document.activeElement?.closest?.('.duration-chip')?Number(document.activeElement.value):null;editor.querySelector('[data-duration-chips]').innerHTML=chips(duration,list.filter(v=>v!==duration).slice(0,MAX_DURATION_OPTIONS-1),[...palette]);if(focused)editor.querySelector(`input[name=durationOption][value="${focused}"]`)?.focus();};
 const onDefault=()=>{const next=intValue(input);if(!validDuration(next)){say(input.value===''?'':'Use 5 to 480 minutes.',true);return;}say('');if(next===current)return;const list=extras().filter(v=>v!==next);current=next;redraw(next,list);};
 const onChip=event=>{if(event.target.name!=='durationOption')return;const list=extras(),full=list.length>=MAX_DURATION_OPTIONS-1;say(full?'Up to four lengths.':'');redraw(current,list);};
 const add=()=>{const value=intValue(custom);if(!validDuration(value)){say('Use 5 to 480 minutes.');custom.focus();return;}const list=extras();if(value===current||list.includes(value)){say(`${durationLabel(value)} is already offered.`);custom.value='';return;}if(list.length>=MAX_DURATION_OPTIONS-1){say('Up to four lengths. Remove one first.');return;}palette.add(value);redraw(current,[...list,value]);custom.value='';say('');editor.querySelector(`input[name=durationOption][value="${value}"]`)?.dispatchEvent(new Event('input',{bubbles:true}));custom.focus();};
 input.addEventListener('input',onDefault);editor.addEventListener('change',onChip);
 editor.querySelector('[data-duration-add]').onclick=add;
 for(const type of ['input','change'])custom.addEventListener(type,event=>event.stopPropagation());
 custom.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();add();}};
 return ()=>{input.removeEventListener('input',onDefault);editor.removeEventListener('change',onChip);};
}

// ---- Guest chooser ----
/** Rendered only when more than one length is allowed and the guest is not rescheduling. */
export function guestDurationMarkup(config,{selected=config.duration,busy=false}={}){
 const list=guestDurations(config);if(list.length<2)return '';
 return `<fieldset class="guest-durations" aria-busy="${busy}"><legend class="sr-only">Meeting length</legend>${list.map(v=>`<label class="guest-duration"><input type="radio" name="guest-duration" id="guest-duration-${v}" value="${v}" ${v===selected?'checked':''}><span>${esc(durationLabel(v))}</span></label>`).join('')}</fieldset>`;
}
