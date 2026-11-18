// The Studio frame as it was last shown, so a reload paints the same sidebar
// straight away instead of a loading line that is then replaced. Saved in this
// browser only, for the signed-in account; cleared when the person signs out.
// It holds the sidebar markup Studio rendered (already escaped), nothing else.
const KEY='scheduling-shell',MAX=64*1024;

export function readShell(){
  try{const value=JSON.parse(localStorage.getItem(KEY)||'null');return value&&typeof value.account==='string'&&typeof value.nav==='string'&&typeof value.tabs==='string'?value:null;}catch{return null;}
}
export function saveShell(shell){
  try{const text=JSON.stringify(shell);if(text.length>MAX){localStorage.removeItem(KEY);return;}if(localStorage.getItem(KEY)!==text)localStorage.setItem(KEY,text);}catch{}
}
export function clearShell(){try{localStorage.removeItem(KEY);}catch{}}

/** The section a Studio address opens; matches hashSection in host-ui.js for the main sections. */
export function shellSection(hash){
  if(hash.startsWith('#settings'))return 'Settings';
  return ({'#calendars':'Availability','#availability':'Availability','#analytics':'Analytics','#stats':'Analytics','#status':'Status','#team':'Team','#links':'Meetings'})[hash]||(/^#link=/.test(hash)?'Meetings':'Bookings');
}

/** Marks the open section in saved navigation markup. */
export function markSection(markup,section){
  return markup.replace(/ aria-current="page"/g,'').replace(new RegExp(`(data-section="${section}")`,'g'),'$1 aria-current="page"');
}

/** The Studio frame with the saved sidebar and an empty page, or '' when there is nothing to show yet. */
export function shellMarkup(shell,section){
  if(!shell||section==='Settings')return '';
  return `<div class="host-console"><aside class="host-nav">${markSection(shell.nav,section)}</aside><main class="host-content" id="main" aria-busy="true"></main><nav class="tabbar" aria-label="Sections">${markSection(shell.tabs,section)}</nav></div>`;
}

// Studio's first reads, sent beside /api/bootstrap when this browser was
// signed in last time. Each is the same request Studio would send itself
// (personal profile, no workspace header), and is used at most once.
const early=new Map();
const read=path=>fetch('/api/live/'+path).then(async response=>{let value;try{value=await response.json();}catch{value={error:response.ok?'Unexpected response.':'Request failed ('+response.status+').'};}return response.ok?{value}:{error:Object.assign(Error(value.error||'Request failed.'),{code:value.code,status:response.status})};},error=>({error}));
export function startEarlyReads(shell){
  if(!shell)return;
  const paths=['workspaces','calendar-contributions'];
  if(shell.personal)paths.push('settings','bookings','calendars');
  for(const path of paths)if(!early.has(path))early.set(path,read(path));
}
/** A reply started by startEarlyReads, resolving to {value} or {error}; null when none was sent. */
export function takeEarlyRead(path){const reply=early.get(path)??null;early.delete(path);return reply;}
export function dropEarlyReads(){early.clear();}
