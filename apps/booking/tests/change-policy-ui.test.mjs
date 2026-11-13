import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DEFAULT} from '../public/policy.js';
import {noticeLabel,noticePair,changeRulesMarkup,readChangeNotices,changeRulesSummary,deadlineText,bookingPolicy,policyFor,changeNoteText,changeNoteMarkup,manageChangeState,closedText,cleanReason,isChangeWindowClosed} from '../public/change-policy-ui.js';
import {projectPreviewState} from '../public/share-ui.js';
import {draftPreview} from '../public/preview-policy.js';

const H=3600000,start=Date.UTC(2026,11,4,10,0);// Thu 4 Dec 2026 10:00 UTC
// Minimal form double for readChangeNotices.
function form(values,{editor=true}={}){
 const rows={};const elements={};
 for(const [name,v] of Object.entries(values)){const custom=typeof v==='object'?v:null;const row={querySelector:s=>s==='[data-change-amount]'?{value:String(custom?.amount??'')}:s==='[data-change-unit]'?{value:String(custom?.unit??1)}:null};rows[name]=row;elements[name]={value:custom?'custom':String(v),closest:()=>row};}
 return {elements,querySelector:s=>s==='[data-change-rules]'&&editor?{}:null};
}

test('labels are compact and exact',()=>{
 assert.equal(noticeLabel(60),'1 hour');assert.equal(noticeLabel(90),'1 hr 30 min');assert.equal(noticeLabel(45),'45 minutes');assert.equal(noticeLabel(1440),'1 day');assert.equal(noticeLabel(2880),'2 days');assert.equal(noticeLabel(10080),'1 week');assert.equal(noticeLabel(43200),'30 days');
});

test('host markup: default anytime, presets, saved custom values preserved and selected',()=>{
 const zero=changeRulesMarkup(DEFAULT);
 assert.match(zero,/<legend>Guest changes<\/legend>/);
 assert.match(zero,/name="cancellationNoticeMinutes"[^]*?<option value="0" selected>Anytime/);
 assert.match(zero,/name="rescheduleNoticeMinutes"[^]*?<option value="0" selected>/);
 assert.match(zero,/<option value="custom">Custom…<\/option>/);
 const custom=changeRulesMarkup({cancellationNoticeMinutes:90,rescheduleNoticeMinutes:4320});
 assert.match(custom,/<option value="90" selected>1 hr 30 min before/);
 assert.match(custom,/<option value="4320" selected>3 days before/);
 assert.match(changeRulesMarkup({cancellationNoticeMinutes:'bad'}),/<option value="0" selected>/,'malformed stored values display as anytime');
});

test('host read: presets, custom amounts, absent editor and strict limits',()=>{
 assert.deepEqual(readChangeNotices(form({cancellationNoticeMinutes:0,rescheduleNoticeMinutes:0})),{cancellationNoticeMinutes:0,rescheduleNoticeMinutes:0});
 assert.deepEqual(readChangeNotices(form({cancellationNoticeMinutes:1440,rescheduleNoticeMinutes:{amount:90,unit:1}})),{cancellationNoticeMinutes:1440,rescheduleNoticeMinutes:90});
 assert.deepEqual(readChangeNotices(form({cancellationNoticeMinutes:{amount:30,unit:1440},rescheduleNoticeMinutes:{amount:3,unit:60}})),{cancellationNoticeMinutes:43200,rescheduleNoticeMinutes:180});
 assert.deepEqual(readChangeNotices(form({},{editor:false})),{},'older forms keep stored values');
 assert.throws(()=>readChangeNotices(form({cancellationNoticeMinutes:{amount:31,unit:1440},rescheduleNoticeMinutes:0})),/30 days/);
 for(const amount of ['','0','1.5','-2','abc'])assert.throws(()=>readChangeNotices(form({cancellationNoticeMinutes:{amount,unit:60},rescheduleNoticeMinutes:0})),/whole number/);
});

test('summary is empty by default and short otherwise',()=>{
 assert.equal(changeRulesSummary(DEFAULT),'');
 assert.equal(changeRulesSummary({cancellationNoticeMinutes:1440,rescheduleNoticeMinutes:1440}),'Changes 1 day ahead');
 assert.equal(changeRulesSummary({cancellationNoticeMinutes:120}),'Cancel 2 hours ahead');
});

