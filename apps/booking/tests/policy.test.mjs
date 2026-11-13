import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT, slots, validateConfig, dateKey, reminderOffsets, normalizeAvailabilitySchedules, resolveAvailabilitySchedule } from '../public/policy.js';
test('working hours follow host timezone across DST, not the guest or server zone',()=>{
  const c={...DEFAULT,zone:'America/New_York',notice:0,horizon:4,startHour:9,endHour:10,duration:30,days:[0,1,2,3,4,5,6]};
  const result=slots(c,Date.parse('2026-03-07T00:00:00Z'));
  assert(result.some(s=>new Date(s.start).toISOString()==='2026-03-07T14:00:00.000Z'));
  assert(result.some(s=>new Date(s.start).toISOString()==='2026-03-08T13:00:00.000Z'));
  for(const s of result)assert.equal(new Intl.DateTimeFormat('en',{timeZone:c.zone,hour:'numeric',hourCycle:'h23'}).format(s.start),'09');
});
test('buffer blocks overlapping starts and permits exact boundary',()=>{
  const now=Date.parse('2026-11-10T00:00:00Z'),start=Date.parse('2026-11-10T09:00:00Z');
  const result=slots({...DEFAULT,zone:'UTC',notice:0,horizon:1},now,[{start,end:start+30*60000}]);
  assert(!result.some(s=>s.start===start+30*60000));
  assert(result.some(s=>s.start===start+45*60000));
});
test('notice, lunch break and selected weekdays are enforced',()=>{
  const now=Date.parse('2026-11-10T10:00:00Z');const c={...DEFAULT,zone:'UTC',horizon:1,days:[2]};
  const result=slots(c,now);assert(result.length);assert(result.every(s=>s.start>=now+120*60000));
  assert(result.every(s=>new Date(s.start).getUTCHours()>=13));
});
test('invalid policy fails instead of producing unbounded availability',()=>{
  for(const c of [{days:[]},{duration:-1},{zone:'not/a-zone'},{endHour:8},{horizon:1000},{required:'yes'}])assert.throws(()=>validateConfig({...DEFAULT,...c}));
  assert.equal(validateConfig({...DEFAULT,unexpected:'secret'}).unexpected,undefined);
});
test('calendar dates preserve non-hour-offset zones',()=>assert.equal(dateKey(Date.parse('2026-11-10T20:00:00Z'),'Asia/Kathmandu'),'2026-11-11'));
test('reminder timing is bounded and canonical, with legacy defaults and an explicit off switch',()=>{
 assert.equal(validateConfig(DEFAULT).reminderMinutes,null);assert.deepEqual(reminderOffsets(DEFAULT),[1440]);assert.deepEqual(reminderOffsets({...DEFAULT,reminder:false}),[]);
 assert.deepEqual(validateConfig({...DEFAULT,reminderMinutes:[5,10080,60]}).reminderMinutes,[10080,60,5]);
 assert.deepEqual(reminderOffsets({...DEFAULT,reminderMinutes:[]}),[]);assert.deepEqual(reminderOffsets({...DEFAULT,reminder:false,reminderMinutes:[60,5]}),[]);
 for(const value of [false,'60',{},[1],[10081],[5.5],[5,5],[5,10,15,20],[5,'60']])assert.throws(()=>validateConfig({...DEFAULT,reminderMinutes:value}));
});
test('weekly split ranges use minute-precise opening anchors and never bridge a break',async()=>{
 const {policySlots,hoursFor}=await import('../public/policy.js');
 const c=validateConfig({...DEFAULT,zone:'UTC',notice:0,horizon:1,duration:30,weeklyHours:{2:[{start:550,end:650},{start:780,end:900}]}});
 const result=policySlots(c,Date.parse('2026-11-10T00:00:00Z'));
 assert.deepEqual(result.slice(0,3).map(slot=>new Date(slot.start).toISOString().slice(11,16)),['09:10','09:25','09:40']);
 assert.ok(result.every(slot=>{const minute=new Date(slot.start).getUTCHours()*60+new Date(slot.start).getUTCMinutes();return minute>=550&&minute+30<=650||minute>=780&&minute+30<=900;}));
 assert.deepEqual(hoursFor(c,'2026-11-09',1),[]);
 assert.deepEqual(hoursFor({...DEFAULT},'2026-11-10',2),[{start:540,end:1020}]);
});
test('date overrides replace weekly hours, including closed dates and otherwise closed weekdays',async()=>{
 const {policySlots}=await import('../public/policy.js');
 const c=validateConfig({...DEFAULT,zone:'UTC',notice:0,horizon:3,weeklyHours:{2:[{start:540,end:1020}]},dateOverrides:{'2026-11-10':[],'2026-11-11':[{start:605,end:665}]}});
 const result=policySlots(c,Date.parse('2026-11-10T00:00:00Z'));
 assert.deepEqual(result.map(slot=>new Date(slot.start).toISOString()),['2026-11-11T10:05:00.000Z','2026-11-11T10:20:00.000Z','2026-11-11T10:35:00.000Z']);
 assert.deepEqual(validateConfig({...DEFAULT,days:[],weeklyHours:{}}).weeklyHours['0'],[]);
});
test('availability ranges and overrides reject malformed, overlapping or unbounded input',()=>{
 for(const patch of [
  {weeklyHours:{7:[]}}, {weeklyHours:[]}, {weeklyHours:{1:[{start:600,end:600}]}},
  {weeklyHours:{1:[{start:600.5,end:700}]}}, {weeklyHours:{1:[{start:0,end:1441}]}},
  {weeklyHours:{1:[{start:600,end:700},{start:690,end:800}]}},
  {weeklyHours:{1:Array.from({length:4},(_,i)=>({start:i*60,end:i*60+30}))}},
  {dateOverrides:{'2026-02-30':[]}}, {dateOverrides:[]},
  {dateOverrides:Object.fromEntries(Array.from({length:61},(_,i)=>[new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10),[]]))},
  {dailyBookingLimit:51},{dailyBookingLimit:-1},{dailyBookingLimit:1.5},{zone:'+01:00'}
 ])assert.throws(()=>validateConfig({...DEFAULT,...patch}),JSON.stringify(patch));
 const c=validateConfig({...DEFAULT,weeklyHours:{1:[{start:780,end:900},{start:540,end:720}]},dailyBookingLimit:4});
 assert.deepEqual(c.weeklyHours[1],[{start:540,end:720},{start:780,end:900}]);
});
test('range-anchored slots preserve repeated DST times and validate the entire meeting across clock changes',async()=>{
 const {policySlots}=await import('../public/policy.js');
 const spring=validateConfig({...DEFAULT,zone:'America/New_York',notice:0,horizon:1,duration:60,weeklyHours:{0:[{start:90,end:210}]}});
 const a=policySlots(spring,Date.parse('2026-03-08T05:00:00Z'));
 assert.ok(a.some(slot=>slot.start===Date.parse('2026-03-08T06:30:00Z')&&slot.end===Date.parse('2026-03-08T07:30:00Z')));
 const fall=validateConfig({...DEFAULT,zone:'America/New_York',notice:0,horizon:1,duration:30,weeklyHours:{0:[{start:60,end:120}]}});
 const b=policySlots(fall,Date.parse('2026-11-01T04:00:00Z'));
 assert.ok(b.some(slot=>slot.start===Date.parse('2026-11-01T05:00:00Z')));
 assert.ok(b.some(slot=>slot.start===Date.parse('2026-11-01T06:00:00Z')));
 const short=validateConfig({...fall,duration:60,weeklyHours:{0:[{start:60,end:105}]}});
 assert.equal(policySlots(short,Date.parse('2026-11-01T04:00:00Z')).length,0);
});
test('minute-anchored availability uses the host date in non-hour-offset zones and bounds raw callers',async()=>{
 const {policySlots}=await import('../public/policy.js');
 const c=validateConfig({...DEFAULT,zone:'Asia/Kathmandu',notice:0,horizon:1,weeklyHours:{2:[{start:550,end:610}]}});
 assert.equal(new Date(policySlots(c,Date.parse('2026-11-10T00:00:00Z'))[0].start).toISOString(),'2026-11-10T03:25:00.000Z');
 assert.throws(()=>policySlots({...DEFAULT,horizon:999999},Date.now()));
});
test('independent buffer sides inherit legacy symmetric gaps and retain exact boundaries',async()=>{
 const {buffersFor}=await import('../public/policy.js');const now=Date.parse('2026-11-10T00:00:00Z'),meeting=Date.parse('2026-11-10T09:00:00Z'),base={...DEFAULT,zone:'UTC',notice:0,horizon:1};
 assert.deepEqual(buffersFor(validateConfig(base)),{before:900000,after:900000});assert.deepEqual(buffersFor(validateConfig({...base,bufferBefore:0})),{before:0,after:900000});
 const booking={start:meeting,end:meeting+30*60000};const beforeOnly=slots({...base,bufferBefore:30,bufferAfter:0},now,[booking]);assert.ok(!beforeOnly.some(s=>s.start===meeting+45*60000));assert.ok(beforeOnly.some(s=>s.start===meeting+60*60000));
 const afterOnly=slots({...base,bufferBefore:0,bufferAfter:30},now,[booking]);assert.ok(afterOnly.some(s=>s.start===meeting+30*60000));
 const future={start:meeting+60*60000,end:meeting+90*60000};assert.ok(slots({...base,bufferBefore:0,bufferAfter:30},now,[future]).some(s=>s.start===meeting));assert.ok(!slots({...base,bufferBefore:0,bufferAfter:30},now,[future]).some(s=>s.start===meeting+15*60000));
 const stored={...booking,after:30*60000,before:0};assert.ok(slots({...base,bufferBefore:30,bufferAfter:0},now,[stored]).some(s=>s.start===meeting+60*60000));
});
test('configurable start intervals anchor to each working range without shifting minute-precise hours',async()=>{
 const {policySlots}=await import('../public/policy.js'),now=Date.parse('2026-11-10T00:00:00Z');
 for(const interval of [5,10,15,20,30,45,60]){const c={...DEFAULT,zone:'UTC',notice:0,horizon:1,duration:15,slotInterval:interval,weeklyHours:{2:[{start:550,end:670}]}};const result=policySlots(c,now);assert.equal(new Date(result[0].start).toISOString().slice(11,16),'09:10');for(const slot of result)assert.equal((slot.start-now)/60000%1440-550>=0,true);for(let i=1;i<result.length;i++)assert.equal(result[i].start-result[i-1].start,interval*60000);}
 const c={...DEFAULT,zone:'Asia/Kathmandu',notice:0,horizon:1,slotInterval:20,weeklyHours:{2:[{start:550,end:630}]}};assert.equal(new Date(policySlots(c,now)[0].start).toISOString(),'2026-11-10T03:25:00.000Z');
});
test('hourly start intervals preserve both occurrences of repeated DST hours',async()=>{
 const {policySlots}=await import('../public/policy.js');const result=policySlots({...DEFAULT,zone:'America/New_York',notice:0,horizon:1,duration:30,slotInterval:60,weeklyHours:{0:[{start:60,end:120}]}},Date.parse('2026-11-01T04:00:00Z'));
 assert.ok(result.some(s=>s.start===Date.parse('2026-11-01T05:00:00Z')));assert.ok(result.some(s=>s.start===Date.parse('2026-11-01T06:00:00Z')));
});
test('buffer, interval, weekly cap and generated location controls are bounded and legacy-safe',()=>{
 const c=validateConfig(DEFAULT);assert.equal(c.locationType,'custom');assert.equal(c.weeklyBookingLimit,0);assert.equal(c.slotInterval,15);assert.equal(c.bufferBefore,null);assert.equal(c.bufferAfter,null);
 assert.equal(validateConfig({...DEFAULT,locationType:'google_meet',weeklyBookingLimit:250}).weeklyBookingLimit,250);
 for(const patch of [{bufferBefore:-1},{bufferAfter:61},{bufferBefore:'15'},{slotInterval:7},{slotInterval:0},{weeklyBookingLimit:251},{weeklyBookingLimit:1.5},{locationType:'https://evil.example'}])assert.throws(()=>validateConfig({...DEFAULT,...patch}),JSON.stringify(patch));
});

