import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DEFAULT} from '../public/policy.js';
import {validExpiry,isLinkClosed,accessFor,linkState,linkStateLabel,previewDraft,epochToLocalInput,localInputToEpoch,zoneLabel,expiryText,linkAccessSummary,linkAccessMarkup,readLinkAccess,closedLinkMarkup} from '../public/link-access-ui.js';
import {projectPreviewState} from '../public/share-ui.js';
import {draftPreview} from '../public/preview-policy.js';

const now=Date.UTC(2026,10,12,12,0),later=Date.UTC(2026,11,4,8,0);// 4 Dec 2026 09:00 Oslo
// Minimal DOM double for readLinkAccess: the editor plus its controls.
function form({single=false,mode='never',value='',initial='',saved='',zone='Europe/Oslo',editor=true}={}){
 const error={textContent:''},el={open:false,dataset:{zone},querySelector:s=>({'[name=singleUse]':{checked:single},'[data-expiry-mode]':{value:mode},'[data-expires-at]':{value,dataset:{initial,saved:String(saved)}},'[data-link-access-error]':error})[s]||null};
 return {el,error,querySelector:s=>s==='[data-link-access]'&&editor?el:null};
}

test('stored expiry accepts only nonnegative safe Date-range epochs',()=>{
 assert.equal(validExpiry(null),null);assert.equal(validExpiry(0),0);assert.equal(validExpiry(later+1234),later+1234);
 for(const bad of [-1,1.5,'1',NaN,Infinity,8.64e15+1,Number.MAX_SAFE_INTEGER+2])assert.equal(validExpiry(bad),null);
});

test('closed-link codes are the two admission codes only',()=>{
 assert.equal(isLinkClosed({status:410,code:'link_expired'}),true);assert.equal(isLinkClosed({code:'link_used'}),true);
 for(const e of [{code:'change_window_closed'},{status:410},null,undefined,{code:'slot_unavailable'}])assert.equal(isLinkClosed(e),false);
});

test('state: expiry wins, used counts only while single-use is on, paused stays paused',()=>{
 const used={used:true};
 assert.equal(linkState({},{},now),'open');
 assert.equal(linkState({expiresAt:now},{},now),'expired','closed at exactly expiresAt');
 assert.equal(linkState({expiresAt:now+1},{},now),'open');
 assert.equal(linkState({singleUse:true},used,now),'used');
 assert.equal(linkState({singleUse:false},used,now),'open','toggled off allows more bookings');
 assert.equal(linkState({singleUse:true,expiresAt:now-1},used,now),'expired');
 assert.deepEqual(linkStateLabel({published:true,singleUse:true},used,now),{label:'Used',live:false,state:'used'});
 assert.deepEqual(linkStateLabel({published:true,expiresAt:1},{},now),{label:'Expired',live:false,state:'expired'});
 assert.deepEqual(linkStateLabel({published:false,expiresAt:1},{},now),{label:'Paused',live:false,state:'paused'});
 assert.deepEqual(linkStateLabel({published:true},{},now),{label:'Active',live:true,state:'open'});
});

test('usage map is read-only input; malformed or missing entries read as unused',()=>{
 assert.deepEqual(accessFor({linkAccess:{intro:{state:'used',used:true,expiresAt:null}}},'intro'),{used:true});
 assert.deepEqual(accessFor({linkAccess:{intro:{used:'yes'}}},'intro'),{used:false});
 assert.deepEqual(accessFor({},'intro'),{used:false});assert.deepEqual(accessFor(null,'x'),{used:false});
});

