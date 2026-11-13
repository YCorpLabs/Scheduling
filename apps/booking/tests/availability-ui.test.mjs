import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {DEFAULT} from '../public/policy.js';
import {availabilityMinute,defaultAvailabilitySeed,availabilityPatch,availabilityUsage,availabilityMarkup} from '../public/availability-ui.js';
globalThis.crypto??=webcrypto;
const hours={1:[{start:540,end:1020}],2:[{start:600,end:900}]};
const schedule=(id,name=id)=>({id,name,zone:'Europe/Oslo',weeklyHours:structuredClone(hours),dateOverrides:{'2026-12-24':[]}});
const link=(id,extra={})=>({...DEFAULT,id,slug:id,title:id,...extra});
const settings=(extra={})=>({availabilitySchedules:[],defaultAvailabilityScheduleId:null,meetingTypes:[link('intro')],...extra});
const input=(extra={})=>({id:'work',name:'Work hours',zone:'Europe/Oslo',weeklyHours:structuredClone(hours),dateOverrides:{},makeDefault:true,linkIds:[],...extra});

test('availability seed chooses the default and never mutates a saved schedule',()=>{
 const saved=schedule('work'),value=settings({availabilitySchedules:[schedule('other'),saved],defaultAvailabilityScheduleId:'work'}),seed=defaultAvailabilitySeed(value,{id:'new',zone:'UTC'});
 assert.equal(seed.schedule.id,'work');assert.equal(seed.existing,true);seed.schedule.weeklyHours[1][0].start=1;assert.equal(saved.weeklyHours[1][0].start,540);
 const fresh=defaultAvailabilitySeed(value,{selectedId:'new',id:'new',zone:'UTC'});assert.equal(fresh.schedule.id,'new');assert.equal(fresh.existing,false);assert.equal(fresh.makeDefault,false);assert.equal(fresh.schedule.zone,'UTC');
});
test('the first hours start from configured regular hours, not a blank form',()=>{
 const seed=defaultAvailabilitySeed(settings({meetingTypes:[link('intro',{accountId:'a',zone:'America/New_York',weeklyHours:hours})]}),{id:'work',zone:'UTC'});
 assert.equal(seed.makeDefault,true);assert.equal(seed.schedule.zone,'America/New_York');assert.deepEqual(seed.schedule.weeklyHours,hours);assert.deepEqual(seed.schedule.dateOverrides,{});
});
test('creating default hours links only the explicitly reviewed booking links and preserves unknown policy',()=>{
 const team={mode:'any',hosts:[{id:'ada',name:'Ada',accountId:'a',scheduleId:'team-hours'}]},value=settings({meetingTypes:[link('intro',{teamScheduling:team}),link('custom',{weeklyHours:{3:[{start:600,end:700}]}})]}),before=structuredClone(value),patch=availabilityPatch(value,input({linkIds:['intro']}));
 assert.equal(patch.defaultAvailabilityScheduleId,'work');assert.equal(patch.meetingTypes[0].useDefaultSchedule,true);assert.equal(patch.meetingTypes[0].scheduleId,null);assert.deepEqual(patch.meetingTypes[0].teamScheduling,team);assert.deepEqual(patch.meetingTypes[1],value.meetingTypes[1]);assert.deepEqual(value,before);
});
test('replacing a default detaches unchecked followers with their previous effective hours',()=>{
 const old=schedule('old'),next=schedule('next'),value=settings({availabilitySchedules:[old,next],defaultAvailabilityScheduleId:'old',meetingTypes:[link('follows',{useDefaultSchedule:true}),link('stays',{useDefaultSchedule:true}),link('other',{scheduleId:'old',useDefaultSchedule:false})]});
 const patch=availabilityPatch(value,input({...next,makeDefault:true,linkIds:['follows']}));
 assert.equal(patch.defaultAvailabilityScheduleId,'next');assert.equal(patch.meetingTypes[0].useDefaultSchedule,true);assert.equal(patch.meetingTypes[1].useDefaultSchedule,false);assert.equal(patch.meetingTypes[1].scheduleId,null);assert.equal(patch.meetingTypes[1].zone,'Europe/Oslo');assert.deepEqual(patch.meetingTypes[1].dateOverrides,old.dateOverrides);assert.deepEqual(patch.meetingTypes[2],value.meetingTypes[2]);
});
test('unsetting a default converts checked links to an explicit schedule, without a dangling default',()=>{
 const value=settings({availabilitySchedules:[schedule('work')],defaultAvailabilityScheduleId:'work',meetingTypes:[link('intro',{useDefaultSchedule:true})]}),patch=availabilityPatch(value,input({makeDefault:false,linkIds:['intro']}));
 assert.equal(patch.defaultAvailabilityScheduleId,null);assert.equal(patch.meetingTypes[0].useDefaultSchedule,false);assert.equal(patch.meetingTypes[0].scheduleId,'work');
});
test('editing named hours without link changes keeps the booking array out of the patch',()=>{
 const value=settings({availabilitySchedules:[schedule('work')],defaultAvailabilityScheduleId:null,meetingTypes:[link('intro')]}),patch=availabilityPatch(value,input({makeDefault:false}));assert.equal('meetingTypes' in patch,false);assert.equal(patch.availabilitySchedules[0].id,'work');
});
test('invalid time ranges, dates, zones and unknown link IDs are rejected before a save',()=>{
 const value=settings();for(const bad of [input({zone:'nope'}),input({weeklyHours:{1:[{start:600,end:500}]}}),input({weeklyHours:{1:[{start:540,end:700},{start:600,end:800}]}}),input({dateOverrides:{'2026-02-30':[]}}),input({linkIds:['foreign']})])assert.throws(()=>availabilityPatch(value,bad));
 assert.equal(availabilityMinute('24:00'),1440);assert.equal(availabilityMinute('09:30'),570);for(const time of ['9:30','25:00','09:61','oops'])assert.throws(()=>availabilityMinute(time));
});
test('new schedules respect capacity while existing stable IDs remain editable',()=>{
 const value=settings({availabilitySchedules:Array.from({length:20},(_,index)=>schedule('s'+index))});assert.throws(()=>availabilityPatch(value,input()));assert.equal(availabilityPatch(value,input({id:'s0',makeDefault:false})).availabilitySchedules.length,20);
});
test('usage includes direct, default and team-host references',()=>{
 const value=settings({availabilitySchedules:[schedule('work')],defaultAvailabilityScheduleId:'work',meetingTypes:[link('direct',{scheduleId:'work'}),link('default',{useDefaultSchedule:true}),link('team',{teamScheduling:{mode:'any',hosts:[{id:'ada',name:'Ada',scheduleId:'work'},{id:'bo',name:'Bo',scheduleId:'other'}]}})]}),usage=availabilityUsage(value,'work');assert.deepEqual(usage.links.map(type=>type.id),['direct','default']);assert.deepEqual(usage.hosts,[{linkId:'team',hostId:'ada',name:'Ada'}]);
});
test('markup shows weekly controls and makes the actual link scope explicit',()=>{
 const value=settings({meetingTypes:[link('intro'),link('custom',{startHour:10})]}),html=availabilityMarkup(value,{id:'work',zone:'UTC'});
 assert.match(html,/Weekly hours/);assert.match(html,/Monday start 1/);assert.match(html,/Add Monday hours/);assert.match(html,/Copy Monday hours/);assert.match(html,/Date exceptions/);assert.match(html,/Default for new links/);assert.match(html,/value="intro" checked/);assert.doesNotMatch(html,/value="custom" checked/);assert.doesNotMatch(html,/sample|preview|parody|honestly|—/i);
});

test('a link-specific editor seed preserves its exact policy without adopting the profile default',()=>{const value=settings({availabilitySchedules:[schedule('default')],defaultAvailabilityScheduleId:'default',meetingTypes:[link('other'),link('target',{zone:'Asia/Kathmandu',weeklyHours:{2:[{start:557,end:1091}]},dateOverrides:{'2026-12-24':[]}})]});const seed=defaultAvailabilitySeed(value,{targetLinkId:'target',id:'new'});assert.equal(seed.existing,false);assert.equal(seed.makeDefault,false);assert.equal(seed.schedule.zone,'Asia/Kathmandu');assert.deepEqual(seed.schedule.weeklyHours,{2:[{start:557,end:1091}]});assert.deepEqual(seed.schedule.dateOverrides,{'2026-12-24':[]});assert.throws(()=>defaultAvailabilitySeed(value,{targetLinkId:'removed'}));});
