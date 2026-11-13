import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DEFAULT} from '../public/policy.js';
import {durationLabel,guestDurations,durationSummary,durationDefaultMarkup,durationOptionsMarkup,readDurations,guestDurationMarkup} from '../public/durations-ui.js';
import {projectPreviewState} from '../public/share-ui.js';
import {draftPreview} from '../public/preview-policy.js';
import {newMeeting} from '../public/meeting-defaults.js';

// Minimal form double: readDurations only reads the default field and checked, enabled chips.
function form(duration,checked=[],{editor=true}={}){
 const chips=checked.map(v=>({value:String(v)}));
 const editorNode={querySelectorAll:selector=>{assert.equal(selector,'input[name=durationOption]:checked:not(:disabled)');return chips;}};
 return {elements:{duration:{value:String(duration)}},querySelector:selector=>selector==='[data-duration-editor]'&&editor?editorNode:null};
}

test('labels are compact and exact for custom lengths',()=>{
 assert.equal(durationLabel(5),'5 min');assert.equal(durationLabel(60),'1 hr');assert.equal(durationLabel(95),'1 hr 35 min');assert.equal(durationLabel(480),'8 hr');
});

test('guest lengths never throw and keep the shared contract order',()=>{
 assert.deepEqual(guestDurations({duration:37,durationOptions:null}),[37]);
 assert.deepEqual(guestDurations({duration:30,durationOptions:[60,30,17]}),[60,30,17]);
 assert.deepEqual(guestDurations({duration:30,durationOptions:[60,45]}),[30],'default must be present, otherwise fixed');
 assert.deepEqual(guestDurations({duration:3}),[]);
 assert.equal(durationSummary({duration:30,durationOptions:[60,30,15]}),'15 min · 30 min · 1 hr');
 assert.equal(durationSummary({duration:30,durationOptions:null}),'30 min');
});

test('host read: default only stays legacy fixed; choices include default, sorted, max four',()=>{
 assert.deepEqual(readDurations(form(37)),{duration:37,durationOptions:null});
 assert.deepEqual(readDurations(form(30,[60,15])),{duration:30,durationOptions:[15,30,60]});
 assert.deepEqual(readDurations(form(30,[30,60])),{duration:30,durationOptions:[30,60]},'checked default is not duplicated');
 assert.throws(()=>readDurations(form(30,[15,45,60,90])),/up to four/);
 for(const bad of ['4','481','30.5','','abc','1e2'])assert.throws(()=>readDurations(form(bad)),/between 5 and 480/);
 assert.deepEqual(readDurations(form(45,[],{editor:false})),{duration:45},'without the editor existing choices are left to the saved link');
});

test('host markup: custom default field and chips with default locked and limit enforced',()=>{
 const field=durationDefaultMarkup({duration:37});assert.match(field,/id="edit-duration" name="duration" type="number"[^>]*min="5" max="480"[^>]*value="37"/);
 const chips=durationOptionsMarkup({duration:30,durationOptions:[15,30,60,90]});
 assert.match(chips,/value="30" checked disabled/);
 for(const v of [15,60,90])assert.match(chips,new RegExp(`value="${v}" checked >`));
 assert.match(chips,/value="45"  disabled/,'a fifth length cannot be selected');
 assert.match(durationOptionsMarkup({duration:37}),/value="37" checked disabled/,'custom default appears as a chip');
 assert.doesNotMatch(durationOptionsMarkup({duration:30}),/value="45"  disabled/);
});

test('guest chooser only for more than one length; accessible radios with busy state',()=>{
 assert.equal(guestDurationMarkup({duration:30,durationOptions:null}),'');
 const html=guestDurationMarkup({duration:30,durationOptions:[15,30,60]},{selected:60,busy:true});
 assert.match(html,/<fieldset class="guest-durations" aria-busy="true"><legend class="sr-only">Meeting length<\/legend>/);
 assert.match(html,/id="guest-duration-60" value="60" checked/);assert.doesNotMatch(html,/value="30" checked/);
 assert.equal((html.match(/type="radio" name="guest-duration"/g)||[]).length,3);
});