test('zone conversion roundtrips wall time, including clock changes',()=>{
 assert.equal(epochToLocalInput(later,'Europe/Oslo'),'2026-12-04T09:00');
 assert.equal(localInputToEpoch('2026-12-04T09:00','Europe/Oslo'),later);
 assert.equal(localInputToEpoch('2026-12-04T09:00','America/New_York'),Date.UTC(2026,11,4,14,0));
 assert.equal(localInputToEpoch('2026-07-01T09:00','Europe/Oslo'),Date.UTC(2026,6,1,7,0),'summer offset');
 // Nonexistent wall times must never silently change the entered expiry.
 assert.equal(localInputToEpoch('2026-03-29T02:30','Europe/Oslo'),null);
 assert.equal(localInputToEpoch('2027-03-14T02:30','America/New_York'),null);
 assert.equal(localInputToEpoch('2027-11-07T01:30','America/New_York'),Date.UTC(2027,10,7,5,30));
 assert.equal(epochToLocalInput(Date.UTC(2026,2,29,1,30),'Europe/Oslo'),'2026-03-29T03:30');
 for(const bad of ['','2026-02-30T10:00','2026-13-01T10:00','tomorrow','2026-12-04 09:00'])assert.equal(localInputToEpoch(bad,'Europe/Oslo'),null,bad);
 assert.equal(epochToLocalInput(later+45123,'Europe/Oslo'),'2026-12-04T09:00','seconds are not shown');
 assert.equal(epochToLocalInput(8.64e15,'UTC'),'','beyond datetime-local range');
 assert.equal(zoneLabel('Europe/Oslo',later),'Europe/Oslo · GMT+1');assert.equal(zoneLabel('UTC',later),'UTC · GMT+0');
 assert.equal(expiryText(later,'Europe/Oslo',now),'4 Dec, 09:00');assert.equal(expiryText(Date.UTC(2027,0,5,8),'Europe/Oslo',now),'5 Jan 2027, 09:00');
});

test('editor markup: collapsed and clutter-free by default, open with saved values',()=>{
 const off=linkAccessMarkup(DEFAULT,{zone:'Europe/Oslo',now});
 assert.match(off,/<details class="link-access" data-link-access[^>]*data-used="false"\s*>/,'collapsed');
 assert.match(off,/<summary>Link access<small data-link-access-summary>Open<\/small>/);
 assert.match(off,/name="singleUse"\s*>One booking only/);
 assert.match(off,/<option value="never" selected>Never<\/option><option value="date" >On a date/);
 assert.match(off,/data-expiry-when hidden>/,'no date field while Never');
 assert.match(off,/data-link-access-note><\/p>/,'no explanatory copy while off');
 const on=linkAccessMarkup({singleUse:true,expiresAt:later+30500},{zone:'Europe/Oslo',now});
 assert.match(on,/data-link-access[^>]* open>/);assert.match(on,/name="singleUse" checked>/);
 assert.match(on,/value="2026-12-04T09:00" data-initial="2026-12-04T09:00" data-saved="1796371230500"/);
 assert.match(on,/Europe\/Oslo · GMT\+1/,'timezone shown where expiry is entered');
 assert.match(on,/One booking · Until 4 Dec, 09:00/);assert.match(on,/Closes after the first booking request\./);
 const used=linkAccessMarkup({singleUse:true},{access:{used:true},zone:'UTC',now});
 assert.match(used,/<small data-link-access-summary>Used<\/small>/);assert.match(used,/Already used\. Closed to new bookings\./);
 assert.match(linkAccessMarkup({expiresAt:1},{zone:'UTC',now}),/<small data-link-access-summary>Expired<\/small>/);
 assert.equal(linkAccessMarkup({singleUse:true},{access:{used:false},zone:'UTC',now}).includes('<script'),false);
 assert.match(linkAccessMarkup({},{zone:'"><x>',now}),/data-zone="&quot;&gt;&lt;x&gt;"/,'escaped');
});

test('reading: absent editor keeps stored values; never/date/unchanged precision',()=>{
 assert.deepEqual(readLinkAccess(form({editor:false})),{});
 assert.deepEqual(readLinkAccess(form()),{expiresAt:null,singleUse:false});
 assert.deepEqual(readLinkAccess(form({single:true})),{expiresAt:null,singleUse:true});
 const exact=later+30500;// non-minute saved epoch survives an unrelated edit
 assert.deepEqual(readLinkAccess(form({mode:'date',value:'2026-12-04T09:00',initial:'2026-12-04T09:00',saved:exact}),{now}),{expiresAt:exact,singleUse:false});
 const expired=now-5000;// an already-expired saved value roundtrips unchanged
 assert.deepEqual(readLinkAccess(form({mode:'date',value:'x',initial:'x',saved:expired}),{now}),{expiresAt:expired,singleUse:false});
 assert.deepEqual(readLinkAccess(form({mode:'date',value:'2026-12-05T10:15',initial:'2026-12-04T09:00',saved:exact}),{now}),{expiresAt:Date.UTC(2026,11,5,9,15),singleUse:false});
 assert.deepEqual(readLinkAccess(form({mode:'never',value:'2026-12-04T09:00',initial:'2026-12-04T09:00',saved:exact}),{now}),{expiresAt:null,singleUse:false},'switching to Never clears');
});