test('guest note: zero adds no text; deadlines use the guest zone and offset',()=>{
 assert.equal(changeNoteText(policyFor(DEFAULT,start),'Europe/Oslo',false,start-48*H),'');
 assert.equal(changeNoteMarkup(policyFor({},start),'UTC'),'');
 assert.equal(changeNoteText(null,'UTC'),'');
 const both=policyFor({cancellationNoticeMinutes:1440,rescheduleNoticeMinutes:1440},start);
 assert.equal(changeNoteText(both,'Europe/Oslo',false,start-48*H),'Cancel or reschedule by Thu 3 Dec, 11:00 GMT+1.');
 assert.equal(changeNoteText(both,'America/New_York',true,start-48*H),'Cancel or reschedule by Thu 3 Dec, 5:00 am GMT-5.');
 assert.equal(deadlineText(start,'UTC'),'Fri 4 Dec, 10:00 GMT');
 const split=policyFor({cancellationNoticeMinutes:120,rescheduleNoticeMinutes:0},start);
 assert.equal(changeNoteText(split,'UTC',false,start-48*H),'Cancel by Fri 4 Dec, 08:00 GMT.');
 assert.equal(changeNoteText(both,'UTC',false,start-2*H),'This time can’t be changed online.','a time already inside the cutoff is stated plainly');
 const mixed=policyFor({cancellationNoticeMinutes:1440,rescheduleNoticeMinutes:60},start);
 assert.equal(changeNoteText(mixed,'UTC',false,start-3*H),'Can’t be cancelled online. Reschedule by Fri 4 Dec, 09:00 GMT.');
 assert.ok(!/<|—/.test(changeNoteMarkup(both,'UTC',false,start-48*H).replace(/<\/?p[^>]*>/g,'')),'no markup injection or em dash');
});

test('accepted snapshot: clean policy, legacy rows and malformed values',()=>{
 assert.equal(bookingPolicy({}),null);
 assert.equal(bookingPolicy({changePolicy:{cancelUntil:'x',rescheduleUntil:null}}),null);
 const p=bookingPolicy({changePolicy:{cancellationNoticeMinutes:60,rescheduleNoticeMinutes:0,cancelUntil:start-H,rescheduleUntil:null}});
 assert.deepEqual(p,{cancellationNoticeMinutes:60,rescheduleNoticeMinutes:0,cancelUntil:start-H,rescheduleUntil:null});
 // A reschedule keeps the original notice pair, applied to the new start.
 assert.deepEqual(policyFor(p,start+24*H),{cancellationNoticeMinutes:60,rescheduleNoticeMinutes:0,cancelUntil:start+23*H,rescheduleUntil:null});
 assert.deepEqual(noticePair({cancellationNoticeMinutes:50000,rescheduleNoticeMinutes:1.5}),{cancellationNoticeMinutes:0,rescheduleNoticeMinutes:0});
});

test('manage state: confirmed cutoffs close actions; unconfirmed withdrawal stays open',()=>{
 const changePolicy={cancellationNoticeMinutes:1440,rescheduleNoticeMinutes:120,cancelUntil:start-24*H,rescheduleUntil:start-2*H};
 const confirmed={status:'confirmed',start,end:start+H,changePolicy};
 let s=manageChangeState(confirmed,start-48*H);assert.deepEqual([s.cancel,s.reschedule,s.closed,s.nextDeadline],[true,true,[],start-24*H]);
 s=manageChangeState(confirmed,start-3*H);assert.deepEqual([s.cancel,s.reschedule,s.closed,s.nextDeadline],[false,true,['cancel'],start-2*H]);
 assert.equal(closedText(s,'UTC'),'Online cancellation closed Thu 3 Dec, 10:00 GMT. Reply to your invitation to reach the organizer.');
 s=manageChangeState(confirmed,start-H);assert.deepEqual([s.cancel,s.reschedule,s.closed,s.nextDeadline],[false,false,['cancel','reschedule'],null]);
 assert.match(closedText(s,'UTC'),/^Online changes closed Fri 4 Dec, 08:00 GMT\./);
 assert.equal(manageChangeState({...confirmed,status:'pending'},start-H).cancel,true);
 const pending={...confirmed,status:'awaiting_approval'};s=manageChangeState(pending,start-H);assert.equal(s.cancel,true);assert.equal(s.reschedule,false);assert.deepEqual(s.closed,[]);
 s=manageChangeState({status:'confirmed',start,end:start+H},start-60000);assert.deepEqual([s.cancel,s.reschedule],[true,true],'legacy rows without a policy stay open');
 s=manageChangeState({...confirmed,changePolicy:{...changePolicy,cancelUntil:null,rescheduleUntil:null}},start-60000);assert.deepEqual([s.cancel,s.reschedule,s.closed],[true,true,[]]);
 s=manageChangeState(confirmed,start+2*H);assert.deepEqual([s.cancel,s.reschedule,s.closed],[false,false,[]],'past bookings have no actions or closed copy');
});

