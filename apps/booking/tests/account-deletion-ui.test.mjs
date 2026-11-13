import test from 'node:test';
import assert from 'node:assert/strict';
import {deletionReceiptStore,deletionRequest,validateDeletionPreparation,validateDeletionStatus,createDeletionController,deletionMarkup,deletionStatusView} from '../public/account-deletion-ui.js';
const operationId='h_abcdefghijklmnopqrstuvwx.'+'d'.repeat(32),receipt='r'.repeat(43);
const prep=(extra={})=>({operationId,receipt,confirmationToken:'signed.confirmation',expiresAt:20000,canDelete:true,blockers:[],impact:{links:2,calendars:1,bookings:3},...extra});
const status=(state='fencing',extra={})=>({operationId,state,localDataDeleted:state==='deleted',providerRevocation:'not_requested',needsReview:state==='needs_review',requestedAt:10000,deleteBy:100000,...extra});
const tick=()=>new Promise(r=>setImmediate(r));
const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),values};};
function harness(replies,options={}){
 const calls=[],updates=[],timers=[],committed=[],storage=memory();let time=10000;
 const store=deletionReceiptStore(storage),controller=createDeletionController({request:async(action,data)=>{calls.push({action,data});const r=replies.shift();if(r instanceof Error)throw r;return typeof r==='function'?r(action,data):r;},store,now:()=>time,setTimer:fn=>{timers.push(fn);return fn;},clearTimer:fn=>{const i=timers.indexOf(fn);if(i>=0)timers.splice(i,1);},onUpdate:s=>updates.push(s),onCommitted:s=>committed.push(s),...options});
 return {controller,calls,updates,timers,committed,store,storage,setTime:n=>time=n};
}

test('confirmation is explicit and receipt is saved before the destructive request',async()=>{
 const h=harness([prep(),()=>{assert.deepEqual(h.store.read(),{operationId,receipt});return status();}]);
 await h.controller.prepare();assert.deepEqual(h.calls.map(c=>c.action),['prepare']);assert.equal(h.controller.state.canConfirm,true);assert.equal(h.store.read(),null);
 await h.controller.confirm();assert.deepEqual(h.calls[1],{action:'confirm',data:{confirmationToken:'signed.confirmation'}});assert.equal(h.controller.state.phase,'pending');assert.equal(h.committed.length,1);assert.equal(h.timers.length,1);
 h.controller.dispose();assert.equal(h.timers.length,0);
});

test('blockers and expired confirmation cannot send a delete request',async()=>{
 const blocked=harness([prep({canDelete:false,blockers:[{code:'owned_workspaces',label:'Transfer ownership of Acme first.'}]})]);await blocked.controller.prepare();await blocked.controller.confirm();assert.equal(blocked.controller.state.phase,'blocked');assert.equal(blocked.calls.length,1);
 const expired=harness([prep()]);await expired.controller.prepare();expired.setTime(20000);await expired.controller.confirm();assert.equal(expired.controller.state.phase,'expired');assert.equal(expired.calls.length,1);
});

test('lost confirmation reply is never retried automatically and status uses the original receipt',async()=>{
 const h=harness([prep(),new TypeError('network'),status()]);await h.controller.prepare();await h.controller.confirm();assert.equal(h.controller.state.phase,'unknown');assert.equal(h.timers.length,0);await h.controller.confirm();assert.equal(h.calls.length,2);
 await h.controller.check();assert.deepEqual(h.calls.at(-1),{action:'status',data:{operationId,receipt}});assert.equal(h.controller.state.phase,'pending');assert.equal(h.calls.filter(c=>c.action==='confirm').length,1);h.controller.dispose();
});

test('unknown or malformed status never claims deletion and retains the status receipt',async()=>{
 for(const bad of [status('deleted',{localDataDeleted:false}),status('deleted',{needsReview:true}),status('deleted',{operationId:'other_operation_123456'}),status('fencing',{localDataDeleted:true}),{},new Error('offline')]){
  const h=harness([prep(),status(),bad]);await h.controller.prepare();await h.controller.confirm();await h.controller.check();assert.equal(h.controller.state.phase,'unknown');assert.ok(h.store.read());h.controller.dispose();
 }
});

