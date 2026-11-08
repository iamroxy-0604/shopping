(() => {
  'use strict';
  const root = document.getElementById('app');
  const embedded = window.parent !== window;
  document.body.classList.toggle('embedded', embedded);
  const demo = !embedded && new URLSearchParams(location.search).get('demo') === '1';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
  const uid = () => crypto.randomUUID();
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const save = (key, value) => { if (!embedded && !demo) try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const asset = name => window.SHOPPING_ASSETS?.[name] || `/desktop/assets/${name}`;
  const icon = name => `<img class="icon" src="${escape(asset(name + '.svg'))}" alt="">`;
  let browserUserId;
  try { browserUserId=localStorage.getItem('shiguang-flow-user-v1') || 'user-'+uid(); if(!embedded&&!demo)localStorage.setItem('shiguang-flow-user-v1',browserUserId); } catch { browserUserId='user-'+uid(); }
  let sessions = read('shiguang.desktop.sessions', []);
  if(!embedded&&!demo){
    const old=read('shiguang-flow-conversations-v1',{});
    for(const [id,record] of Object.entries(old)){
      if(sessions.some(x=>x.id===id)||!Array.isArray(record.messages))continue;
      sessions.push({id,legacySession:true,title:record.title||'之前的购物会话',messages:record.messages.map(m=>m.role==='user'?{role:'user',text:m.content}:{role:'assistant',result:m.content}),draft:'',busy:false,pending:false,error:'',phase:'open',revision:0,preferences:{}});
    }
  }
  let favorites = (embedded || demo) ? [] : read('shiguang.desktop.favorites', []).filter(p => !p.demoAsset);
  let state = {id:uid(), messages:[], draft:'', busy:false, pending:false, error:'', revision:0, phase:'open', preferences:{}, title:'我的购物会话'};
  if(!embedded&&!demo){const current=read('shiguang.desktop.current',null);const record=sessions.find(s=>s.id===current);if(record)state={...state,...record,busy:false,pending:false,error:''};}
  let port, nonce, hostSession, requestTimer;
  const pending = new Map();
  const products = () => state.messages.flatMap(m => [...(m.result?.items || []),...(m.result?.candidateItems || [])]).filter((p, i, all) => all.findIndex(q => q.id === p.id) === i);
  const money = p => typeof p.price === 'number' && Number.isFinite(p.price) ? `<small>¥</small>${escape(p.price)}` : '<small>价格待核实</small>';
  const source = p => p.shopName || (typeof p.source === 'string' ? ({taobao:'淘宝',demo:'演示商品'}[p.source] || p.source) : p.source?.platform) || '来源待核实';
  function persist() {
    if (embedded || demo || !state.messages.length) return;
    const record = {...state, busy:false, error:'', pending:false};
    sessions = [record, ...sessions.filter(s => s.id !== state.id)].slice(0, 20);
    save('shiguang.desktop.sessions', sessions); save('shiguang.desktop.current',state.id);
  }
  function capture() { const field = document.getElementById('message'); if (field) state.draft = field.value; }
  function card(p) {
    const saved = favorites.some(f => f.id === p.id);
    const img = safeUrl(p.imageUrl) || (/^\/desktop\/assets\//.test(p.imageUrl || '') ? p.imageUrl : '') || (p.demoAsset ? asset(p.demoAsset) : '');
    return `<article class="product"><button class="favorite" data-save="${escape(p.id)}" aria-label="${saved?'取消收藏':'收藏'} ${escape(p.title)}" aria-pressed="${saved}">${saved?'♥':'♡'}</button>${img ? `<img class="product-image" src="${escape(img)}" alt="${escape(p.title)}" loading="lazy">` : '<div class="product-image" aria-label="暂无商品图片"></div>'}<div class="product-info"><h3>${escape(p.title)}</h3><p class="product-reason">${escape(p.recommendation || p.matchReasons?.join(' · ') || '点击查看已有商品信息')}</p><div class="price-row"><span class="price">${money(p)}</span><button class="product-detail" data-product="${escape(p.id)}">查看详情 ↗</button></div><p class="source">${escape(source(p))}</p></div></article>`;
  }
  function turn(m, index) {
    if (m.role === 'user') return `<div class="user-message"><p>${escape(m.text)}</p></div>`;
    const r = m.result || {};
    const latest = index === state.messages.length - 1 && state.phase === 'open' && !state.busy && !state.pending;
    return `<div class="agent-row"><span class="avatar">✳</span><div class="agent-content"><div class="byline">拾光 · AI 导购</div><div class="answer">${escape(r.message || r.error?.message || '已更新本次购物结果。')}</div>${r.question ? `<section class="question"><p class="byline">${r.question.step&&r.question.total?'第 '+escape(r.question.step)+' / '+escape(r.question.total)+' 题 · ':''}也可以在下方输入框补充自己的答案</p><h3>${escape(r.question.title)}</h3><div class="options">${(r.question.options || []).map(o => {const value = typeof o === 'string' ? o : o.value || o.label; return `<button class="chip" data-answer="${escape(value)}" data-question="${escape(r.question.id)}" ${latest?'':'disabled'}>${escape(typeof o==='string'?o:o.label)}</button>`;}).join('')}</div></section>`:''}</div></div>${r.items?.length ? `<div class="product-grid">${r.items.map(card).join('')}</div><p class="note">${demo?'演示商品与价格，仅用于体验界面。':'商品与价格来自检索结果，成交价、规格和库存以商品页为准。'}</p>`:''}${r.summary ? `<div class="agent-row"><span class="avatar">·</span><div class="answer">${escape(typeof r.summary === 'string' ? r.summary : r.summary.text || r.summary.conclusion || '')}</div></div>`:''}${r.followUp ? `<div class="agent-row"><span class="avatar">·</span><div class="answer">${escape(r.followUp)}</div></div>`:''}${r.candidateItems?.length?`<p class="note">已找到的候选商品已保留，AI 推荐分析尚未完成。</p><div class="product-grid">${r.candidateItems.map(card).join('')}</div>`:''}${latest&&r.error?.code==='NARRATIVE_UNAVAILABLE'?'<div class="suggestions"><button class="outline" data-prompt="重试生成推荐">重试生成推荐</button></div>':''}${latest && r.followups?.length ? `<div class="suggestions">${r.followups.map(s => `<button class="chip" data-prompt="${escape(s)}">${escape(s)} ↗</button>`).join('')}</div>`:''}`;
  }
  function render() {
    const locked = state.busy || state.pending || state.phase !== 'open' || (embedded && !port);
    const prefs = Object.entries(state.preferences || {}).filter(([k,v]) => ['category','style','maxPrice','material','color'].includes(k) && v != null);
    const history = sessions.filter(s=>s.id!==state.id).slice(0,12);
    const historyMarkup = history.length ? history.map(s=>`<button class="history-link" data-session="${escape(s.id)}">${escape(s.title||'购物会话')}</button>`).join('') : '<p class="history-empty">完成购物对话后，会显示在这里</p>';
    root.innerHTML = `<div class="app"><aside class="chat-sidebar"><div class="sidebar-brand"><img src="${asset('dingdang.png')}" alt=""><strong>拾光</strong></div><button class="new-chat" data-command="new"><span>＋</span>新建购物对话</button><div class="history-label">最近对话</div><nav class="history-list" aria-label="历史购物会话">${historyMarkup}</nav><div class="sidebar-footer"><button data-command="favorites">♡　收藏商品 <span>${favorites.length}</span></button><button class="sidebar-help" data-command="info">${embedded?'Dingdang 工作区':'购物智能体'}</button></div></aside><main class="main"><div class="workspace"><section class="conversation"><header class="section-head"><div><div class="eyebrow">${embedded?'DINGDANG · SHOPPING':'SHIGUANG · SHOPPING'}</div><h1>${escape(state.messages.length?state.title:'把喜欢的，慢慢挑出来')}</h1><p>${demo?'演示模式 · 示例商品':'AI 导购会先了解需求，再为你挑选商品'}</p></div><div class="head-actions"><button class="quiet" data-command="info">接入说明</button><button class="quiet" data-command="compare" ${products().length<2?'disabled':''}>比较候选 ↗</button></div></header><div class="feed" id="feed" aria-live="polite" aria-busy="${state.busy}">${state.messages.length?'<div class="timestamp">本次购物会话</div>'+state.messages.map(turn).join(''):`<section class="welcome"><div class="welcome-mark">✳</div><h2>今天，想为生活添点什么？</h2><p>告诉我预算、用途或喜欢的风格，<br>我们从需求问卷开始，慢慢挑到合适的商品。</p><div class="starter-list">${['帮我挑一盏 300 元以内的书桌台灯','适合军训的防晒霜','想找桌面收纳，喜欢简约风格'].map(s=>`<button class="starter" data-prompt="${s}"><span>${s}</span><span>↗</span></button>`).join('')}</div></section>`}${state.busy?'<div class="loading" role="status">正在理解需求、整理适合你的选择</div>':''}${state.error?`<div class="error" role="alert">${escape(state.error)}${state.pending?'<br><button class="outline" data-command="sync">恢复核对</button>':''}</div>`:''}${state.phase==='closed'?`<section class="handoff"><div class="eyebrow">SESSION COMPLETED</div><h2>这次的选择，替你记下了</h2><p>${escape(state.handoff || '购物会话已结束。')}</p><button class="outline standalone-only" data-command="new">开启新的购物会话</button></section>`:''}</div><form class="composer" id="composer"><div class="compose-row"><textarea id="message" aria-label="告诉拾光你的购物需求" placeholder="说说想买什么、预算或想继续了解的商品…" rows="2" maxlength="4000" ${locked?'disabled':''}>${escape(state.draft)}</textarea><button class="send" aria-label="发送消息" ${locked?'disabled':''}>↑</button></div><p class="compose-note">${embedded?'消息仅用于当前 Dingdang 购物会话':'AI 导购建议供选购参考 · Enter 发送'}</p></form></section></div></main></div>`;
    root.querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>{img.style.visibility='hidden';},{once:true}));
    root.querySelectorAll('[data-command]').forEach(b=>b.onclick=()=>command(b.dataset.command));
    root.querySelectorAll('[data-session]').forEach(b=>b.onclick=()=>{if(state.busy)return;persist();state=structuredClone(sessions.find(s=>s.id===b.dataset.session));render();scroll();});
    root.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>send(b.dataset.prompt));
    root.querySelectorAll('[data-answer]').forEach(b=>b.onclick=()=>send(b.dataset.answer,{questionId:b.dataset.question,value:b.dataset.answer}));
    root.querySelectorAll('[data-product]').forEach(b=>b.onclick=()=>detail(b.dataset.product));
    root.querySelectorAll('[data-save]').forEach(b=>b.onclick=()=>{capture();const p=products().find(p=>p.id===b.dataset.save)||favorites.find(p=>p.id===b.dataset.save); favorites=favorites.some(f=>f.id===p.id)?favorites.filter(f=>f.id!==p.id):[...favorites,p];save('shiguang.desktop.favorites',favorites);render();});
    document.getElementById('composer').onsubmit=e=>{e.preventDefault();capture();send(state.draft);};
    document.getElementById('message').oninput=e=>{state.draft=e.target.value;persist();};
    document.getElementById('message').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();capture();send(state.draft);}};
  }
  function scroll() { const feed=document.getElementById('feed');feed.scrollTop=feed.scrollHeight; }
  function modal(title, html) {
    capture();document.querySelector('dialog')?.remove();const d=document.createElement('dialog');d.className='modal';d.innerHTML=`<header class="modal-head"><h2>${escape(title)}</h2><button class="quiet" aria-label="关闭">✕</button></header>${html}`;document.body.append(d);d.querySelector('.modal-head button').onclick=()=>d.close();d.onclose=()=>d.remove();d.showModal();return d;
  }
  function detail(id) {
    const p=products().find(p=>p.id===id)||favorites.find(p=>p.id===id);if(!p)return;
    const url=safeUrl(p.promotionUrl);const img=p.demoAsset?asset(p.demoAsset):safeUrl(p.imageUrl);
    const d=modal('看看这一件',`${img?`<img class="detail-image" src="${escape(img)}" alt="${escape(p.title)}">`:''}<p>${escape(p.title)}</p><div class="price">${money(p)}</div><p>${escape(p.recommendation || '商品规格、售后与库存请以原商品页为准。')}</p>${Object.entries(p.facts||{}).filter(([k,v])=>['material','color','dimensions','brand'].includes(k)&&v!=null).map(([k,v])=>`<p>${({material:'材质',color:'颜色',dimensions:'尺寸',brand:'品牌'})[k]}：${escape(typeof v==='object'?JSON.stringify(v):v)}</p>`).join('')}<p>${escape(source(p))}</p>${url?embedded?`<p>商品链接（可选中复制）：<br>${escape(url)}</p>`:`<a class="outline" href="${escape(url)}" target="_blank" rel="noopener noreferrer">去商品页 ↗</a>`:'<p>当前没有可用的购买链接。</p>'}<footer><button class="primary" id="ask-product">让 AI 帮我分析</button></footer>`);
    d.querySelector('#ask-product').onclick=()=>{d.close();send(`请分析“${p.title}”的推荐理由和需要确认的规格。`);};
  }
  function command(name) {
    capture();
    if(name==='new'){if(state.busy)return;persist();state={id:uid(),messages:[],draft:'',busy:false,pending:false,error:'',revision:0,phase:'open',preferences:{},title:'我的购物会话'};render();}
    if(name==='history'){const d=modal('最近的购物会话',sessions.length?sessions.map(s=>`<button class="history-item" data-session="${escape(s.id)}">${escape(s.title)}<small>${s.messages.length} 条消息</small></button>`).join(''):'<p>完成第一轮对话后，会在这里保留会话。演示模式不写入历史。</p>');d.querySelectorAll('[data-session]').forEach(b=>b.onclick=()=>{if(state.busy)return;persist();state=structuredClone(sessions.find(s=>s.id===b.dataset.session));d.close();render();});}
    if(name==='favorites'){const d=modal('我的收藏',favorites.length?favorites.map(p=>`<button class="history-item" data-detail="${escape(p.id)}">${escape(p.title)}<small>${typeof p.price==='number'?'¥'+p.price:'价格待核实'} · ${escape(source(p))}</small></button>`).join(''):'<p>点击商品右上角的爱心，就能把喜欢的商品留在这里。</p>');d.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>detail(b.dataset.detail));}
    if(name==='info')modal('关于这个工作区',`<p>${embedded?'当前工作区通过 Dingdang 的隔离通道交流。只接收本次主动共享的任务和消息，临时问叮当的内容不会自动传入。':'这是拾光的独立电脑端入口。部署到 Dingdang 后，同一套购物界面会出现在专属工作区中，由 DD 管理共享范围、会话恢复与交回。'}</p><p>${demo?'当前为演示模式，商品、价格和对话均为示例。':'本工作区仅提供商品推荐、需求澄清与导购，不执行下单或付款。'}</p>`);
    if(name==='compare')send('请比较刚才这些候选商品的价格、推荐理由，以及还需要确认的信息。');
    if(name==='sync')bridgeRequest('sync-request').then(adopt).catch(e=>{state.error=e.message;render();});
    if(name==='finish'){const d=modal('为这次购物收个尾', '<p>结束后将整理本次需求与候选商品。你可以在历史会话里查看结果。</p><footer><button class="primary" id="confirm-finish">确认结束</button></footer>');d.querySelector('#confirm-finish').onclick=()=>{d.close();if(embedded)bridgeRequest('close-request').catch(e=>{state.error=e.message;render();});else{state.phase='closed';state.handoff=`本次需求：${state.title}\n已整理 ${products().length} 件候选商品，收藏 ${favorites.length} 件。\n${products().map(p=>p.title).join('、') || '尚未选定商品，可在新会话继续挑选。'}\n未进行下单或付款。`;persist();render();scroll();}};}
  }
  const demoProducts=[{id:'demo-storage',title:'原木桌面收纳盒',price:89,demoAsset:'storage.png',recommendation:'让零碎小物各归其位，桌面更清爽',source:'demo'},{id:'demo-lamp',title:'奶油白柔光台灯',price:159,demoAsset:'lamp.png',recommendation:'简约轮廓，给工作角落一点温柔',source:'demo'},{id:'demo-tray',title:'奶油白桌面托盘',price:49,demoAsset:'tray.png',recommendation:'钥匙与随身小物，有一个固定的位置',source:'demo'}];
  async function send(text, answer) {
    if(!text?.trim()||state.busy||state.pending||state.phase!=='open'||(embedded&&!port))return;
    text=text.trim();state.busy=true;state.error='';state.draft='';render();
    try {
      if(embedded){adopt(await bridgeRequest('user-action',{revision:state.revision,input:answer?{type:'action',actionId:'shopping.answer',arguments:answer,contextRefs:['shopping.workspace']}:{type:'message',text,resourceRefs:[]}}));}
      else {
        let r;
        if(demo){await new Promise(resolve=>setTimeout(resolve,450));r={ok:true,type:'results',message:/比较/.test(text)?'演示比较：收纳盒用于整理小物，台灯用于补充桌面照明，托盘适合随手置物。三件用途不同，先按你的主要需求取舍。':'这是演示推荐：保留简约、温暖的桌面风格，挑了三件不同用途的小物。你可以查看详情、收藏，或继续比较。',items:demoProducts,followups:['比较这三件商品','把预算控制在 100 元以内'],preferences:{category:'桌面好物',style:'简约原木',maxPrice:300}};}
        else {const response=await fetch('/api/desktop/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:state.id,userId:browserUserId,legacySession:!!state.legacySession,message:text,answer}),signal:AbortSignal.timeout(340000)});r=await response.json();if(typeof r.ok!=='boolean')throw Error(r.error?.message||'导购服务暂时不可用，请稍后重试。');}
        if(!state.messages.length)state.title=text.slice(0,70);
        state.messages.push({role:'user',text},{role:'assistant',result:r});state.preferences=r.preferences||r.memory?.preferences||state.preferences;persist();
      }
    } catch(e){state.error=e.message||'连接中断，请稍后重试。';state.draft=text;}finally{state.busy=false;render();scroll();document.getElementById('message')?.focus();}
  }
  function adopt(payload) {
    if(!payload)return;
    const body=payload.snapshot?.body;
    if(body && body.revision>=state.revision){const view=body.content.surfaces.find(s=>s.surfaceId==='shopping.workspace')?.data?.state;if(view){state.messages=view.messages||[];state.preferences=view.preferences||{};state.title=view.title||state.title;}state.revision=body.revision;state.phase=body.lifecycle;state.handoff=body.handoff?.summary;}
    state.pending=!!payload.pending || !!body?.operations?.some(o=>['working','unknown'].includes(o.status));state.busy=!!payload.busy;state.error=payload.error?.message||(state.pending?'本轮结果尚待核对，请恢复会话后继续；若服务曾中断，请交回叮当后重新开始。':'');render();scroll();
  }
  function packet(type, extra={}){return {protocol:'dingdang.embed-bridge',version:'1',sessionId:hostSession,nonce,type,...extra};}
  function bridgeRequest(type, extra={}) {
    if(!port)return Promise.reject(Error('尚未连接 Dingdang。'));
    const requestId=uid();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);state.pending=true;reject(Error('等待宿主回复超时，请恢复核对后继续。'));},350000);pending.set(requestId,{resolve,reject,timer});port.postMessage(packet(type,{requestId,...extra}));});
  }
  if(embedded){
    const hostOrigin=document.querySelector('meta[name="dingdang-host-origin"]')?.content;
    window.addEventListener('message', event=>{
      const d=event.data;
      if(port||event.source!==parent||!hostOrigin||event.origin!==hostOrigin||d?.protocol!=='dingdang.embed-bridge'||d.version!=='1'||d.type!=='initialize'||!d.nonce||!d.sessionId||!event.ports[0])return;
      clearTimeout(requestTimer);port=event.ports[0];nonce=d.nonce;hostSession=d.sessionId;state.id=hostSession;
      port.onmessage=event=>{const m=event.data;if(m?.protocol!=='dingdang.embed-bridge'||m.version!=='1'||m.sessionId!==hostSession||m.nonce!==nonce)return;if(m.type==='context-update')adopt(m);if(m.type==='result'){const p=pending.get(m.requestId);if(p){clearTimeout(p.timer);pending.delete(m.requestId);m.error?p.reject(Error(m.error)):p.resolve(m.result);}}if(m.type==='dispose'){port.close();port=null;state.phase='closed';state.error='工作区已由 Dingdang 关闭。';for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('会话已关闭。'));}pending.clear();render();}};
      port.postMessage(packet('initialized'));adopt(d);
    });
    if(hostOrigin)parent.postMessage({protocol:'dingdang.embed-bridge',version:'1',type:'ready'},hostOrigin);
    requestTimer=setTimeout(()=>{if(!port){state.error='未能连接 Dingdang 宿主，请从原会话恢复工作区。';render();}},15000);
  }
  if(demo){state.title='300 元以内的简约桌面好物';state.preferences={category:'桌面好物',style:'简约原木',maxPrice:300};state.messages=[{role:'user',text:'想给桌面添点小物，300 元以内，喜欢简约温暖的风格。'},{role:'assistant',result:{message:'从收纳、光线和随手置物三个方向，选了这三件桌面小物。\n先看看哪一件更贴近你的需要，我们再慢慢缩小范围。',items:demoProducts,followups:['帮我比较一下','预算再低一点','看看哪件更实用']}}];}
  render();
})();
