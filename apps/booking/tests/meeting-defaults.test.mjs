import test from 'node:test';
import assert from 'node:assert/strict';
import {newMeeting,meetingSlug} from '../public/meeting-defaults.js';
import {DEFAULT} from '../public/policy.js';
test('new links inherit identity, calendar, regular hours and appearance without copying per-link email or intake',()=>{
 const settings={profile:{name:'Riley',company:'Globex'},accounts:[{id:'a',connected:true,destinationCalendarId:'primary'}],meetingTypes:[{...DEFAULT,id:'intro',accountId:'a',duration:45,zone:'Europe/Oslo',weeklyHours:{1:[{start:600,end:900}]},accent:'sage',location:'Video call',questions:[{id:'q',label:'Private'}],dateOverrides:{'2026-12-24':[]},reminder:true,followUpMinutes:60}]};
 const draft=newMeeting(settings,[],'America/New_York','new');assert.equal(draft.host,'Riley');assert.equal(draft.company,'Globex');assert.equal(draft.accountId,'a');assert.equal(draft.zone,'Europe/Oslo');assert.equal(draft.locationType,'google_meet');assert.equal(draft.duration,45);assert.equal(draft.accent,'sage');assert.deepEqual(draft.weeklyHours,settings.meetingTypes[0].weeklyHours);assert.notEqual(draft.weeklyHours,settings.meetingTypes[0].weeklyHours);assert.deepEqual(draft.dateOverrides,{});assert.deepEqual(draft.questions,[]);assert.equal(draft.followUpMinutes,null);assert.equal(draft.reminder,false);assert.equal(draft.published,false);
});
test('new links follow the selected default schedule and readable slugs avoid collisions',()=>{
 const settings={profile:{name:'Globex'},accounts:[],meetingTypes:[{...DEFAULT,id:'old',slug:'30-minute-meeting'}],availabilitySchedules:[{id:'work',zone:'Europe/Oslo'}],defaultAvailabilityScheduleId:'work'};
 const draft=newMeeting(settings,[],'UTC','new');assert.equal(draft.useDefaultSchedule,true);assert.equal(draft.zone,'Europe/Oslo');assert.equal(draft.slug,'30-minute-meeting-2');assert.equal(meetingSlug('Quick intro',settings.meetingTypes),'quick-intro');assert.equal(draft.accountId,'');assert.equal(draft.locationType,'custom');
});
