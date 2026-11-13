import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsMarkup,canRepair,attentionCount,formatAge} from '../public/operations-ui.js';

const base={schemaVersion:1,generatedAt:Date.UTC(2026,10,11,9),healthy:true,issues:[],bookings:{awaitingApproval:0,pending:{count:0},cancelling:{count:0},failedLast7Days:{count:0}},calendarSync:{tracked:3,overdue:0},accounts:{connected:1,disconnected:0,coolingDown:0},deliveries:{queued:2,truncated:false,review:{count:0,items:[]}},outbound:{frozen:false,epoch:4,reason:null,inFlight:{calendar:0,deliveries:0}},maintenance:{nextAlarmAt:null,lastAlarm:{state:'completed',startedAt:1,finishedAt:2}},attention:[]};

test('healthy status renders a calm summary and no maintenance action',()=>{
  const html=operationsMarkup(base,{formatTime:()=>'T'});
  assert.match(html,/Nothing needs attention/);
  assert.doesNotMatch(html,/ops-repair/);
  assert.equal(attentionCount(base),0);
});

test('issues escape server text and only repairable, unfrozen states offer maintenance',()=>{
  const status={...base,healthy:false,issues:[{code:'pending_stale',severity:'warning',count:2,message:'<b>x</b>',action:'Run repair.'},{code:'booking_failed',severity:'info',count:1,message:'m',action:'a'}]};
  const html=operationsMarkup(status);
  assert.match(html,/&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html,/1 issue needs attention/);
  assert.ok(canRepair(status));
  assert.ok(!canRepair({...status,outbound:{...status.outbound,frozen:true}}));
  assert.ok(!canRepair({...base,issues:[{code:'delivery_review',severity:'critical'}]}),'parked email review must not offer a run that could look like a resend');
});

test('frozen state is explained without a resume control and parked emails cannot be released here',()=>{
  const status={...base,outbound:{frozen:true,epoch:5,reason:'restore_detected',changedAt:3,inFlight:{calendar:1,deliveries:0}},deliveries:{queued:1,review:{count:1,items:[{jobId:'b1:1:confirmed',bookingId:'b1',kind:'confirmed',recipientRole:'guest',reason:'restored',provider:'cloudflare',attempts:0,firstAttemptAt:null,updatedAt:9,releasable:true,resolvable:true}]}}};
  const html=operationsMarkup(status,{formatTime:()=>'T'});
  assert.match(html,/Paused for maintenance/);
  assert.match(html,/Restore detected/);
  assert.match(html,/1 provider call in flight/);
  assert.doesNotMatch(html,/resume|release/i);
  assert.match(html,/Quarantined after restore/);
  assert.match(html,/data-ops-resolve="0"/);
});

test('an item being processed cannot be resolved',()=>{
  const status={...base,deliveries:{queued:1,review:{count:1,items:[{jobId:'j',bookingId:'b',kind:'reminder',recipientRole:'host',reason:'timeout',attempts:1,updatedAt:1,resolvable:false}]}}};
  assert.match(operationsMarkup(status),/data-ops-resolve="0" disabled>Processing/);
});

test('missing status reports loading or error states',()=>{
  assert.match(operationsMarkup(null,{loading:true}),/Checking status/);
  assert.match(operationsMarkup(null,{error:'Sign in again.'}),/role="alert">Sign in again\./);
  assert.equal(formatAge(90*60000),'2 h');
  assert.equal(formatAge(3*86400000),'3 d');
});
