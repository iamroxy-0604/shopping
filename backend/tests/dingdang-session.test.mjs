import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DingdangSessions,validateEnvelope,workspaceDocument} from '../src/dingdang-session.mjs';
import {desktopChat,shoppingResult} from '../src/desktop-shopping.mjs';

const request=(op='open',requestId=op,revision=null)=>({protocol:'dingdang.interactive-session',version:'0.1',kind:'request',sessionId:'session-1',requestId,op,expectedRevision:revision,body:op==='open'?{subjectRef:'user-one',consentRef:'consent-1',grant:{id:'dd-grant:session-1',revision:1,expiresAt:new Date(Date.now()+3600000).toISOString(),scopes:[{kind:'interaction',policy:'dingdang.session-interaction/1',constraints:{sessionId:'session-1',allow:['message','action'],businessExecution:false}}]},context:{purpose:'找一盏台灯',messages:[],resourceRefs:[]},presentationOffers:[{profile:'iframe',version:'1',catalog:'dingdang.embed-bridge/1'}],expiresAt:new Date(Date.now()+3600000).toISOString()}:op==='sync'?{afterRevision:revision||0,requestIds:[]}:op==='close'?{reason:'user_finished',workPolicy:'cancel',grantRevision:1}:{grantRevision:1,input:{type:'message',text:'预算 300 元以内',resourceRefs:[]}}});
const create=(t,chat)=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),'shopping-dd-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return new DingdangSessions({directory,chat,document:()=>({html:'<div id="app"></div>',css:'',script:''})});};
const result={ok:true,type:'question',message:'你想在哪里用？',items:[],question:{id:'scene',title:'使用场景',options:['书桌','床头']},preferences:{category:'台灯'}};

test('DD open → question → input → restore → close matches the supplied schema',async t=>{
  let calls=0;const svc=create(t,async()=>{calls++;return structuredClone(result);});
  const open=request();const a=await svc.handle(open,'verified-peer');assert.equal(a.kind,'snapshot');assert.equal(a.body.revision,1);assert.ok(validateEnvelope(a));assert.equal(a.body.content.actions[0].actionId,'shopping.answer');
  assert.deepEqual(await svc.handle(open,'verified-peer'),a);assert.equal(calls,1);
  const input=request('input','answer-1',1);input.body.input={type:'action',actionId:'shopping.answer',arguments:{questionId:'scene',value:'书桌'},contextRefs:['shopping.workspace']};
  const b=await svc.handle(input,'verified-peer');assert.equal(b.body.revision,2);assert.ok(validateEnvelope(b));
  const restored=new DingdangSessions({directory:svc.directory,chat:svc.chat});const c=await restored.handle(request('sync'),'verified-peer');assert.deepEqual(c.body,b.body);
  const closed=await restored.handle(request('close','close',2),'verified-peer');assert.equal(closed.kind,'closed');assert.ok(validateEnvelope(closed));assert.match(closed.body.handoff.summary,/未进行下单/);
  assert.equal((await restored.handle(request('input','later',3),'verified-peer')).body.code,'SESSION_CLOSED');
});
test('scope isolation, idempotency conflicts, stale actions and expiry fail closed',async t=>{
  const svc=create(t,async()=>structuredClone(result));const open=request();await svc.handle(open,'peer-a');
  assert.equal((await svc.handle(request('sync'),'peer-b')).body.code,'SESSION_NOT_FOUND');
  const changed=structuredClone(open);changed.body.context.purpose='不同需求';assert.equal((await svc.handle(changed,'peer-a')).body.code,'IDEMPOTENCY_CONFLICT');
  assert.equal((await svc.handle(request('input','stale',0),'peer-a')).body.code,'REVISION_CONFLICT');
  const unknown=request('input','unknown',1);unknown.body.input={type:'action',actionId:'pay',arguments:{},contextRefs:[]};assert.equal((await svc.handle(unknown,'peer-a')).body.code,'UNKNOWN_ACTION');
  const expired=request();expired.sessionId='expired';expired.body.grant.scopes[0].constraints.sessionId='expired';expired.body.expiresAt='2020-01-01T00:00:00Z';assert.equal((await svc.handle(expired,'peer-a')).body.code,'GRANT_EXPIRED');
});
test('uncertain work is never re-executed after restart',async t=>{
  let calls=0;const svc=create(t,async()=>{calls++;throw Error('interrupted');});const open=request();assert.equal((await svc.handle(open,'peer')).body.code,'RESULT_UNCERTAIN');
  const restored=new DingdangSessions({directory:svc.directory,chat:svc.chat});assert.equal((await restored.handle(open,'peer')).body.code,'RESULT_UNCERTAIN');assert.equal(calls,1);
  assert.equal((await restored.handle(request('sync'),'peer')).body.operations[0].status,'unknown');
});
test('concurrent submissions do not run two shopping calls',async t=>{
  let release;const svc=create(t,()=>new Promise(r=>{release=r;}));const open=request();const waiting=svc.handle(open,'peer');
  assert.equal((await svc.handle(request('input','second',0),'peer')).body.code,'BUSY');release(result);await waiting;
});
test('desktop output is products-only and strips executable URLs',async()=>{
  const raw={ok:true,type:'results',message:'推荐',summary:'第一款更适合阅读，第二款更适合氛围照明。',emphasis:['更适合阅读','不存在的短语','更适合阅读'],items:[{id:'p',title:'台灯',imageUrl:'javascript:alert(1)',promotionUrl:'https://example.com/item',price:NaN},{kind:'content',title:'帖子'}],contentRecords:[{body:'帖子'}],ui:{blocks:[{type:'content_list'}]}};
  const value=shoppingResult(raw);assert.equal(value.items.length,1);assert.equal(value.items[0].imageUrl,'');assert.equal(value.items[0].price,null);assert.deepEqual(value.emphasis,['更适合阅读']);assert.equal(value.contentRecords,undefined);assert.equal(value.ui,undefined);
  let seen;await desktopChat({sessionId:'s1',message:'台灯'},{owner:'owner-a',run:async r=>{seen=r;return raw;}});assert.equal(seen.productsOnly,true);assert.notEqual(seen.sessionId,'s1');
});
test('delivered iframe fits DD document limits and has no external executable assets',()=>{
  const d=workspaceDocument();assert.ok(d.html.length<=100000);assert.ok(d.css.length<=100000);assert.ok(d.script.length<=200000);assert.ok(!d.html.includes('<script src='));assert.match(d.script,/dingdang.embed-bridge/);
});

