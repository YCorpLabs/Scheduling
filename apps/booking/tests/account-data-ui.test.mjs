import test from 'node:test';
import assert from 'node:assert/strict';
import {createExportController,exportRequest,classifyExportError,assembleExport,exportFilename,exportRowView,canExportProfile,EXPORT_SCHEMA} from '../public/account-data-ui.js';

const page=(sections,nextCursor=null,scope='account')=>({schema:EXPORT_SCHEMA,generatedAt:'2026-11-12T10:00:00.000Z',scope,sections,nextCursor});
const httpError=(status,code)=>Object.assign(Error('refused'),{status,code});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class FakeBlob{constructor(parts,options){this.text=parts.join('');this.type=options.type;}}
function harness({responses,scope='account',isCurrent=()=>true,maxPages,maxBytes}={}){
 const calls=[],updates=[],created=[],revoked=[],lost=[];let n=0;
 const urls={createObjectURL:blob=>{created.push(blob);return 'blob:'+(++n);},revokeObjectURL:url=>revoked.push(url)};
 const request=async cursor=>{calls.push(cursor);const next=responses.shift();if(typeof next==='function')return next(cursor);if(next instanceof Error)throw next;return next;};
 const controller=createExportController({request,scope,name:'Acme AS',isCurrent:()=>isCurrent(),onUpdate:s=>updates.push(s),onAuthorityLost:e=>lost.push(e.status),urls,BlobImpl:FakeBlob,now:()=>new Date('2026-11-12T12:00:00Z'),...(maxPages?{maxPages}:{}),...(maxBytes?{maxBytes}:{})});
 return {controller,calls,updates,created,revoked,lost};
}
async function settle(){for(let i=0;i<10;i++)await tick();}

test('multiple pages are read serially and only the complete file is offered',async()=>{
 const h=harness({responses:[page([{name:'profile',data:{name:'Riley'}},{name:'bookings',data:[1,2]}],'c1'),page([{name:'bookings',data:[3]}],'c2'),page([{name:'bookings',data:[4]},{name:'tracking',data:[]}])]});
 h.controller.start();await settle();
 assert.deepEqual(h.calls,[null,'c1','c2']);
 assert.equal(h.updates.filter(s=>s.status==='preparing').every(s=>s.url===null),true);
 const done=h.controller.state;assert.equal(done.status,'ready');assert.equal(done.url,'blob:1');assert.equal(done.filename,'scheduling-account-2026-11-12.json');
 const file=JSON.parse(h.created[0].text);assert.equal(h.created[0].type,'application/json');
 assert.deepEqual(file,{schema:1,scope:'account',generatedAt:'2026-11-12T10:00:00.000Z',sections:[{name:'profile',data:{name:'Riley'}},{name:'bookings',data:[1,2,3,4]},{name:'tracking',data:[]}]});
});

test('a repeated cursor stops the export without a partial download',async()=>{
 const h=harness({responses:[page([{name:'a',data:[1]}],'c1'),page([{name:'a',data:[2]}],'c1')]});
 h.controller.start();await settle();
 assert.equal(h.controller.state.status,'stopped');assert.equal(h.controller.state.url,null);assert.equal(h.created.length,0);
 const h2=harness({responses:[page([],'c1'),page([],'c2'),page([],'c1')]});h2.controller.start();await settle();
 assert.equal(h2.controller.state.status,'stopped');assert.equal(h2.created.length,0);
});

test('a recoverable error keeps the cursor and pages, and Try again resumes from that cursor',async()=>{
 const h=harness({responses:[page([{name:'a',data:[1]}],'c1'),httpError(503),page([{name:'a',data:[2]}])]});
 h.controller.start();await settle();
 assert.equal(h.controller.state.status,'paused');assert.equal(h.controller.state.pages,1);assert.equal(h.controller.state.url,null);assert.match(h.controller.state.message,/reach/);
 h.controller.retry();await settle();
 assert.deepEqual(h.calls,[null,'c1','c1']);assert.equal(h.controller.state.status,'ready');
 assert.deepEqual(JSON.parse(h.created[0].text).sections,[{name:'a',data:[1,2]}]);
 const network=harness({responses:[new TypeError('Failed to fetch')]});network.controller.start();await settle();assert.equal(network.controller.state.status,'paused');
});

