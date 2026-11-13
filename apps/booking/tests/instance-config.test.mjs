import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseJsonc,validateOverlay,mergeInstance,INSTANCE_KEYS,BASE_CONFIG} from '../scripts/instance-config.mjs';

const base=parseJsonc(readFileSync(BASE_CONFIG,'utf8'));
const example=parseJsonc(readFileSync(new URL('../wrangler.instance.example.jsonc',import.meta.url),'utf8'));
const overlay=()=>({name:'acme-scheduling',workers_dev:false,preview_urls:false,routes:[{pattern:'meet.acme.test',custom_domain:true}],
  vars:{PUBLIC_ORIGIN:'https://meet.acme.test',LIVE_ENABLED:'true',NOTIFICATION_PROVIDER:'cloudflare',MAIL_FROM:'Acme Scheduling <notify@acme.test>',BRAND_NAME:'Acme'},
  send_email:[{name:'EMAIL',allowed_sender_addresses:['notify@acme.test']}]});

test('the shared configuration names no operator and keeps stored classes and privacy settings',()=>{
  assert.equal(base.name,'scheduling');
  for(const key of ['routes','route','vars','send_email','account_id'])assert.equal(key in base,false,key);
  assert.deepEqual(base.durable_objects.bindings.map(b=>[b.name,b.class_name]),[['HOSTS','BookingHost'],['LIVE_HOSTS','LiveBookingHost'],['AUTH','AuthStore']]);
  assert.deepEqual(base.migrations,[{tag:'v1',new_sqlite_classes:['BookingHost']},{tag:'v2',new_sqlite_classes:['LiveBookingHost','AuthStore']}]);
  assert.equal(base.observability.traces.enabled,false);assert.equal(base.observability.logs.invocation_logs,false);assert.equal(base.observability.redact_query_string,true);
  assert.deepEqual(base.triggers.crons,['*/5 * * * *']);
});

test('JSONC comments and trailing commas parse without touching strings',()=>{
  assert.deepEqual(parseJsonc('// lead\n{"a": "x // not a comment", /* gap */ "b": ["https://y/*z*/",],}\n'),{a:'x // not a comment',b:['https://y/*z*/']});
  assert.deepEqual(parseJsonc('{"q": "say \\"hi\\", // still text"}'),{q:'say "hi", // still text'});
});

test('an overlay adds identity only; shared keys always come from the code',()=>{
  const merged=mergeInstance(base,overlay());
  assert.equal(merged.name,'acme-scheduling');assert.deepEqual(merged.routes,[{pattern:'meet.acme.test',custom_domain:true}]);
  assert.equal(merged.vars.PUBLIC_ORIGIN,'https://meet.acme.test');assert.equal(merged.workers_dev,false);
  for(const key of Object.keys(base))if(!INSTANCE_KEYS.includes(key))assert.deepEqual(merged[key],base[key],key);
  assert.equal('vars' in base,false,'merge does not mutate the shared config');
});

test('overlays cannot change bindings, migrations or tracing, or carry secrets',()=>{
  for(const key of ['durable_objects','migrations','observability','main','assets','triggers','compatibility_date']){
    assert.match(validateOverlay({...overlay(),[key]:{}}).join('\n'),new RegExp(`"${key}" is shared configuration`));
  }
  for(const secret of ['GOOGLE_CLIENT_SECRET','TOKEN_ENCRYPTION_KEY','RESEND_API_KEY','GOOGLE_CLIENT_ID']){
    const value=overlay();value.vars[secret]='value';assert.match(validateOverlay(value).join('\n'),/is a secret/);
  }
  const unknown=overlay();unknown.vars.SOMETHING='x';assert.match(validateOverlay(unknown).join('\n'),/Unknown variable SOMETHING/);
  assert.throws(()=>mergeInstance(base,{...overlay(),migrations:[]}),error=>error.problems.length>0);
});

test('required identity is checked and example values are refused',()=>{
  assert.deepEqual(validateOverlay(overlay()),[]);
  const noOrigin=overlay();delete noOrigin.vars.PUBLIC_ORIGIN;assert.match(validateOverlay(noOrigin).join('\n'),/PUBLIC_ORIGIN must be an HTTPS origin/);
  for(const origin of ['http://meet.acme.test','https://meet.acme.test/','https://meet.acme.test/path']){const value=overlay();value.vars.PUBLIC_ORIGIN=origin;assert.notDeepEqual(validateOverlay(value),[],origin);}
  for(const name of ['','Acme','acme_scheduling','-acme'])assert.match(validateOverlay({...overlay(),name}).join('\n'),/"name" must be a Worker name/);
  assert.match(validateOverlay({...overlay(),account_id:'not-an-id'}).join('\n'),/account_id/);
  assert.match(validateOverlay(example).join('\n'),/Replace every example value/);
  const filled=JSON.parse(JSON.stringify(example).replaceAll('scheduling.example.com','meet.acme.test'));
  assert.deepEqual(validateOverlay(filled),[]);
  const placeholder=overlay();placeholder.vars.MAIL_FROM='Acme <notify@acme.test>';placeholder.account_id='<your account>';assert.match(validateOverlay(placeholder).join('\n'),/Replace every example value/);
});

test('the command writes a private merged config inside the app and refuses bad overlays without output',()=>{
  const dir=mkdtempSync(join(tmpdir(),'scheduling-instance-')),out=new URL('../wrangler.instance.test-output.json',import.meta.url).pathname;
  try{
    const good=join(dir,'good.jsonc');writeFileSync(good,'// private\n'+JSON.stringify(overlay(),null,2));
    const run=(file,args=[])=>spawnSync(process.execPath,[new URL('../scripts/instance-config.mjs',import.meta.url).pathname,'--out',out,...args],{env:{...process.env,SCHEDULING_INSTANCE_CONFIG:file},encoding:'utf8'});
    const result=run(good);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Worker: acme-scheduling/);assert.match(result.stdout,/Nothing was deployed/);
    assert.equal(statSync(out).mode&0o777,0o600);assert.equal(JSON.parse(readFileSync(out,'utf8')).vars.BRAND_NAME,'Acme');rmSync(out);
    const bad=join(dir,'bad.jsonc');writeFileSync(bad,JSON.stringify({...overlay(),migrations:[]}));
    const refused=run(bad);assert.equal(refused.status,1);assert.match(refused.stderr,/"migrations" is shared configuration/);assert.equal(existsSync(out),false);
    assert.equal(run(join(dir,'missing.jsonc')).status,1);
    const outside=spawnSync(process.execPath,[new URL('../scripts/instance-config.mjs',import.meta.url).pathname,'--out',join(dir,'x.json')],{env:{...process.env,SCHEDULING_INSTANCE_CONFIG:good},encoding:'utf8'});
    assert.equal(outside.status,1);assert.equal(existsSync(join(dir,'x.json')),false);
  }finally{rmSync(dir,{recursive:true,force:true});rmSync(out,{force:true});}
});