test('reason helpers and refusal code',()=>{
 assert.equal(cleanReason('   '),undefined);assert.equal(cleanReason(''),undefined);assert.equal(cleanReason(' Travel '),'Travel');assert.equal(cleanReason('x'.repeat(600)).length,500);
 assert.equal(isChangeWindowClosed({code:'change_window_closed'}),true);assert.equal(isChangeWindowClosed(Error('x')),false);
});

test('owner preview whitelists only public notice minutes and stays local',()=>{
 const state=draftPreview({availabilitySchedules:[]},{...DEFAULT,zone:'UTC',cancellationNoticeMinutes:1440,rescheduleNoticeMinutes:90},Date.UTC(2026,10,12));
 const projected=projectPreviewState({...state,config:{...state.config,cancelUntil:1,cancellationReason:'secret',changePolicy:{cancelUntil:1}}});
 assert.equal(projected.config.cancellationNoticeMinutes,1440);assert.equal(projected.config.rescheduleNoticeMinutes,90);
 for(const key of ['cancelUntil','rescheduleUntil','cancellationReason','changePolicy'])assert.equal(key in projected.config,false,key);
 for(const bad of [-1,43201,1.5,'60',null])assert.equal(projectPreviewState({...state,config:{...state.config,cancellationNoticeMinutes:bad}}).config.cancellationNoticeMinutes,0);
 assert.equal(projectPreviewState({...state,config:{...state.config,cancellationNoticeMinutes:undefined}}).config.cancellationNoticeMinutes,0);
});

test('source guards: staff use private routes; guest reason, refusal and receipt wiring',()=>{
 const host=readFileSync(new URL('../public/host-ui.js',import.meta.url),'utf8'),manage=readFileSync(new URL('../public/manage-ui.js',import.meta.url),'utf8'),app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),editor=readFileSync(new URL('../public/host-editor.js',import.meta.url),'utf8');
 assert.ok(!host.includes("action:'cancel',token"),'staff cancel never uses the guest capability');
 assert.ok(!host.includes('?reschedule='),'staff reschedule is inline and authenticated');
 assert.match(host,/api\('bookings\/'\+encodeURIComponent\(id\)\+'\/cancel',reason\?\{reason\}:\{\}\)/);
 assert.ok(!/bypass|force/i.test(host.match(/data-cancel[^]*?finally/)?.[0]||''),'no bypass flag');
 assert.match(host,/changeRulesMarkup\(t\)/);assert.match(editor,/readChangeNotices\(form\)/);
 assert.match(manage,/call\('cancel',reason\?\{reason\}:\{\}\)/);assert.match(manage,/refused\.add\('cancel'\)/);assert.match(manage,/maxlength="\$\{REASON_MAX\}"/);
 assert.match(manage,/esc\(booking\.cancellationReason\)/);assert.match(host,/esc\(b\.cancellationReason\)/);
 assert.match(app,/changeNoteMarkup\(policyFor\(originalBooking\?bookingPolicy\(originalBooking\):config,selectedSlot\.start\)/);
 assert.match(app,/isChangeWindowClosed\(err\)/);
 assert.match(manage,/if\(confirmCancel&&patchConfirm\(\)\)return;/,'deadline timer never replaces an open confirmation');
 assert.ok(!/catch\(err\)\{working=false;setBusy\(false\);[^}]*render\(\)/.test(manage),'late 409 patches in place instead of re-rendering');
 assert.match(manage,/throw Object\.assign\(Error\(result\.error\),\{status:response\.status,code:result\.code\}\)/,'manage wrapper keeps status and code');
 assert.match(app,/duration:config\.duration/,'explicit duration on new live bookings is preserved');
 assert.match(app,/err\.code==='idempotency_conflict'\)state=null/,'idempotency conflicts never adopt newer settings');
});