test('changed or expired exports discard partial pages and restart from the beginning',async()=>{
 for(const [error,text] of [[httpError(409,'export_changed'),/changed/],[httpError(410,'export_expired'),/too long/]]){
  const h=harness({responses:[page([{name:'a',data:[1]}],'c1'),error,page([{name:'a',data:[9]}])]});
  h.controller.start();await settle();
  assert.equal(h.controller.state.status,'stopped');assert.equal(h.controller.state.pages,0);assert.match(h.controller.state.message,text);
  h.controller.retry();await settle();assert.equal(h.calls.length,2,'retry never continues a discarded export');
  h.controller.start();await settle();
  assert.deepEqual(h.calls,[null,'c1',null]);assert.deepEqual(JSON.parse(h.created[0].text).sections,[{name:'a',data:[9]}]);
 }
 const expiredOnRetry=harness({responses:[page([],'c1'),httpError(502),httpError(410,'export_expired')]});
 expiredOnRetry.controller.start();await settle();expiredOnRetry.controller.retry();await settle();
 assert.equal(expiredOnRetry.controller.state.status,'stopped');assert.equal(expiredOnRetry.created.length,0);
});

test('authority loss stops the export, reports it once and never offers a cached file',async()=>{
 for(const status of [401,403]){
  const h=harness({scope:'workspace',responses:[page([{name:'members',data:[]}],'c1','workspace'),httpError(status)]});
  h.controller.start();await settle();
  assert.equal(h.controller.state.status,'stopped');assert.deepEqual(h.lost,[status]);assert.equal(h.created.length,0);
  assert.doesNotMatch(exportRowView(h.controller.state,{actionLabel:'Export Acme data'}).actions,/Download|blob:/);
 }
});

test('profile switch or closed view mid-export disposes the run and ignores late pages',async()=>{
 let current=true,release;const h=harness({scope:'workspace',isCurrent:()=>current,responses:[()=>new Promise(r=>{release=r;})]});
 h.controller.start();await tick();const before=h.updates.length;current=false;release(page([],null,'workspace'));await settle();
 assert.equal(h.controller.disposed,true);assert.equal(h.updates.length,before);assert.equal(h.created.length,0);
 h.controller.start();assert.equal(h.calls.length,1);
});

test('cancel ignores the in-flight page; replacement and close revoke the object URL',async()=>{
 let release;const h=harness({responses:[()=>new Promise(r=>{release=r;}),page([]),page([])]});
 h.controller.start();await tick();h.controller.cancel();release(page([],'late'));await settle();
 assert.equal(h.controller.state.status,'idle');assert.equal(h.created.length,0);
 h.controller.start();await settle();assert.equal(h.controller.state.url,'blob:1');
 h.controller.start();await settle();assert.deepEqual(h.revoked,['blob:1']);assert.equal(h.controller.state.url,'blob:2');
 h.controller.dispose();assert.deepEqual(h.revoked,['blob:1','blob:2']);
});

test('invalid pages and unbounded exports never produce a download',async()=>{
 for(const bad of [page([],null,'workspace'),{...page([]),schema:2},{...page([]),sections:[{data:1}]},{...page([]),nextCursor:''},null]){
  const h=harness({responses:[bad]});h.controller.start();await settle();
  assert.equal(h.controller.state.status,'stopped');assert.equal(h.created.length,0);
 }
 let i=0;const h=harness({maxPages:3,responses:Array.from({length:5},()=>page([],'c'+(++i)))});h.controller.start();await settle();
 assert.equal(h.calls.length,3);assert.equal(h.controller.state.status,'stopped');assert.equal(h.created.length,0);
 assert.throws(()=>assembleExport([page([],'more')],'account'));
});

test('export never writes contents to the console',async()=>{
 const methods=['log','info','warn','error','debug'],original=methods.map(m=>console[m]);let calls=0;methods.forEach(m=>{console[m]=()=>{calls++;};});
 try{const h=harness({responses:[page([{name:'secret',data:'guest@example.com'}],'c1'),httpError(500),page([])]});h.controller.start();await settle();h.controller.retry();await settle();h.controller.dispose();}
 finally{methods.forEach((m,i)=>{console[m]=original[i];});}
 assert.equal(calls,0);
});