test('preview projection whitelists valid duration choices and drops malformed ones',()=>{
 const base={config:{...DEFAULT,zone:'UTC',questions:[],duration:30,durationOptions:[30,60],accountId:'private',revision:'r1'},slots:[]};
 assert.deepEqual(projectPreviewState(base).config.durationOptions,[30,60]);
 for(const bad of [[60,90],[30,30],[30,'60'],[30,15,45,60,90],'30,60',[30]])assert.equal(projectPreviewState({...base,config:{...base.config,durationOptions:bad}}).config.durationOptions,null);
 assert.throws(()=>projectPreviewState({...base,config:{...base.config,duration:600}}));
 const serialized=JSON.stringify(projectPreviewState(base));assert.ok(!serialized.includes('private')&&!serialized.includes('r1'));
});

test('draft preview overlays an allowed length locally and refuses others',()=>{
 const now=Date.parse('2026-11-12T00:00:00Z'),hours=Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,[{start:540,end:720}]]));
 const draft={...DEFAULT,zone:'UTC',notice:0,horizon:2,weeklyHours:hours,duration:30,durationOptions:[30,90]},settings={profile:{}};
 const fixed=draftPreview(settings,draft,now),long=draftPreview(settings,draft,now,90);
 assert.equal(fixed.config.duration,30);assert.deepEqual(fixed.config.durationOptions,[30,90]);
 assert.equal(long.config.duration,90);assert.ok(long.slots.length&&long.slots.every(s=>s.end-s.start===90*60000));
 assert.equal(projectPreviewState(long).slots.length,long.slots.length);
 assert.throws(()=>draftPreview(settings,draft,now,45));
 assert.throws(()=>draftPreview(settings,{...draft,durationOptions:null},now,90));
});

test('new links start fixed even when the source link offers choices',()=>{
 const settings={profile:{name:'T'},accounts:[{id:'a',connected:true,destinationCalendarId:'primary'}],meetingTypes:[{...DEFAULT,id:'x',accountId:'a',duration:45,durationOptions:[45,90]}]};
 const draft=newMeeting(settings,[],'UTC','n');assert.equal(draft.duration,45);assert.equal(draft.durationOptions,null);
});

test('guest and owner preview source keep the safety fences',()=>{
 const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),share=readFileSync(new URL('../public/share-ui.js',import.meta.url),'utf8');
 assert.match(app,/!originalBooking&&service\.mode==='live'\?\{duration:config\.duration\}/,'book carries the selected length, never for reschedule');
 assert.match(app,/path==='availability'&&!data&&!originalBooking&&length!=null/,'availability query never changes a reschedule');
 assert.match(app,/if\(seq!==durationSeq\)return;/,'stale availability replies are ignored');
 assert.match(app,/allAvailable=\[\];available=\[\];/,'old-length times are cleared while loading');
 assert.match(app,/ownerPreview\?requestPreviewDuration\(n,seq\):api\('availability'\)/,'owner preview never calls the API for a length change');
 assert.match(app,/e\.data\.request!==previewWaiter\.request\)return/,'unrequested preview replies are ignored');
 assert.match(app,/if\(ownerPreview\)throw Error\('Bookings are disabled in Preview\.'\)/);
 assert.match(share,/if\(closed\|\|frame!==target\|\|seq!==lengthSeq\)return/,'closed or replaced frames receive nothing');
 assert.match(share,/allowed\.includes\(duration\)/);
 assert.match(app,/path==='availability'&&!data&&originalBooking\)\{endpoint='\/api\/manage\/'\+publicRoute\[1\]\+'\/'\+originalBooking\.id;data=\{action:'availability',token:managementToken\}/,'reschedule availability is token-bound to the accepted booking');
});