test('reading rejects missing and past new expiries, opens the fold and shows the error',()=>{
 for(const [opts,text] of [[{mode:'date'},'Choose when this link expires.'],[{mode:'date',value:'2026-11-01T09:00'},'Choose a future expiry time.'],[{mode:'date',value:'2026-02-30T09:00'},'Choose a valid expiry time.']]){
  const f=form(opts);assert.throws(()=>readLinkAccess(f,{now}),{message:text});assert.equal(f.el.open,true);assert.equal(f.error.textContent,text);
 }
});

test('summary reflects draft values',()=>{
 assert.equal(linkAccessSummary({},{},'UTC',now),'Open');
 assert.equal(linkAccessSummary({singleUse:true},{},'UTC',now),'One booking');
 assert.equal(linkAccessSummary({expiresAt:later},{},'Europe/Oslo',now),'Until 4 Dec, 09:00');
 assert.equal(linkAccessSummary({singleUse:false},{used:true},'UTC',now),'Open');
});

test('owner preview stays local and unblocked by admission settings',()=>{
 const settings={availabilitySchedules:[],linkAccess:{intro:{state:'expired',used:true,expiresAt:1}},profile:{}};
 const draft={...DEFAULT,id:'intro',expiresAt:1,singleUse:true,zone:'UTC',weeklyHours:{0:[],1:[{start:0,end:1440}],2:[{start:0,end:1440}],3:[{start:0,end:1440}],4:[{start:0,end:1440}],5:[{start:0,end:1440}],6:[]}};
 const local=previewDraft(draft);assert.equal(local.expiresAt,null);assert.equal(local.singleUse,false);assert.equal(draft.expiresAt,1,'input not mutated');
 const state=draftPreview(settings,local,now);assert.ok(state.slots.length>0,'example times shown for an expired link');
 const projected=projectPreviewState(state);
 for(const key of ['expiresAt','singleUse','linkAccess','id','accountId','calendarId'])assert.equal(key in projected.config,false,key);
 assert.equal(JSON.stringify(projected).includes('linkAccess'),false);
});

test('guest closed view is minimal, escaped and never claims an uncertain request failed',()=>{
 const expired=closedLinkMarkup('link_expired');
 assert.match(expired,/data-link-closed="expired"/);assert.match(expired,/<h1 tabindex="-1">This link has expired<\/h1>/);assert.match(expired,/Ask the organizer for a new link\./);
 assert.doesNotMatch(expired,/slot|form|button|fail/i);
 const used=closedLinkMarkup('link_used',{host:'<Ada>',uncertain:true});
 assert.match(used,/This link has been used/);assert.match(used,/Ask &lt;Ada&gt; for a new link\./);assert.match(used,/If you already sent a request, check your email\./);
 assert.doesNotMatch(closedLinkMarkup('link_used'),/check your email/);
});

test('wiring: Studio, editor and guest use the link access module; stylesheet is standalone',()=>{
 const host=readFileSync(new URL('../public/host-ui.js',import.meta.url),'utf8'),editor=readFileSync(new URL('../public/host-editor.js',import.meta.url),'utf8'),app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),css=readFileSync(new URL('../public/link-access-ui.css',import.meta.url),'utf8');
 assert.match(host,/linkAccessMarkup\(t,\{access:accessFor\(settings,t\.id\)\}\)/);assert.match(host,/bindLinkAccess\(form\)/);assert.match(host,/draftPreview\(settings,previewDraft\(draft\)/);
 assert.match(editor,/readLinkAccess\(form\)/);
 assert.match(app,/isLinkClosed\(err\)\)\{showClosedLink/);
 assert.doesNotMatch(app.slice(app.indexOf('function showClosedLink')).split('\n')[0],/requestKey=|draft=/,'closed view keeps the idempotency key and draft');
 assert.match(css,/\.link-access-when\[hidden\]\{display:none\}/);
});