test('account requests never carry a profile; profile requests always name the profile chosen at start',async()=>{
 const seen=[];const fetchImpl=async(url,init)=>{seen.push({url,init});return {ok:true,json:async()=>page([])};};
 await exportRequest({scope:'account',fetchImpl})(null);await exportRequest({scope:'account',fetchImpl})('c1');
 await exportRequest({scope:'workspace',workspaceId:'h_company',fetchImpl})('c2');
 assert.equal(seen[0].url,'/api/live/account/export');assert.equal(seen[0].init.method,'POST');assert.equal(seen[0].init.body,'{}');assert.equal(seen[0].init.cache,'no-store');
 assert.equal(Object.keys(seen[0].init.headers).some(k=>/workspace/i.test(k)),false);assert.equal(seen[1].init.body,'{"cursor":"c1"}');
 assert.equal(seen[2].url,'/api/live/workspace/export');assert.equal(seen[2].init.headers['X-Scheduling-Workspace'],'h_company');
 assert.throws(()=>exportRequest({scope:'workspace',fetchImpl}));
 const refused=exportRequest({scope:'account',fetchImpl:async()=>({ok:false,status:409,json:async()=>({error:'Changed',code:'export_changed'})})});
 await assert.rejects(refused(null),e=>e.status===409&&e.code==='export_changed');
 assert.equal(classifyExportError({status:400}).recoverable,false);assert.equal(classifyExportError({status:429}).recoverable,true);
});

test('profile export needs an explicit capability and uses the profile name',()=>{
 assert.equal(canExportProfile({id:'h1',name:'Acme',role:'owner',personal:false,capabilities:{exportProfile:true}}),true);
 assert.equal(canExportProfile({id:'h1',name:'Acme',role:'owner',personal:false}),false);
 assert.equal(canExportProfile({id:'h1',name:'Acme',role:'member',personal:false,capabilities:{exportProfile:false}}),false);
 assert.equal(canExportProfile({id:'p',name:'Riley',role:'owner',personal:true,capabilities:{exportProfile:true}}),false);
 assert.equal(exportFilename('workspace','Café Acme AS',new Date('2026-11-12T00:00:00Z')),'scheduling-cafe-acme-as-2026-11-12.json');
 assert.equal(exportFilename('workspace','!!!',new Date('2026-11-12T00:00:00Z')),'scheduling-profile-2026-11-12.json');
});

test('row offers Download only when ready',()=>{
 const label={actionLabel:'Export your data'};
 assert.match(exportRowView({status:'idle'},label).actions,/aria-label="Export your data"/);
 assert.doesNotMatch(exportRowView({status:'preparing',pages:2},label).actions,/Download/);assert.equal(exportRowView({status:'preparing',pages:2},label).status,'Preparing export… 2 parts');
 assert.doesNotMatch(exportRowView({status:'paused',message:'x',pages:1},label).actions,/Download/);
 assert.match(exportRowView({status:'ready',url:'blob:1',filename:'f.json'},label).actions,/href="blob:1" download="f.json"/);
 assert.match(exportRowView({status:'stopped',message:'Gone'},label).actions,/Export again/);
});


test('UTF-8 byte limits discard large exports without a partial blob',async()=>{
 const h=harness({maxBytes:250,responses:[page([{name:'bookings',data:['界'.repeat(100)]}])]});h.controller.start();await settle();
 assert.equal(h.controller.state.status,'stopped');assert.equal(h.controller.state.pages,0);assert.equal(h.created.length,0);assert.match(h.controller.state.message,/download limit/);
});


test('each export request asserts the displayed account and a mismatch cannot offer retry or download',async()=>{
 const seen=[];const request=exportRequest({scope:'account',expectedAccountId:'h_A',fetchImpl:async(_url,options)=>{seen.push(options);return {ok:true,json:async()=>page([])};}});
 await request(null);await request('cursor');assert.ok(seen.every(r=>r.headers['X-Scheduling-Account']==='h_A'));
 const h=harness({responses:[httpError(409,'export_account_changed')]});h.controller.start();await settle();assert.equal(h.controller.state.status,'stopped');assert.equal(h.created.length,0);assert.match(h.controller.state.message,/account changed/);assert.equal(exportRowView(h.controller.state,{}).actions,'');
});
