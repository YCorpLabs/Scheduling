import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFollowUp,followUpContent} from '../public/followup.js';
import {validateConfig,DEFAULT} from '../public/policy.js';
import {bookingNotificationContent} from '../src/notification-content.js';
test('follow-up opt-in is bounded and templates reject unsupported tokens and headers',()=>{
 assert.deepEqual(normalizeFollowUp(),{followUpMinutes:null,followUpSubject:'',followUpBody:''});assert.equal(validateConfig(DEFAULT).followUpMinutes,null);
 for(const followUpMinutes of [0,4,10081,5.5,'5',false])assert.throws(()=>normalizeFollowUp({followUpMinutes}));
 for(const c of [{followUpSubject:null},{followUpBody:null},{followUpSubject:'Hello\nBcc: bad'},{followUpSubject:'x'.repeat(161)},{followUpBody:'x'.repeat(4001)},{followUpBody:'Hi {email}'},{followUpBody:'unclosed {'},{followUpBody:'bad }'}])assert.throws(()=>normalizeFollowUp(c));
 assert.equal(normalizeFollowUp({followUpMinutes:10080}).followUpMinutes,10080);
});
test('follow-up preview matches server rendering and escapes values without claiming attendance',()=>{
 const config={followUpMinutes:5,followUpSubject:'Hi {guest_name}',followUpBody:'Hi {guest_name}\nAbout {meeting_title}\nFrom {host_name}'},values={guest_name:'<Alex>',meeting_title:'Review & plan',host_name:'Sam'},preview=followUpContent(config,values),booking={title:values.meeting_title,name:values.guest_name,start:Date.UTC(2026,10,12,10),end:Date.UTC(2026,10,12,10,30),config};
 const rendered=bookingNotificationContent({booking,kind:'follow_up',hostName:'Sam',link:'https://example.test/manage/id#secret'});assert.equal(rendered.subject,preview.subject);assert.ok(rendered.text.includes(preview.body));assert.ok(rendered.html.includes('&lt;Alex&gt;'));assert.ok(rendered.html.includes('Review &amp; plan<br>From Sam'));assert.ok(!rendered.html.includes('<Alex>'));assert.ok(!/attended|joining/.test(followUpContent({},values).body));
});