test('named availability schedules validate bounded host-owned definitions and resolve only hours',()=>{
 const schedule={id:'work',name:' Work ',zone:'America/New_York',weeklyHours:{1:[{start:780,end:900},{start:540,end:720}]},dateOverrides:{'2026-12-25':[]}};
 const normalized=normalizeAvailabilitySchedules([schedule]);assert.equal(normalized[0].name,'Work');assert.deepEqual(normalized[0].weeklyHours[1],[{start:540,end:720},{start:780,end:900}]);assert.deepEqual(normalized[0].weeklyHours[0],[]);
 const resolved=resolveAvailabilitySchedule({...DEFAULT,scheduleId:'work',duration:45,notice:60,reminderMinutes:[5]},normalized);assert.equal(resolved.zone,'America/New_York');assert.equal(resolved.duration,45);assert.equal(resolved.notice,60);assert.deepEqual(resolved.reminderMinutes,[5]);assert.deepEqual(resolved.dateOverrides,{'2026-12-25':[]});assert.deepEqual(resolveAvailabilitySchedule(DEFAULT),validateConfig(DEFAULT));
 for(const value of [null,{},Array.from({length:21},(_,i)=>({...schedule,id:'s'+i})),[schedule,schedule],[{...schedule,id:'bad/id'}],[{...schedule,name:' '}],[{...schedule,name:'x'.repeat(81)}],[{...schedule,zone:'bad'}],[{...schedule,weeklyHours:null}],[{...schedule,weeklyHours:{8:[]}}],[{...schedule,dateOverrides:{'2026-02-30':[]}}],[{...schedule,hostId:'foreign'}]])assert.throws(()=>normalizeAvailabilitySchedules(value));
 assert.throws(()=>resolveAvailabilitySchedule({...DEFAULT,scheduleId:'foreign'},normalized));assert.throws(()=>validateConfig({...DEFAULT,scheduleId:''}));
});

