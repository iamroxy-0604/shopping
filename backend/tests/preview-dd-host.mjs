// Local QA host using the exact renderer from the user-supplied DD release.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DingdangSessions} from '../src/dingdang-session.mjs';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dd-browser-qa-'));
const svc=new DingdangSessions({directory,chat:async({message,answer})=>({ok:true,type:answer?'results':'question',message:answer?'已按你的答案更新商品建议（协议验收数据）。':'这是 DD 原版隔离宿主的协议验收，请选择使用场景。',items:answer?[{id:'qa-lamp',title:'协议测试台灯',price:89,imageUrl:'',recommendation:'仅用于接管协议验收',source:'测试数据'}]:[],question:answer?undefined:{id:'scene',title:'使用场景',options:['书桌','床头']},preferences:{category:'台灯'}})});
function envelope(op,id,revision,body){return {protocol:'dingdang.interactive-session',version:'0.1',kind:'request',sessionId:'browser-session',requestId:id,op,expectedRevision:revision,body};}
const expiry=new Date(Date.now()+3600000).toISOString();
let snapshot=await svc.handle(envelope('open','open',null,{subjectRef:'qa',consentRef:'qa-consent',grant:{id:'dd-grant:browser-session',revision:1,expiresAt:expiry,scopes:[{kind:'interaction',policy:'dingdang.session-interaction/1',constraints:{sessionId:'browser-session',allow:['message','action']}}]},context:{purpose:'买台灯',messages:[],resourceRefs:[]},presentationOffers:[{profile:'iframe',version:'1',catalog:'dingdang.embed-bridge/1'}],expiresAt:expiry}),'qa-peer');
const server=http.createServer(async(req,res)=>{
  if(req.url==='/renderer.js'){res.setHeader('content-type','text/javascript');return res.end(fs.readFileSync(new URL('./fixtures/dd-interactive-web-surface.js',import.meta.url)));}
  if(req.url==='/state'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({snapshot,phase:snapshot.kind==='closed'?'closed':'open',pending:false}));}
  if(req.url==='/action'){
    let data='';for await(const chunk of req)data+=chunk;const {op,packet}=JSON.parse(data);
    const body=op==='input'?{grantRevision:1,input:packet.input}:op==='close'?{reason:'user_finished',workPolicy:'cancel',grantRevision:1}:{afterRevision:0,requestIds:[]};
    const result=await svc.handle(envelope(op,packet.requestId,op==='sync'?null:snapshot.body.revision,body),'qa-peer');
    if(result.kind==='snapshot'||result.kind==='closed')snapshot=result;
    res.setHeader('content-type','application/json');return res.end(JSON.stringify({snapshot,phase:result.kind==='closed'?'closed':'open',pending:false,error:result.kind==='error'?result.body:null}));
  }
  res.setHeader('content-type','text/html;charset=utf-8');res.end(`<!doctype html><html lang="zh-CN"><head><title>DD 原版宿主 · 协议验收</title><style>body{margin:0;font-family:sans-serif}header{padding:15px;background:#fff3eb;font-size:13px}.is-web-frame-holder{height:calc(100dvh - 50px);display:flex;flex-direction:column}.is-agent-frame{flex:1;width:100%;border:0}.is-frame-status,.is-frame-fallback{padding:8px 15px;font-size:12px}.is-frame-fallback p{max-height:80px;overflow:auto}</style></head><body><header>DD 原版沙箱宿主 · 测试数据 <button id="sync">恢复核对</button><button id="close">交回叮当</button><span id="status"></span></header><script type="module">import{createWebSurface}from'/renderer.js';const state=await(await fetch('/state')).json();const node=(tag,cls='',text='')=>{const e=document.createElement(tag);e.className=cls;e.textContent=text;return e;};async function dispatch(op,packet){const result=await(await fetch('/action',{method:'POST',body:JSON.stringify({op,packet})})).json();if(result.phase==='closed'){web.dispose();document.querySelector('#status').textContent=result.snapshot.body.handoff.summary;}else web.update(result);return result;}const web=createWebSurface({sessionId:'browser-session',document:state.snapshot.body.content.surfaces[0].data.document,name:'拾光',node,dispatch,closeRequest:()=>dispatch('close',{requestId:crypto.randomUUID()}),notify:message=>document.querySelector('#status').textContent=message});document.body.append(web.element);web.update(state);document.querySelector('#sync').onclick=()=>dispatch('sync',{requestId:crypto.randomUUID()});document.querySelector('#close').onclick=()=>dispatch('close',{requestId:crypto.randomUUID()});</script></body></html>`);
});
server.listen(4319,'127.0.0.1',()=>console.log('DD protocol QA host: http://127.0.0.1:4319'));
