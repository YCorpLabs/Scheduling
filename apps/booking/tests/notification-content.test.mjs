import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingNotificationContent as content } from '../src/notification-content.js';
import { sendNotification } from '../src/notifications.js';
const booking = {title:'Design review',name:'Alex',email:'alex@example.com',start:Date.UTC(2026,10,12,10),end:Date.UTC(2026,10,12,10,30),timeZone:'Europe/Oslo',approvalExpiresAt:Date.UTC(2026,10,11,10)};
const args = {booking,link:'https://meet.example.com/manage/host/id#secret',hostName:'Sam'};
test('approval acknowledgement states pending status, exact local deadline and invitation boundary',()=>{
 const mail=content({...args,kind:'approval_requested_guest'});
 assert.match(mail.subject,/Request received/);assert.match(mail.text,/not confirmed/);assert.match(mail.text,/Wed, 11 Nov 2026, 11:00/);assert.match(mail.text,/Thu, 12 Nov 2026, 11:00/);assert.match(mail.text,/Europe\/Oslo/);assert.match(mail.text,/If approved/);
});
test('host request identifies the guest and uses the authenticated review link',()=>{
 const mail=content({...args,kind:'approval_requested_host',link:'https://meet.example.com/setup#booking=id'});
 assert.match(mail.text,/Alex \(alex@example.com\)/);assert.match(mail.text,/no calendar invitation/);assert.match(mail.html,/>Review request<\/a>/);assert.ok(!mail.text.includes('secret'));
});
test('terminal outcomes are distinct and never imply a confirmed invitation',()=>{
 for(const kind of ['rejected','expired']){const mail=content({...args,kind});assert.match(mail.subject,kind==='rejected'?/declined/:/expired/);assert.match(mail.text,/No calendar invitation|no calendar invitation/);assert.ok(!mail.text.includes('Your meeting is confirmed'));}
 assert.match(content({...args,kind:'expired'}).text,/no longer held/);
});
test('untrusted values are escaped, header controls removed, subjects byte bounded',async()=>{
 const mail=content({...args,kind:'rejected',booking:{...booking,title:'😀'.repeat(160)+'\r\nBcc: x',rejectionReason:'<img src=x onerror=alert(1)>'}});
 assert.ok(Buffer.byteLength(mail.subject)<=512);assert.ok(!/[\r\n]/.test(mail.subject));assert.ok(!mail.html.includes('<img'));assert.match(mail.html,/&lt;img/);
 await sendNotification({RESEND_API_KEY:'test',MAIL_FROM:'mail@example.com'},{...mail,to:'guest@example.com',idempotencyKey:'test/one'},{fetchImpl:async()=>Response.json({id:'test'})});
});
test('unsafe links and invalid times fail closed; legacy invalid zones fall back to UTC',()=>{
 for(const link of ['javascript:alert(1)','https://user:pass@example.com','http://example.com'])assert.throws(()=>content({...args,kind:'confirmed',link}));
 assert.throws(()=>content({...args,kind:'unknown'}));assert.throws(()=>content({...args,kind:'confirmed',booking:{...booking,start:NaN}}));
 assert.match(content({...args,kind:'confirmed',booking:{...booking,timeZone:'invalid'}}).text,/\(UTC\)/);
});
test('all lifecycle messages provide plaintext and accessible self-contained HTML without remote assets',()=>{
 for(const kind of ['approval_requested_host','approval_requested_guest','confirmed','cancelled','reminder','rejected','expired']){const mail=content({...args,kind});assert.match(mail.html,/<html lang="en">/);assert.match(mail.text,/https:\/\/meet.example.com/);assert.ok(!/<img|<script|<link|@import/.test(mail.html));assert.match(mail.html,/<a href=/);}
});