test('default schedule inheritance is explicit and never silently falls back when missing',()=>{
 const schedules=normalizeAvailabilitySchedules([{id:'default',name:'Default',zone:'Europe/Oslo',weeklyHours:{1:[{start:540,end:720}]},dateOverrides:{}},{id:'explicit',name:'Explicit',zone:'America/New_York',weeklyHours:{2:[{start:780,end:900}]},dateOverrides:{}}]);
 const raw={...DEFAULT,scheduleId:'explicit',zone:'Pacific/Honolulu',weeklyHours:{3:[{start:600,end:660}]},bufferBefore:25,dailyBookingLimit:2};
 assert.equal(validateConfig({...raw,useDefaultSchedule:undefined}).useDefaultSchedule,false);assert.equal(resolveAvailabilitySchedule(raw,schedules,'default').zone,'America/New_York');
 const inherited=resolveAvailabilitySchedule({...raw,useDefaultSchedule:true},schedules,'default');assert.equal(inherited.zone,'Europe/Oslo');assert.equal(inherited.scheduleId,'explicit');assert.equal(inherited.useDefaultSchedule,true);assert.equal(inherited.bufferBefore,25);assert.equal(inherited.dailyBookingLimit,2);assert.deepEqual(raw.weeklyHours,{3:[{start:600,end:660}]});
 for(const id of [null,'missing'])assert.throws(()=>resolveAvailabilitySchedule({...raw,useDefaultSchedule:true},schedules,id));
 for(const flag of [null,'true',1,{}])assert.throws(()=>validateConfig({...raw,useDefaultSchedule:flag}));
 assert.throws(()=>resolveAvailabilitySchedule({...raw,useDefaultSchedule:true,scheduleId:'deleted-fallback'},schedules,'default'));
});

