import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {DEFAULT} from '../public/policy.js';
import {BookingLedger} from '../src/ledger.js';
import {HostedSettings,normalizeSettingsPatch} from '../src/settings.js';
function setup(id='host-one'){
 const db=new DatabaseSync(':memory:');const storage={sql:{exec(query,...args){const rows=db.prepare(query).all(...args);return {toArray:()=>rows};}},setAlarm:async()=>{},transactionSync(callback){db.exec('BEGIN');try{const value=callback();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}};
 const ledger=new BookingLedger({storage},{});ledger.init({id,name:'Owner',email:'owner@example.test'});ledger.putAccount({id:'google-one',email:'owner@example.test',connected:true,destinationCalendarId:'primary',conflictCalendarIds:['primary'],grant:'private-encrypted-grant'});
 ledger.saveSettings({meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',published:true,accountId:'google-one',calendarId:'primary'}]});return {ledger,storage,settings:new HostedSettings(ledger,storage,{reminders:false})};
}
test('preview normalizes configuration and reports changes without persisting or exposing credentials',async()=>{
 const {ledger,settings}=setup(),before=ledger.settings();const result=await settings.preview({profile:{name:' New owner '},meetingTypes:before.meetingTypes.map(t=>({...t,title:' New title '}))});
 assert.equal(result.settings.profile.name,'New owner');assert.equal(result.settings.meetingTypes[0].title,'New title');assert.ok(result.changes.some(c=>c.path==='profile.name'));assert.equal(result.revision.length,43);assert.deepEqual(ledger.settings(),before);assert.ok(!JSON.stringify(result).includes('private-encrypted-grant'));assert.ok(result.warnings.some(w=>w.includes('Reminders')));
});
test('delivery readiness warning follows effective reminder offsets',()=>{
 const {ledger}=setup(),current=ledger.settings();
 for(const policy of [{reminder:true,reminderMinutes:[]},{reminder:false,reminderMinutes:[60]}]){
  const result=normalizeSettingsPatch(current,{meetingTypes:current.meetingTypes.map(t=>({...t,...policy}))},{reminders:false});
  assert.ok(!result.warnings.some(w=>w.includes('Reminders')));
 }
 const result=normalizeSettingsPatch(current,{meetingTypes:current.meetingTypes.map(t=>({...t,reminder:true,reminderMinutes:[60]}))},{reminders:false});
 assert.ok(result.warnings.some(w=>w.includes('Reminders')));
});
test('settings apply validates the complete patch and commits profile and meeting policy atomically',async()=>{
 const {ledger,settings}=setup(),before=await settings.read();const patch={profile:{company:'Company'},meetingTypes:before.meetingTypes.map(t=>({...t,duration:45}))};const preview=await settings.preview(patch),result=await settings.apply(patch,preview.revision);
 assert.equal(result.settings.profile.company,'Company');assert.equal(result.settings.meetingTypes[0].duration,45);assert.notEqual(result.revision,before.revision);assert.equal(ledger.account('google-one').grant,'private-encrypted-grant');
 const saved=ledger.settings(),put=ledger.putMeta;ledger.putMeta=function(key,value){if(key==='meetingTypes')throw Error('storage failure');return put.call(this,key,value);};
 await assert.rejects(()=>settings.apply({...patch,profile:{company:'Should roll back'}},result.revision),/storage failure/);assert.deepEqual(ledger.settings(),saved);
});
test('revisions bind host state, detect stale browser changes, and admit one concurrent update',async()=>{
 const one=setup(),other=setup('host-two'),revision=(await one.settings.read()).revision;assert.notEqual((await other.settings.read()).revision,revision);
 const results=await Promise.allSettled([one.settings.apply({profile:{company:'One'}},revision),one.settings.apply({profile:{company:'Two'}},revision)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
 const latest=(await one.settings.read()).revision;one.ledger.saveSettings({profile:{name:'Changed in browser'}});await assert.rejects(()=>one.settings.apply({profile:{company:'Stale'}},latest),error=>error.code==='settings_conflict');
});
test('settings capability cannot modify grants, identity, calendar accounts, arbitrary fields or foreign destinations',()=>{
 const {ledger}=setup(),current=ledger.settings();for(const patch of [{accounts:[]},{profile:{email:'other@example.test'}},{profile:{id:'other'}},{profile:{grant:'secret'}},{accessToken:'secret'},{meetingTypes:[{...current.meetingTypes[0],accessToken:'secret'}]},{meetingTypes:[{...current.meetingTypes[0],accountId:'foreign'}]}])assert.throws(()=>normalizeSettingsPatch(current,patch));
 assert.deepEqual(ledger.settings(),current);assert.throws(()=>normalizeSettingsPatch(current,{meetingTypes:[current.meetingTypes[0],current.meetingTypes[0]]}));
});
test('preview and apply preserve normalized weekly ranges, date overrides, and daily booking limits',async()=>{
 const {ledger,settings}=setup(),type=ledger.settings().meetingTypes[0],patch={meetingTypes:[{...type,weeklyHours:{'1':[{start:780,end:1020},{start:540,end:720}]},dateOverrides:{'2026-12-24':[],'2026-12-25':[{start:600,end:720}]},dailyBookingLimit:3}]};
 const preview=await settings.preview(patch);assert.deepEqual(preview.patch.meetingTypes[0].weeklyHours['1'],[{start:540,end:720},{start:780,end:1020}]);assert.deepEqual(preview.patch.meetingTypes[0].weeklyHours['0'],[]);assert.deepEqual(preview.patch.meetingTypes[0].dateOverrides['2026-12-24'],[]);assert.equal(preview.patch.meetingTypes[0].dailyBookingLimit,3);
 const applied=await settings.apply(preview.patch,preview.revision);assert.deepEqual(applied.settings.meetingTypes[0].weeklyHours,preview.patch.meetingTypes[0].weeklyHours);assert.equal(ledger.settings().meetingTypes[0].dailyBookingLimit,3);
 for(const invalid of [{weeklyHours:{'8':[]}},{weeklyHours:{'1':[{start:600,end:720},{start:660,end:800}]}},{dateOverrides:{'2026-02-30':[]}},{dailyBookingLimit:51}])await assert.rejects(()=>settings.preview({meetingTypes:[{...type,...invalid}]}),error=>error.code==='invalid_settings');
});
test('browser and MCP settings snapshots share revisions and reject stale edits in both directions',async()=>{
 const {ledger,storage,settings:mcp}=setup(),browser=new HostedSettings(ledger,storage),browserRead=await browser.read(),mcpRead=await mcp.read();assert.equal(browserRead.revision,mcpRead.revision);
 const policy={...mcpRead.meetingTypes[0],bufferBefore:0,bufferAfter:30,slotInterval:20,weeklyBookingLimit:7,locationType:'google_meet',weeklyHours:{'1':[{start:550,end:720}]},dateOverrides:{'2026-12-24':[]},dailyBookingLimit:2};
 const mcpSaved=await mcp.apply({meetingTypes:[policy]},mcpRead.revision);await assert.rejects(()=>browser.apply({profile:{name:'Stale browser'}},browserRead.revision),error=>error.code==='settings_conflict');
 const fresh=await browser.read(),browserSaved=await browser.apply({profile:{company:' Browser company '}},fresh.revision);await assert.rejects(()=>mcp.apply({meetingTypes:mcpRead.meetingTypes},mcpSaved.revision),error=>error.code==='settings_conflict');
 const saved=ledger.settings();assert.equal(saved.profile.id,'host-one');assert.equal(saved.profile.email,'owner@example.test');assert.equal(saved.profile.company,'Browser company');assert.deepEqual(saved.meetingTypes,mcpSaved.settings.meetingTypes);assert.equal(saved.meetingTypes[0].bufferBefore,0);assert.equal(saved.meetingTypes[0].bufferAfter,30);assert.equal(saved.meetingTypes[0].slotInterval,20);assert.equal(saved.meetingTypes[0].weeklyBookingLimit,7);assert.equal(saved.meetingTypes[0].locationType,'google_meet');assert.deepEqual(saved.meetingTypes[0].dateOverrides,{'2026-12-24':[]});assert.notEqual(browserSaved.revision,mcpSaved.revision);assert.equal(ledger.account('google-one').grant,'private-encrypted-grant');
});
test('concurrent browser and MCP saves commit exactly one complete configuration without altering identity or grants',async()=>{
 const {ledger,storage,settings:mcp}=setup(),browser=new HostedSettings(ledger,storage),snapshot=await browser.read();
 const changes=[{profile:{name:'Browser owner',company:'Browser'},meetingTypes:snapshot.meetingTypes.map(type=>({...type,title:'Browser meeting',weeklyBookingLimit:5}))},{profile:{name:'MCP owner',company:'MCP'},meetingTypes:snapshot.meetingTypes.map(type=>({...type,title:'MCP meeting',slotInterval:30}))}];
 const results=await Promise.allSettled([browser.apply(changes[0],snapshot.revision),mcp.apply(changes[1],snapshot.revision)]),winner=results.find(result=>result.status==='fulfilled');assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.code==='settings_conflict').length,1);assert.deepEqual(ledger.settings(),winner.value.settings);assert.equal(ledger.settings().profile.id,'host-one');assert.equal(ledger.settings().profile.email,'owner@example.test');assert.equal(ledger.account('google-one').grant,'private-encrypted-grant');
});

test('named schedules are revisioned host settings; linked removal fails and explicit detachment is atomic',async()=>{
 const {ledger,settings}=setup(),before=await settings.read(),schedule={id:'work',name:' Work ',zone:'America/New_York',weeklyHours:{1:[{start:540,end:720}]},dateOverrides:{'2026-12-25':[]}},type={...before.meetingTypes[0],scheduleId:'work'};
 const preview=await settings.preview({availabilitySchedules:[schedule],meetingTypes:[type]});assert.equal(preview.patch.availabilitySchedules[0].name,'Work');assert.deepEqual(ledger.settings().availabilitySchedules,[]);const saved=await settings.apply(preview.patch,preview.revision);assert.notEqual(saved.revision,before.revision);assert.equal(saved.settings.meetingTypes[0].zone,DEFAULT.zone);assert.equal(ledger.type('intro').zone,schedule.zone);
 const changed={...saved.settings.availabilitySchedules[0],name:'Afternoons',weeklyHours:{1:[{start:780,end:900}]}};const edit=await settings.preview({availabilitySchedules:[changed]});assert.ok(edit.warnings.some(w=>w.includes('every linked meeting')));await settings.apply(edit.patch,edit.revision);assert.deepEqual(ledger.type('intro').weeklyHours[1],[{start:780,end:900}]);await assert.rejects(()=>settings.apply({profile:{name:'Stale'}},saved.revision),error=>error.code==='settings_conflict');
 const current=ledger.settings();await assert.rejects(()=>settings.preview({availabilitySchedules:[]}),/still in use/);assert.throws(()=>ledger.saveSettings({profile:{name:'Must not change'},availabilitySchedules:[]}),/still in use/);assert.deepEqual(ledger.settings(),current);
 const detached=await settings.preview({availabilitySchedules:[],meetingTypes:current.meetingTypes.map(type=>({...type,...ledger.type(type.slug),scheduleId:null}))});await settings.apply(detached.patch,detached.revision);assert.deepEqual(ledger.settings().availabilitySchedules,[]);assert.equal(ledger.type('intro').scheduleId,null);assert.equal(ledger.type('intro').zone,schedule.zone);assert.deepEqual(ledger.type('intro').weeklyHours[1],[{start:780,end:900}]);
});
test('schedule references cannot access another host and invalid combined writes make no changes',async()=>{
 const one=setup(),other=setup('host-two'),schedule={id:'private-work',name:'Private hours',zone:'UTC',weeklyHours:{1:[{start:540,end:720}]},dateOverrides:{}};one.ledger.saveSettings({availabilitySchedules:[schedule]});const current=other.ledger.settings();await assert.rejects(()=>other.settings.preview({meetingTypes:current.meetingTypes.map(type=>({...type,scheduleId:schedule.id}))}),/unavailable/);assert.deepEqual(other.ledger.settings(),current);
 await assert.rejects(()=>other.settings.preview({availabilitySchedules:[{...schedule,grant:'injected'}]}),/Unsupported/);assert.throws(()=>other.ledger.saveSettings({availabilitySchedules:null}));assert.deepEqual(other.ledger.settings(),current);
});
test('schedule-only edits preserve publication state and require detaching unpublished references too',async()=>{
 const {ledger,settings}=setup(),schedule={id:'work',name:'Work',zone:'UTC',weeklyHours:{1:[{start:540,end:720}]},dateOverrides:{}};
 ledger.saveSettings({availabilitySchedules:[schedule],meetingTypes:ledger.settings().meetingTypes.map(type=>({...type,published:false,scheduleId:'work'}))});
 const preview=await settings.preview({availabilitySchedules:[{...schedule,zone:'Asia/Kathmandu'}]});const result=await settings.apply(preview.patch,preview.revision);assert.equal(result.settings.meetingTypes[0].published,false);assert.equal(ledger.type('intro'),undefined);assert.equal(ledger.type('intro',true).zone,'Asia/Kathmandu');await assert.rejects(()=>settings.preview({availabilitySchedules:[]}),/still in use/);
});
test('older meeting-type clients preserve approval policy unless they explicitly change it',async()=>{
 const {ledger,settings}=setup();ledger.saveSettings({meetingTypes:ledger.settings().meetingTypes.map(type=>({...type,requiresApproval:true,approvalExpiryMinutes:240}))});const before=await settings.read(),old={...before.meetingTypes[0],title:'Old client title'};delete old.requiresApproval;delete old.approvalExpiryMinutes;
 const result=await settings.apply({meetingTypes:[old]},before.revision);assert.equal(result.settings.meetingTypes[0].requiresApproval,true);assert.equal(result.settings.meetingTypes[0].approvalExpiryMinutes,240);ledger.saveSettings({meetingTypes:[old]});assert.equal(ledger.type('intro').requiresApproval,true);assert.equal(ledger.type('intro').approvalExpiryMinutes,240);
 const latest=await settings.read(),off=await settings.apply({meetingTypes:[{...old,requiresApproval:false}]},latest.revision);assert.equal(off.settings.meetingTypes[0].requiresApproval,false);assert.equal(off.settings.meetingTypes[0].approvalExpiryMinutes,240);
 for(const patch of [{requiresApproval:null},{requiresApproval:'yes'},{approvalExpiryMinutes:null},{approvalExpiryMinutes:14},{approvalExpiryMinutes:10081}])await assert.rejects(()=>settings.preview({meetingTypes:[{...old,...patch}]}));
});

const defaultSchedule=(id,zone='UTC')=>({id,name:id,zone,weeklyHours:{1:[{start:540,end:720}]},dateOverrides:{}});
test('host default is opt-in, previewed and revisioned while preserving raw fallback hours',async()=>{
 const {ledger,settings}=setup(),before=await settings.read(),work=defaultSchedule('work'),later={...defaultSchedule('later','Europe/Oslo'),weeklyHours:{1:[{start:780,end:900}]}};
 assert.equal(before.defaultAvailabilityScheduleId,null);assert.equal(before.meetingTypes[0].useDefaultSchedule,false);
 const preview=await settings.preview({availabilitySchedules:[work,later],defaultAvailabilityScheduleId:'work'});assert.equal(ledger.settings().defaultAvailabilityScheduleId,null);await settings.apply(preview.patch,preview.revision);
 assert.equal(ledger.type('intro').zone,DEFAULT.zone);assert.equal(ledger.type('intro').useDefaultSchedule,false);
 const raw={...ledger.settings().meetingTypes[0],useDefaultSchedule:true,zone:'Pacific/Honolulu',weeklyHours:{2:[{start:600,end:660}]}};const linked=await settings.preview({meetingTypes:[raw]});await settings.apply(linked.patch,linked.revision);
 assert.equal(ledger.type('intro').zone,'UTC');assert.equal(ledger.settings().meetingTypes[0].zone,'Pacific/Honolulu');assert.deepEqual(ledger.settings().meetingTypes[0].weeklyHours[2],[{start:600,end:660}]);
 const switchPreview=await settings.preview({defaultAvailabilityScheduleId:'later'});assert.ok(switchPreview.warnings.some(w=>w.includes('every linked meeting')));assert.equal(ledger.type('intro').zone,'UTC');const saved=await settings.apply(switchPreview.patch,switchPreview.revision);assert.equal(ledger.type('intro').zone,'Europe/Oslo');assert.deepEqual(ledger.type('intro').weeklyHours[1],[{start:780,end:900}]);assert.notEqual(saved.revision,switchPreview.revision);
 await assert.rejects(()=>settings.apply({profile:{company:'Stale'}},switchPreview.revision),error=>error.code==='settings_conflict');
});
test('default references and inherited unpublished types prevent unsafe removal without partial writes',async()=>{
 const {ledger,settings}=setup();ledger.saveSettings({availabilitySchedules:[defaultSchedule('work'),defaultSchedule('other')],defaultAvailabilityScheduleId:'work',meetingTypes:ledger.settings().meetingTypes.map(t=>({...t,useDefaultSchedule:true,published:false}))});const before=ledger.settings();
 for(const patch of [{defaultAvailabilityScheduleId:null},{availabilitySchedules:[defaultSchedule('other')]},{defaultAvailabilityScheduleId:'foreign'},{defaultAvailabilityScheduleId:4},{meetingTypes:before.meetingTypes.map(t=>({...t,useDefaultSchedule:null}))}]){
  await assert.rejects(()=>settings.preview({profile:{company:'Must not persist'},...patch}));assert.throws(()=>ledger.saveSettings({profile:{company:'Must not persist'},...patch}));assert.deepEqual(ledger.settings(),before);
 }
 const switched=await settings.preview({availabilitySchedules:[defaultSchedule('other')],defaultAvailabilityScheduleId:'other'});await settings.apply(switched.patch,switched.revision);assert.equal(ledger.type('intro',true).zone,'UTC');
 const detach=await settings.preview({defaultAvailabilityScheduleId:null,availabilitySchedules:[],meetingTypes:ledger.settings().meetingTypes.map(t=>({...t,useDefaultSchedule:false,scheduleId:null}))});await settings.apply(detach.patch,detach.revision);assert.equal(ledger.settings().defaultAvailabilityScheduleId,null);assert.deepEqual(ledger.settings().availabilitySchedules,[]);
});
test('default remains a protected reference even without inheritors and legacy clients preserve explicit inheritance',async()=>{
 const {ledger,settings}=setup();ledger.saveSettings({availabilitySchedules:[defaultSchedule('work')],defaultAvailabilityScheduleId:'work'});await assert.rejects(()=>settings.preview({availabilitySchedules:[]}));assert.throws(()=>ledger.saveSettings({availabilitySchedules:[]}));
 ledger.saveSettings({meetingTypes:ledger.settings().meetingTypes.map(t=>({...t,useDefaultSchedule:true}))});const legacy={...ledger.settings().meetingTypes[0],title:'Older client edit'};delete legacy.useDefaultSchedule;
 const preview=await settings.preview({meetingTypes:[legacy]});assert.equal(preview.patch.meetingTypes[0].useDefaultSchedule,true);await settings.apply(preview.patch,preview.revision);ledger.saveSettings({meetingTypes:[legacy]});assert.equal(ledger.settings().meetingTypes[0].useDefaultSchedule,true);
 const before=await settings.read(),results=await Promise.allSettled([settings.apply({defaultAvailabilityScheduleId:null,meetingTypes:[{...legacy,useDefaultSchedule:false}]},before.revision),settings.apply({profile:{company:'Concurrent'}},before.revision)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='settings_conflict').length,1);
});

test('follow-up settings preview preserve omission for older clients and disable only explicitly',async()=>{
 const {ledger,settings}=setup(),type=ledger.settings().meetingTypes[0],policy={...type,followUpMinutes:60,followUpSubject:'Hi {guest_name}',followUpBody:'About {meeting_title}'};let preview=await settings.preview({meetingTypes:[policy]});assert.equal(ledger.settings().meetingTypes[0].followUpMinutes,null);await settings.apply(preview.patch,preview.revision);
 const legacy={...policy,title:'Legacy edit'};for(const key of ['followUpMinutes','followUpSubject','followUpBody'])delete legacy[key];preview=await settings.preview({meetingTypes:[legacy]});assert.equal(preview.patch.meetingTypes[0].followUpMinutes,60);await settings.apply(preview.patch,preview.revision);ledger.saveSettings({meetingTypes:[legacy]});assert.equal(ledger.settings().meetingTypes[0].followUpBody,policy.followUpBody);
 for(const patch of [{followUpMinutes:4},{followUpSubject:'Hi {unknown}'},{followUpBody:'oops {'}])await assert.rejects(()=>settings.preview({meetingTypes:[{...policy,...patch}]}));
 preview=await settings.preview({meetingTypes:[{...ledger.settings().meetingTypes[0],followUpMinutes:null}]});await settings.apply(preview.patch,preview.revision);assert.equal(ledger.settings().meetingTypes[0].followUpMinutes,null);
});

test('booked-minute caps preview atomically, preserve old-client omissions and clear only with explicit zero',async()=>{
 const {ledger,settings}=setup(),type=ledger.settings().meetingTypes[0],policy={...type,dailyBookedMinutesLimit:90,weeklyBookedMinutesLimit:180};const preview=await settings.preview({meetingTypes:[policy]});assert.equal(ledger.settings().meetingTypes[0].dailyBookedMinutesLimit,0);await settings.apply(preview.patch,preview.revision);const legacy={...policy,title:'Older client'};delete legacy.dailyBookedMinutesLimit;delete legacy.weeklyBookedMinutesLimit;const older=await settings.preview({meetingTypes:[legacy]});assert.equal(older.patch.meetingTypes[0].dailyBookedMinutesLimit,90);await settings.apply(older.patch,older.revision);ledger.saveSettings({meetingTypes:[legacy]});assert.equal(ledger.settings().meetingTypes[0].weeklyBookedMinutesLimit,180);const before=ledger.settings();await assert.rejects(()=>settings.preview({profile:{company:'Do not save'},meetingTypes:[{...policy,weeklyBookedMinutesLimit:null}]}));assert.deepEqual(ledger.settings(),before);const clear=await settings.preview({meetingTypes:[{...policy,dailyBookedMinutesLimit:0,weeklyBookedMinutesLimit:0}]});await settings.apply(clear.patch,clear.revision);assert.equal(ledger.settings().meetingTypes[0].dailyBookedMinutesLimit,0);
});

test('long-period caps preserve older clients, reject invalid patches atomically and clear explicitly',async()=>{
 const {ledger,settings}=setup(),keys=['monthlyBookingLimit','yearlyBookingLimit','monthlyBookedMinutesLimit','yearlyBookedMinutesLimit'],policy={...ledger.settings().meetingTypes[0],monthlyBookingLimit:3,yearlyBookingLimit:20,monthlyBookedMinutesLimit:120,yearlyBookedMinutesLimit:900};
 let review=await settings.preview({meetingTypes:[policy]});await settings.apply(review.patch,review.revision);const legacy={...policy,title:'Older client change'};keys.forEach(k=>delete legacy[k]);review=await settings.preview({meetingTypes:[legacy]});keys.forEach(k=>assert.equal(review.patch.meetingTypes[0][k],policy[k]));await settings.apply(review.patch,review.revision);ledger.saveSettings({meetingTypes:[legacy]});keys.forEach(k=>assert.equal(ledger.settings().meetingTypes[0][k],policy[k]));
 const before=ledger.settings();for(const key of keys){await assert.rejects(()=>settings.preview({profile:{company:'Must not persist'},meetingTypes:[{...policy,[key]:null}]}));assert.throws(()=>ledger.saveSettings({profile:{company:'Must not persist'},meetingTypes:[{...policy,[key]:null}]}));assert.deepEqual(ledger.settings(),before);}
 review=await settings.preview({meetingTypes:[{...policy,...Object.fromEntries(keys.map(k=>[k,0]))}]});await settings.apply(review.patch,review.revision);keys.forEach(k=>assert.equal(ledger.settings().meetingTypes[0][k],0));
});

test('custom destinations require fresh writable discovery, survive unrelated edits and never trust supplied IDs',async()=>{
 const {ledger,settings}=setup();let reads=0;ledger.access=async()=> 'mock';ledger.google={listCalendars:async()=>{reads++;return [{id:'team',accessRole:'writer'},{id:'readonly',accessRole:'reader'},{id:'deleted',accessRole:'owner',deleted:true}];}};
 const type=ledger.settings().meetingTypes[0],pinned={...type,useDefaultCalendar:false,calendarId:'team'};assert.throws(()=>ledger.saveSettings({meetingTypes:[pinned]}),/Verify/);let preview=await settings.preview({meetingTypes:[pinned]});assert.equal(reads,1);assert.equal(ledger.type('intro').calendarId,'primary');await settings.apply(preview.patch,preview.revision);assert.equal(reads,2);assert.equal(ledger.type('intro').calendarId,'team');
 const oldClient={...ledger.settings().meetingTypes[0],title:'Older edit'};delete oldClient.useDefaultCalendar;preview=await settings.preview({meetingTypes:[oldClient]});await settings.apply(preview.patch,preview.revision);ledger.saveSettings({meetingTypes:[oldClient]});assert.equal(reads,2);assert.equal(ledger.type('intro').useDefaultCalendar,false);assert.equal(ledger.type('intro').calendarId,'team');
 for(const calendarId of ['readonly','deleted','foreign'])await assert.rejects(()=>settings.preview({meetingTypes:[{...pinned,calendarId}]}),/writable/);for(const useDefaultCalendar of [null,0,'false'])await assert.rejects(()=>settings.preview({meetingTypes:[{...pinned,useDefaultCalendar}]}));
 preview=await settings.preview({meetingTypes:[{...pinned,useDefaultCalendar:true,calendarId:'ignored-user-id'}]});assert.equal(preview.patch.meetingTypes[0].calendarId,'primary');await settings.apply(preview.patch,preview.revision);assert.equal(ledger.type('intro').useDefaultCalendar,true);
});
test('custom destination supports connected accounts without a default and refuses stale settings after Google I/O',async()=>{
 const {ledger,settings}=setup();ledger.putAccount({...ledger.account('google-one'),destinationCalendarId:''});ledger.access=async()=> 'mock';ledger.google={listCalendars:async()=>[{id:'custom',accessRole:'owner'}]};const type={...ledger.settings().meetingTypes[0],useDefaultCalendar:false,calendarId:'custom'};let review=await settings.preview({meetingTypes:[type]});await settings.apply(review.patch,review.revision);assert.equal(ledger.destination(ledger.type('intro')).calendarId,'custom');
 const before=await settings.read();ledger.google.listCalendars=async()=>{ledger.saveSettings({profile:{company:'Concurrent edit'}});return [{id:'changed',accessRole:'writer'}];};await assert.rejects(()=>settings.apply({meetingTypes:[{...type,calendarId:'changed'}]},before.revision),e=>e.code==='settings_conflict');assert.equal(ledger.type('intro').calendarId,'custom');
 ledger.putAccount({...ledger.account('google-one'),connected:false});await assert.rejects(()=>settings.preview({meetingTypes:[{...type,calendarId:'changed'}]}),/connected/);
});

test('motion preference persists and older clients do not reset it',async()=>{
 const {settings}=setup(),before=await settings.read();
 const patch={meetingTypes:before.meetingTypes.map(t=>({...t,motion:'none'}))};
 const saved=await settings.apply(patch,before.revision);
 assert.equal(saved.settings.meetingTypes[0].motion,'none');
 const legacy={meetingTypes:saved.settings.meetingTypes.map(({motion,...t})=>({...t,title:'Updated through an older client'}))};
 const updated=await settings.apply(legacy,saved.revision);
 assert.equal(updated.settings.meetingTypes[0].motion,'none');
 for(const motion of [null,true,'slow','<script>'])assert.throws(()=>normalizeSettingsPatch(updated.settings,{meetingTypes:updated.settings.meetingTypes.map(t=>({...t,motion}))}),/transitions/);
});

test('profile branding is revision checked, survives legacy profile edits and can be removed',async()=>{
 const {readFileSync}=await import('node:fs');const image=kind=>'data:image/jpeg;base64,'+readFileSync(new URL('./fixtures/'+kind+'.jpg',import.meta.url)).toString('base64');
 const {settings}=setup(),before=await settings.read(),saved=await settings.apply({profile:{avatarImage:image('avatar'),bannerImage:image('banner')}},before.revision);
 assert.equal(saved.settings.profile.avatarImage,image('avatar'));assert.equal(saved.settings.profile.bannerImage,image('banner'));
 await assert.rejects(()=>settings.apply({profile:{avatarImage:null}},before.revision),error=>error.code==='settings_conflict');
 const renamed=await settings.apply({profile:{name:'New name'}},saved.revision);assert.equal(renamed.settings.profile.avatarImage,image('avatar'));
 const removed=await settings.apply({profile:{avatarImage:null,bannerImage:null}},renamed.revision);assert.equal(removed.settings.profile.avatarImage,null);assert.equal(removed.settings.profile.bannerImage,null);
});