test('desktop preserves questionnaire progress, narrative retry candidates and AI follow-up',()=>{
  const value=shoppingResult({ok:false,type:'error',message:'分析待重试',question:{id:'scene',title:'场景',options:['书桌'],step:2,total:4},task:{category:'台灯',answers:{use:'阅读'}},candidateItems:[{id:'a',title:'台灯',price:89,facts:{material:'木'}}],followUp:'更在意哪一项？',narrativeSource:'none',error:{code:'NARRATIVE_UNAVAILABLE',message:'分析待重试'}});
  assert.equal(value.question.step,2);assert.equal(value.question.total,4);assert.equal(value.candidateItems.length,1);assert.equal(value.candidateItems[0].facts.material,'木');assert.equal(value.followUp,'更在意哪一项？');assert.equal(value.task.answers.use,'阅读');
});
test('new desktop sessions preserve person identity but isolate shopping sessions',async()=>{
  const seen=[];const run=async r=>{seen.push(r);return {ok:true,type:'question',message:'需求',items:[]};};
  for(const sessionId of ['one','two'])await desktopChat({sessionId,userId:'user-existing',message:'我喜欢原木'},{run});
  assert.equal(seen[0].userId,'user-existing');assert.equal(seen[0].userId,seen[1].userId);assert.notEqual(seen[0].sessionId,seen[1].sessionId);
  await desktopChat({sessionId:'session-original',userId:'user-existing',legacySession:true,message:'继续挑选'},{run});
  assert.equal(seen[2].sessionId,'session-original');assert.equal(seen[2].userId,'user-existing');
  seen.length=0;
  for(const sessionId of ['one','two'])await desktopChat({sessionId,message:'台灯'},{owner:'verified-peer-and-subject',run});
  assert.equal(seen[0].userId,seen[1].userId);assert.notEqual(seen[0].sessionId,seen[1].sessionId);
});