test('booked-minute caps are opt-in integer five-minute limits with strict null rejection',()=>{
 assert.equal(validateConfig({}).dailyBookedMinutesLimit,0);assert.equal(validateConfig({}).weeklyBookedMinutesLimit,0);
 for(const key of ['dailyBookedMinutesLimit','weeklyBookedMinutesLimit']){for(const value of [null,'30',true,-5,1,7,5.5,Infinity])assert.throws(()=>validateConfig({...DEFAULT,[key]:value}));assert.equal(validateConfig({...DEFAULT,[key]:0})[key],0);}
 assert.equal(validateConfig({...DEFAULT,dailyBookedMinutesLimit:1440,weeklyBookedMinutesLimit:10080}).weeklyBookedMinutesLimit,10080);assert.throws(()=>validateConfig({...DEFAULT,dailyBookedMinutesLimit:1445}));assert.throws(()=>validateConfig({...DEFAULT,weeklyBookedMinutesLimit:10085}));
});

test('monthly/yearly count and minute caps are strict bounded integers with zero off',()=>{
 for(const [key,max,step] of [['monthlyBookingLimit',1500,1],['yearlyBookingLimit',18000,1],['monthlyBookedMinutesLimit',44640,5],['yearlyBookedMinutesLimit',527040,5]]){
  for(const value of [0,step,max])assert.equal(validateConfig({...DEFAULT,[key]:value})[key],value);
  for(const value of [null,-1,1.5,String(step),max+step,...(step===5?[1]:[])])assert.throws(()=>validateConfig({...DEFAULT,[key]:value}),key+' '+value);
 }
});