test('review is honest and stops automatic status checks; deletion needs explicit completion',async()=>{
 const h=harness([prep(),status('needs_review'),status('deleted')]);await h.controller.prepare();await h.controller.confirm();assert.equal(h.controller.state.phase,'review');assert.equal(h.timers.length,0);assert.match(deletionStatusView(h.controller.state).body,/accounted for/);assert.doesNotMatch(deletionMarkup(h.controller.state),/Account deleted/);
 await h.controller.check();assert.equal(h.controller.state.phase,'deleted');assert.ok(h.store.read(),'receipt remains until user leaves completion');h.controller.finish();assert.equal(h.store.read(),null);assert.match(deletionMarkup(h.controller.state),/active storage/);h.controller.dispose();
});

test('reload resumes status only and a request not begun can return to the account',async()=>{
 const storage=memory(),store=deletionReceiptStore(storage);store.write({operationId,receipt});const calls=[];
 const c=createDeletionController({store,request:async(action,data)=>{calls.push({action,data});return status('not_started');}});
 assert.equal(c.resume(),true);await tick();assert.equal(c.state.phase,'not_started');assert.deepEqual(calls,[{action:'status',data:{operationId,receipt}}]);c.finish();assert.equal(store.read(),null);c.dispose();
});

test('bounded polling stops after two minutes and manual checks remain available',async()=>{
 const h=harness([prep(),status(),status(),status('deleted')]);await h.controller.prepare();await h.controller.confirm();h.setTime(131000);await h.controller.check();assert.equal(h.controller.state.phase,'pending');assert.equal(h.timers.length,0);await h.controller.check();assert.equal(h.controller.state.phase,'deleted');h.controller.dispose();
});

test('closing or replacing the controller ignores a late preparation and completion',async()=>{
 let release;const h=harness([()=>new Promise(r=>release=r)]);const pending=h.controller.prepare();h.controller.dispose();release(prep());await pending;assert.equal(h.updates.length,1);assert.equal(h.store.read(),null);
 let finish;const second=harness([prep(),()=>new Promise(r=>finish=r)]);await second.controller.prepare();const confirm=second.controller.confirm();second.controller.dispose();finish(status('deleted'));await confirm;assert.equal(second.committed.length,0);assert.ok(second.store.read(),'in-flight operation can still be recovered');
});

test('storage failure prevents confirmation and no receipt exposes account or export data',async()=>{
 const storage={getItem:()=>null,setItem:()=>{throw Error('denied');},removeItem:()=>{}},h=harness([prep()],{store:deletionReceiptStore(storage)});await h.controller.prepare();await h.controller.confirm();assert.equal(h.calls.length,1);assert.equal(h.controller.state.phase,'error');assert.equal(h.controller.hasReceipt,false);
 const mem=memory(),store=deletionReceiptStore(mem);assert.equal(store.write({operationId,receipt,email:'secret@example.test',confirmationToken:'destructive'}),true);assert.deepEqual(JSON.parse([...mem.values.values()][0]),{operationId,receipt});assert.equal(deletionReceiptStore({getItem:()=>'{bad'}).read(),null);
});

test('requests are account-scoped and receipt status works without session credentials',async()=>{
 const calls=[],request=deletionRequest({accountId:'h_me',fetchImpl:async(...args)=>{calls.push(args);return {ok:true,json:async()=>({})};}});
 await request('prepare',{});await request('confirm',{confirmationToken:'signed'});await request('status',{operationId,receipt});
 for(const [,options]of calls){assert.equal(options.headers['X-Scheduling-Workspace'],undefined);assert.equal(options.cache,'no-store');}
 assert.equal(calls[0][1].headers['X-Scheduling-Account'],'h_me');assert.equal(calls[1][1].credentials,'same-origin');assert.equal(calls[2][1].headers['X-Scheduling-Account'],undefined);assert.equal(calls[2][1].credentials,'omit');assert.equal(calls[2][0],'/api/account/deletion/status');
});

test('confirmation renders escaped impacts and a concise export reminder',()=>{
 const html=deletionMarkup({phase:'confirm',preparation:prep()},{email:'<Ada>@example.test'});assert.match(html,/Keep a copy/);assert.match(html,/data-deletion-export/);assert.match(html,/&lt;Ada&gt;/);assert.doesNotMatch(html,/status_receipt|signed.confirmation/);
 const blocked=deletionMarkup({phase:'blocked',preparation:prep({blockers:[{code:'owned_workspaces',label:'<Acme>'}]})});assert.match(blocked,/&lt;Acme&gt;/);assert.match(blocked,/Open Team/);
 assert.throws(()=>validateDeletionPreparation(prep({canDelete:true,blockers:[{code:'busy',label:'Busy'}]})));assert.throws(()=>validateDeletionStatus(status('deleted',{providerRevocation:'revoked'}),operationId));
});
