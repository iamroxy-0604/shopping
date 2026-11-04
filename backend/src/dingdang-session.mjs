import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { desktopChat, scopedId } from './desktop-shopping.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(base,'../contracts/interactive-session-v0.1.json'),'utf8'));
const ajv = new Ajv({strict:false}); addFormats(ajv);
export const validateEnvelope = ajv.compile(schema);
const protocol = 'dingdang.interactive-session';
const presentation = {profile:'iframe',version:'1',catalog:'dingdang.embed-bridge/1'};
const response = (e,kind,body) => ({protocol,version:'0.1',kind,sessionId:e.sessionId,replyTo:e.requestId,body});
const failure = (e,code,message,retryable=false) => response(e,'error',{code,message,retryable});
const stable = value => JSON.stringify(value, (_key,v) => v && !Array.isArray(v) && typeof v==='object' ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);

export function workspaceDocument() {
  const folder=path.join(base,'../public/desktop');
  const assets=Object.fromEntries(fs.readdirSync(path.join(folder,'assets')).map(name=>[name,`data:image/${name.endsWith('.svg')?'svg+xml':name.endsWith('.jpg')?'jpeg':'png'};base64,${fs.readFileSync(path.join(folder,'assets',name)).toString('base64')}`]));
  // Product photographs are remote HTTPS facts. Only the small host logo/icons travel in the script.
  for(const key of ['storage.png','lamp.png','tray.png'])delete assets[key];
  return {html:'<!doctype html><html lang="zh-CN"><head></head><body><div id="app"></div></body></html>',css:fs.readFileSync(path.join(folder,'styles.css'),'utf8'),script:`window.SHOPPING_ASSETS=${JSON.stringify(assets)};\n${fs.readFileSync(path.join(folder,'app.js'),'utf8')}`};
}

