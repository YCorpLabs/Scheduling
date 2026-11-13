import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuestions,validateIntake,intakeDescription,intakeRevision } from '../public/intake.js';
import { DEFAULT,validateConfig } from '../public/policy.js';
const questions=[
  {id:'topic',type:'text',label:'Topic',required:true},
  {id:'context',type:'textarea',label:'Context',required:false},
  {id:'team',type:'select',label:'Team size',required:true,options:['Just me','2–10']},
  {id:'consent',type:'checkbox',label:'Invite the guests listed',required:true},
];
const config={...DEFAULT,questions,extraGuestsLimit:2};
const data={email:'primary@example.test',answers:{topic:'  Quarterly review ',team:'2–10',consent:true},additionalGuests:[' OTHER@EXAMPLE.TEST ','other@example.test','primary@example.test']};
test('normalizes typed questions and snapshots only normalized definitions and answers',()=>{
  const result=validateIntake(config,data);
  assert.deepEqual(result.answers,{topic:'Quarterly review',team:'2–10',consent:true});
  assert.deepEqual(result.additionalGuests,['other@example.test']);
  assert.deepEqual(result.questionSnapshot,questions);
  config.questions[0].label='Updated topic';
  assert.equal(result.questionSnapshot[0].label,'Topic');
  config.questions[0].label='Topic';
  assert.equal(intakeDescription(result),'Topic\nQuarterly review\n\nTeam size\n2–10\n\nInvite the guests listed\nYes\n\n');
});
test('legacy question survives default migration; explicit empty questions disable it',()=>{
  assert.equal(validateConfig({...DEFAULT}).questions,null);
  assert.deepEqual(normalizeQuestions({...DEFAULT,question:' Plan? ',required:true}),[{id:'legacy',type:'textarea',label:'Plan?',required:true}]);
  assert.deepEqual(validateIntake({...DEFAULT,question:'Plan?'},{answer:'Notes'}).answers,{legacy:'Notes'});
  assert.deepEqual(normalizeQuestions({...DEFAULT,questions:[]}),[]);
  assert.throws(()=>validateIntake({...DEFAULT,questions:[]},{answer:'unexpected'}),/Check your booking answers/);
});
test('rejects malformed, duplicated, unknown and oversized definitions',()=>{
  const invalid=[{},Array(9).fill(questions[0]),[{...questions[0],id:'bad id'}],[questions[0],questions[0]],[{...questions[0],type:'script'}],[{...questions[0],required:'yes'}],[{...questions[0],options:['wrong']}],[{...questions[2],options:[]}],[{...questions[2],options:['same',' same']}],[{...questions[2],options:Array(13).fill('x')}],[{...questions[0],label:'x'.repeat(161)}],[{...questions[0],unexpected:true}]];
  for(const value of invalid)assert.throws(()=>validateConfig({...DEFAULT,questions:value}));
  for(const limit of [-1,6,'2',1.5])assert.throws(()=>validateConfig({...DEFAULT,extraGuestsLimit:limit}));
});
test('enforces required and typed answers and rejects stale or injected answer IDs',()=>{
  const cases=[{},null,[],{topic:'ok',team:'unknown',consent:true},{topic:'ok',team:'Just me',consent:false},{topic:'ok',team:'Just me',consent:'true'},{topic:'x'.repeat(501),team:'Just me',consent:true},{...data.answers,context:'x'.repeat(2001)},{...data.answers,extra:'unregistered'}];
  for(const answers of cases)assert.throws(()=>validateIntake(config,{...data,answers}));
  assert.throws(()=>validateIntake(config,{...data,answer:'unregistered legacy text'}));
  const optional={questions:[{id:'checked',type:'checkbox',label:'Optional',required:false},{id:'constructor',type:'text',label:'Optional text',required:false}]};
  assert.deepEqual(validateIntake(optional,{answers:{checked:false}}).answers,{checked:false});
});
test('extra guests are bounded, normalized, deduplicated and disabled by default',()=>{
  for(const guests of ['other@example.test',[{}],['bad address'],['bad@localhost'],Array(6).fill('other@example.test'),['a@example.test','b@example.test','c@example.test']])assert.throws(()=>validateIntake(config,{...data,additionalGuests:guests}));
  assert.throws(()=>validateIntake(DEFAULT,{additionalGuests:['other@example.test']}),/does not accept/);
  assert.deepEqual(validateIntake(DEFAULT,{}).additionalGuests,[]);
});
test('form revisions are deterministic canonical digests of questions and invitation allowance',async()=>{
 const original=await intakeRevision(config);assert.match(original,/^[A-Za-z0-9_-]{43}$/);
 const reordered={...config,questions:config.questions.map(({id,type,label,required,options})=>({required,label,type,id,...(options?{options}:{})}))};
 assert.equal(await intakeRevision(reordered),original);
 for(const questions of [config.questions.map((q,i)=>i? q:{...q,label:'Different meaning'}),config.questions.map((q,i)=>i? q:{...q,required:false}),config.questions.map((q,i)=>i!==2? q:{...q,options:['Other']})])assert.notEqual(await intakeRevision({...config,questions}),original);
 assert.notEqual(await intakeRevision({...config,extraGuestsLimit:1}),original);
 assert.equal(await intakeRevision({question:' Plan? ',required:true}),await intakeRevision({questions:[{id:'legacy',type:'textarea',label:'Plan?',required:true}],extraGuestsLimit:0}));
});