export class DingdangSessions {
  constructor({directory=path.join(base,'../data/dingdang-sessions'),chat=desktopChat,document=workspaceDocument}={}) {
    this.directory=directory;this.chat=chat;this.document=document;this.running=new Map();
    fs.mkdirSync(directory,{recursive:true});
  }
  file(owner,sid){return path.join(this.directory,scopedId(owner,sid)+'.json');}
  load(owner,sid){const file=this.file(owner,sid);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;}
  save(owner,sid,row){const file=this.file(owner,sid);fs.writeFileSync(file+'.tmp',JSON.stringify(row));fs.renameSync(file+'.tmp',file);}
  snapshot(e,row) {
    const last=row.messages.filter(m=>m.role==='assistant').at(-1)?.result;
    const actions=last?.question?[{actionId:'shopping.answer',label:last.question.title,inputSchema:{type:'object',properties:{questionId:{type:'string',enum:[last.question.id]},value:{type:'string',minLength:1,maxLength:1000}},required:['questionId','value'],additionalProperties:false},permissionRefs:[row.grantId+':interaction']}]:[];
    return response(e,'snapshot',{revision:row.revision,lifecycle:row.closed?'closed':'open',grantRevision:row.grantRevision,expiresAt:row.expiresAt,
      capabilities:{input:{message:true,action:true},sync:true,close:{cancel:true,detach:false}},presentation:row.presentation,
      content:{messages:row.messages.slice(-20).map((m,i)=>({id:`message-${i}`,text:m.role==='user'?m.text:(m.result.message||m.result.error?.message||'已更新商品建议'),resourceRefs:[]})),resources:[],actions,
        surfaces:row.presentation.profile==='iframe'?[{surfaceId:'shopping.workspace',profile:'iframe',profileVersion:'1',fallbackText:last?.message||'拾光购物工作区',data:{bridge:'dingdang.embed-bridge',bridgeVersion:'1',document:row.document,state:{messages:row.messages.slice(-40),preferences:row.preferences,title:row.title}}}]:[]},
      tasks:[],operations:Object.entries(row.operations).map(([requestId,o])=>({requestId,status:o.result?'succeeded':this.running.has(this.file(row.owner,e.sessionId))?'working':'unknown',errorCode:o.result?null:'RESULT_UNCERTAIN'})),...(row.closed?{handoff:row.handoff}:{})});
  }
  async handle(e,owner) {
    if(!validateEnvelope(e)||e.kind!=='request'||typeof owner!=='string'||!owner)throw Error('Invalid interactive session envelope or verified owner');
    const key=this.file(owner,e.sessionId), fingerprint=stable(e);
    let row=this.load(owner,e.sessionId);
    const previous=row?.operations[e.requestId];
    if(previous){
      if(previous.fingerprint!==fingerprint)return failure(e,'IDEMPOTENCY_CONFLICT','请求标识已用于另一条操作。');
      if(previous.result)return previous.result;
      if(this.running.has(key))return failure(e,'BUSY','原操作仍在执行，请恢复核对。',true);
      return failure(e,'RESULT_UNCERTAIN','服务曾中断，原操作结果不确定；请交回会话后重新开始。');
    }
    if(e.op==='sync') {
      if(!row)return failure(e,'SESSION_NOT_FOUND','购物会话不存在。');
      if(Date.parse(row.expiresAt)<=Date.now()&&!row.closed)return failure(e,'SESSION_EXPIRED','购物会话已过期，请重新发起。');
      return this.snapshot(e,row);
    }
    if(this.running.has(key))return failure(e,'BUSY','上一轮仍在处理，请恢复核对。',true);
    if(e.op==='open'){
      if(row)return failure(e,'IDEMPOTENCY_CONFLICT','会话已经存在，请恢复原会话。');
      const offer=e.body.presentationOffers.find(p=>stable(p)===stable(presentation))||e.body.presentationOffers.find(p=>p.profile==='text'&&p.version==='1'&&p.catalog===null);
      if(!offer)return failure(e,'UNSUPPORTED_CAPABILITY','需要 iframe/1 或 text/1 展示能力。');
      const grant=e.body.grant;
      if(grant.revision!==1||!grant.scopes.some(s=>s.kind==='interaction'&&s.constraints.sessionId===e.sessionId&&s.constraints.allow?.includes('message')))return failure(e,'AUTHORIZATION_REQUIRED','缺少当前会话的交互授权。');
      const expiresAt=new Date(Math.min(Date.parse(e.body.expiresAt),Date.parse(grant.expiresAt))).toISOString();
      if(Date.parse(expiresAt)<=Date.now())return failure(e,'GRANT_EXPIRED','交互授权已过期。');
      row={owner,subjectRef:e.body.subjectRef,grantId:grant.id,grantRevision:grant.revision,allowActions:grant.scopes.some(s=>s.kind==='interaction'&&s.constraints.allow?.includes('action')),expiresAt,presentation:offer,document:offer.profile==='iframe'?this.document():null,revision:0,messages:[],preferences:{},title:e.body.context.purpose.slice(0,70),operations:{},closed:false};
    }else{
      if(!row)return failure(e,'SESSION_NOT_FOUND','购物会话不存在。');
      if(row.closed)return failure(e,'SESSION_CLOSED','购物会话已经结束。');
      if(e.expectedRevision!==row.revision)return failure(e,'REVISION_CONFLICT','页面已更新，请恢复核对。',true);
      if(e.body.grantRevision!==row.grantRevision)return failure(e,'AUTHORIZATION_REQUIRED','交互授权版本不匹配。');
      if(e.op!=='close'&&Date.parse(row.expiresAt)<=Date.now())return failure(e,'GRANT_EXPIRED','交互授权已过期。');
    }
    let message,answer;
    if(e.op==='open'){
      message=e.body.context.purpose;
      if(message.length>4000)return failure(e,'INVALID_INPUT','任务说明不能超过 4000 字。');
    }
    if(e.op==='input'){
      const input=e.body.input;
      if(input.type==='message'){if(input.resourceRefs.length)return failure(e,'UNSUPPORTED_CAPABILITY','本工作区只接收文字需求。');message=input.text;}
      else{
        if(!row.allowActions)return failure(e,'AUTHORIZATION_REQUIRED','当前授权不允许表单操作。');
        const question=row.messages.filter(m=>m.role==='assistant').at(-1)?.result?.question;
        if(input.actionId!=='shopping.answer'||!question)return failure(e,'UNKNOWN_ACTION','当前问卷已经失效。');
        answer=input.arguments;
        if(Object.keys(answer).some(k=>!['questionId','value'].includes(k))||answer.questionId!==question.id||typeof answer.value!=='string'||!answer.value.trim()||answer.value.length>1000)return failure(e,'INVALID_INPUT','问卷答案格式不正确。');
        message=answer.value;
      }
      if(typeof message!=='string'||!message.trim()||message.length>4000)return failure(e,'INVALID_INPUT','购物需求需为 1–4000 字。');
    }
    if(e.op==='close' && e.body.workPolicy!=='cancel')return failure(e,'UNSUPPORTED_CAPABILITY','本工作区仅支持结束并取消。');
    if(e.op!=='close' && Object.values(row.operations).some(o=>!o.result))return failure(e,'RESULT_UNCERTAIN','上次操作尚无法确认，请结束本次会话。');
    row.operations[e.requestId]={fingerprint,result:null};this.save(owner,e.sessionId,row);
    this.running.set(key,true);
    try{
      if(e.op==='close'){
        row.revision++;row.closed=true;
        const items=row.messages.flatMap(m=>m.result?.items||[]).filter((p,i,a)=>a.findIndex(q=>q.id===p.id)===i);
        row.handoff={summary:`本次购物需求：${row.title}。已整理 ${items.length} 件候选商品：${items.map(p=>p.title).join('、')||'尚未选定'}。未进行下单或付款。`,artifacts:[],unresolved:items.length?['成交价格、规格与库存需在商品平台确认。']:['尚未选定商品。'],workDisposition:{policy:'cancel',confirmed:true,activeTasks:[]}};
      }else{
        const result=await this.chat({sessionId:e.sessionId,message,answer,sharedContext:e.op==='open'?e.body.context.messages:undefined},{owner:scopedId(owner,row.subjectRef)});
        row.messages.push({role:'user',text:message},{role:'assistant',result});row.preferences=result.preferences||row.preferences;row.revision++;
      }
      // Record the receipt before building the snapshot so its operation list is final.
      row.operations[e.requestId].result={};
      const result=e.op==='close'?response(e,'closed',{revision:row.revision,handoff:row.handoff}):this.snapshot(e,row);
      if(!validateEnvelope(result))throw Error('Invalid response envelope');
      row.operations[e.requestId].result=result;this.save(owner,e.sessionId,row);return result;
    }catch{
      // The write-ahead marker remains unresolved: never blindly replay an uncertain model call.
      return failure(e,'RESULT_UNCERTAIN','本轮处理未能确认完成，请恢复核对或结束会话。');
    }finally{this.running.delete(key);}
  }
}
