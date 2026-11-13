(() => {
  'use strict';
  const root = document.getElementById('app');
  const embedded = window.parent !== window;
  document.body.classList.toggle('embedded', embedded);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
  const uid = () => crypto.randomUUID();
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const save = (key, value) => { if (!embedded) try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const asset = name => window.SHOPPING_ASSETS?.[name] || `/desktop/assets/${name}`;
  const icon = name => `<img class="icon" src="${escape(asset(name + '.svg'))}" alt="">`;
  let browserUserId;
  try { browserUserId=localStorage.getItem('shiguang-flow-user-v1') || 'user-'+uid(); if(!embedded)localStorage.setItem('shiguang-flow-user-v1',browserUserId); } catch { browserUserId='user-'+uid(); }
  let sessions = read('shiguang.desktop.sessions', []);
  if(!embedded){
    const old=read('shiguang-flow-conversations-v1',{});
    for(const [id,record] of Object.entries(old)){
      if(sessions.some(x=>x.id===id)||!Array.isArray(record.messages))continue;
      sessions.push({id,legacySession:true,title:record.title||'之前的购物会话',messages:record.messages.map(m=>m.role==='user'?{role:'user',text:m.content}:{role:'assistant',result:m.content}),draft:'',busy:false,pending:false,error:'',phase:'open',revision:0,preferences:{}});
    }
  }
  let favorites = embedded ? [] : read('shiguang.desktop.favorites', []).filter(p => !p.demoAsset);
  let state = {id:uid(), messages:[], draft:'', busy:false, pending:false, error:'', revision:0, phase:'open', preferences:{}, title:'我的购物会话'};
  if(!embedded){const current=read('shiguang.desktop.current',null);const record=sessions.find(s=>s.id===current);if(record)state={...state,...record,busy:false,pending:false,error:''};}
  let port, nonce, hostSession, requestTimer;
  const pending = new Map();
  const products = () => state.messages.flatMap(m => [...(m.result?.items || []),...(m.result?.candidateItems || [])]).filter((p, i, all) => all.findIndex(q => q.id === p.id) === i);
  const money = p => typeof p.price === 'number' && Number.isFinite(p.price) ? `<small>¥</small>${escape(p.price)}` : '<small>价格待核实</small>';
  const source = p => p.shopName || (typeof p.source === 'string' ? ({taobao:'淘宝',yuemai:'悦买',syh:'悦买'}[p.source] || p.source) : p.source?.platform) || '来源待核实';
  const productTags = p => {
    const title = String(p.title || '');
    const tags = [];
    const capacity = title.match(/(?:5000|10000|20000|30000|50000|100000)\s*(?:mAh|毫安)/i)?.[0];
    if (capacity) tags.push(capacity.replace(/\s+/g, ''));
    if (/自带双线/.test(title)) tags.push('自带双线');
    else if (/自带线/.test(title)) tags.push('自带线');
    const watts = title.match(/\d+W\s*快充/i)?.[0];
    if (watts) tags.push(watts.replace(/\s+/g, ''));
    else if (/快充/.test(title)) tags.push('快充');
    return [...new Set(tags)].slice(0, 2);
  };
  const emphasized = (value, phrases) => {
    const source = String(value || '');
    const ranges = [];
    [...new Set(Array.isArray(phrases) ? phrases : [])].filter(phrase=>typeof phrase==='string'&&phrase.length>=2&&phrase.length<=16).sort((a,b)=>b.length-a.length).forEach(phrase=>{
      const start=source.indexOf(phrase);
      if(start<0||ranges.some(range=>start<range.end&&start+phrase.length>range.start))return;
      ranges.push({start,end:start+phrase.length});
    });
    ranges.sort((a,b)=>a.start-b.start);
    let cursor=0;
    return ranges.map(range=>{const before=escape(source.slice(cursor,range.start));const strong=`<strong>${escape(source.slice(range.start,range.end))}</strong>`;cursor=range.end;return before+strong;}).join('')+escape(source.slice(cursor));
  };
  const preferenceName = key => ({category:'想买的',style:'风格',maxPrice:'预算',material:'材质',color:'颜色'})[key] || key;
  const stage = () => {
    if (state.pending) return '等待恢复核对';
    if (state.busy) return '正在整理候选';
    if (state.phase === 'closed') return '本次购物已完成';
    const result = [...state.messages].reverse().find(message => message.role === 'assistant')?.result;
    if (result?.question) return `正在补充需求 ${result.question.step || 1} / ${result.question.total || 1}`;
    if (products().length) return `已找到 ${products().length} 件候选`;
    return state.messages.length ? '正在了解你的需求' : '准备开始购物';
  };
  function persist() {
    if (embedded || !state.messages.length) return;
    const record = {...state, busy:false, error:'', pending:false};
    sessions = [record, ...sessions.filter(s => s.id !== state.id)].slice(0, 20);
    save('shiguang.desktop.sessions', sessions); save('shiguang.desktop.current',state.id);
  }
  function capture() { const field = document.getElementById('message'); if (field) state.draft = field.value; }
  function card(p, index = 0) {
    const saved = favorites.some(f => f.id === p.id);
    const img = safeUrl(p.imageUrl) || (/^\/desktop\/assets\//.test(p.imageUrl || '') ? p.imageUrl : '') || (p.demoAsset ? asset(p.demoAsset) : '');
    const tags = productTags(p);
    return `<article class="product"><div class="product-visual">${img ? `<img class="product-image" src="${escape(img)}" alt="${escape(p.title)}" loading="lazy">` : '<div class="product-image product-image-empty" aria-label="暂无商品图片">暂无图片</div>'}${index === 1 ? '<span class="balance-badge">更均衡</span>' : ''}</div><div class="product-info"><h3>${escape(p.title)}</h3>${tags.length?`<div class="product-tags">${tags.map(tag=>`<span>${escape(tag)}</span>`).join('')}</div>`:''}<div class="product-card-foot"><div><span class="price">${money(p)}</span><p class="source">${escape(source(p))}</p></div><div class="product-actions"><button class="favorite ${saved?'saved':''}" data-save="${escape(p.id)}" aria-label="${saved?'取消收藏':'收藏'} ${escape(p.title)}" aria-pressed="${saved}">${saved?'已收藏':'收藏'}</button><button class="product-detail" data-product="${escape(p.id)}">查看详情 ${icon('arrow-up')}</button></div></div></div></article>`;
  }
  function turn(m, index) {
    if (m.role === 'user') return `<section class="message user"><div class="message-avatar">你</div><div class="bubble"><p>${escape(m.text)}</p></div></section>`;
    const r = m.result || {};
    const latest = index === state.messages.length - 1 && state.phase === 'open' && !state.busy && !state.pending;
    const assistant = `<section class="message assistant"><div class="message-avatar">拾光</div><div class="bubble"><strong>拾光导购</strong><p>${escape(r.message || r.error?.message || '已更新本次购物结果。')}</p></div></section>`;
    const question = r.question ? latest ? `<section class="question"><div class="question-top"><div class="question-count"><span>${escape(r.question.step||1)} / ${escape(r.question.total||1)}</span><div class="question-bars">${Array.from({length:Math.max(1,Number(r.question.total)||1)},(_,i)=>`<i class="${i < (Number(r.question.step)||1) ? 'active' : ''}"></i>`).join('')}</div></div><span class="question-kind">补充问卷</span></div><h3>${escape(r.question.title)}</h3><p class="question-hint">选择最符合你情况的一项，也可以在下方直接补充。</p><div class="options">${(r.question.options || []).map(o => {const value = typeof o === 'string' ? o : o.value || o.label; return `<button class="chip" data-answer="${escape(value)}" data-question="${escape(r.question.id)}">${escape(typeof o==='string'?o:o.label)}</button>`;}).join('')}</div></section>` : `<div class="answered-step">已完成第 ${escape(r.question.step||1)} 题</div>` : '';
    const results = r.items?.length ? `<section class="results-block"><div class="results-head"><div><h2>更贴近你需求的候选</h2><p>${r.items.length} 款商品，按你的使用场景精选。</p></div></div><div class="product-grid">${r.items.map((item,i)=>card(item,i)).join('')}</div><p class="note">商品与价格来自检索结果，成交价、规格和库存以商品页为准。</p></section>` : '';
    const summaryText = typeof r.summary === 'string' ? r.summary : r.summary?.text || r.summary?.conclusion || '';
    const analysis = summaryText ? `<section class="result-analysis"><div class="analysis-avatar">拾光</div><div class="analysis-panel"><div class="analysis-copy"><p>${emphasized(summaryText,r.emphasis)}</p>${r.items?.length?`<ul>${r.items.slice(0,2).map(item=>`<li>${escape(item.recommendation || item.matchReasons?.join('、') || '建议打开商品详情继续核对关键信息。')}</li>`).join('')}</ul>`:''}</div></div></section><div class="analysis-actions" aria-label="分析展示选项"><button type="button" aria-disabled="true">${icon('chevron-down')} 展开完整分析依据</button><i></i><button type="button" aria-disabled="true">${icon('refresh-cw')} 换个推荐逻辑</button></div><div class="evidence-bar"><p><b>判断依据：</b>本轮需求、问卷偏好与商品可核实信息</p><span>已对比 ${r.items?.length || 0} 款商品的核心差异</span>${icon('chevron-down')}</div>` : '';
    const followUp = r.followUp ? `<section class="followup-message"><div class="analysis-avatar">拾光</div><div class="followup-bubble">${escape(r.followUp)}</div></section>` : '';
    const candidates = r.candidateItems?.length ? `<section class="results-block"><p class="note">已保留候选商品，AI 推荐分析暂未完成。</p><div class="product-grid">${r.candidateItems.map(card).join('')}</div></section>` : '';
    const retry = latest&&r.error?.code==='NARRATIVE_UNAVAILABLE'?'<div class="suggestions"><button class="outline" data-prompt="重试生成推荐">重试生成推荐</button></div>':'';
    const suggestions = latest && r.followups?.length ? `<div class="suggestions">${r.followups.map(s => `<button class="chip" data-prompt="${escape(s)}">${escape(s)}</button>`).join('')}</div>`:'';
    return assistant + question + results + analysis + followUp + candidates + retry + suggestions;
  }
  function render() {
    const locked = state.busy || state.pending || state.phase !== 'open' || (embedded && !port);
    const prefs = Object.entries(state.preferences || {}).filter(([k,v]) => ['category','style','maxPrice','material','color'].includes(k) && v != null);
    const history = sessions.filter(s=>s.id!==state.id).slice(0,12);
    const historyMarkup = history.length ? history.map(s=>`<button class="history-link" data-session="${escape(s.id)}">${escape(s.title||'购物会话')}</button>`).join('') : '<p class="history-empty">完成购物对话后，会显示在这里</p>';
    const preferences = prefs.length ? prefs.map(([key,value])=>`<span class="context-chip"><b>${escape(preferenceName(key))}</b>${escape(typeof value === 'object' ? JSON.stringify(value) : value)}</span>`).join('') : '<span class="context-empty">回答问卷后显示在这里</span>';
    const category = state.preferences?.category ? `<span class="context-chip">${escape(state.preferences.category)}</span>` : '<span class="context-empty">还没有确定品类</span>';
    const empty = `<section class="welcome"><div class="welcome-mark">拾光</div><h2>今天，想为生活添点什么？</h2><p>告诉我预算、用途或喜欢的风格，我们从需求问卷开始，慢慢挑到合适的商品。</p><div class="starter-list">${['帮我挑一盏 300 元以内的书桌台灯','适合军训的防晒霜','想找桌面收纳，喜欢简约风格'].map(s=>`<button class="starter" data-prompt="${s}"><span>${s}</span><span>开始</span></button>`).join('')}</div></section>`;
    const busy = state.busy ? '<div class="loading" role="status"><span></span><span></span><span></span><p>正在理解需求、整理适合你的选择</p></div>' : '';
    const error = state.error ? `<div class="error" role="alert"><strong>暂时没有完成这一步</strong><p>${escape(state.error)}</p>${state.pending?'<button class="outline" data-command="sync">恢复核对</button>':''}</div>` : '';
    const handoff = state.phase==='closed' ? `<section class="handoff"><h2>这次的选择，替你记下了</h2><p>${escape(state.handoff || '购物会话已结束。')}</p><button class="outline standalone-only" data-command="new">开启新的购物会话</button></section>` : '';
    root.innerHTML = `<div class="app">
      <aside class="chat-sidebar" aria-label="会话导航">
        <div class="sidebar-brand"><img src="${asset('dingdang.png')}" alt=""><strong>拾光</strong></div>
        <button class="new-chat" data-command="new"><span>＋</span>新增对话</button>
        <div class="history-label">最近对话</div>
        <nav class="history-list" aria-label="历史购物会话"><button class="history-link active">${escape(state.title || '当前购物会话')}</button>${historyMarkup}</nav>
        <div class="sidebar-footer"><button data-command="favorites">收藏的商品 <span>${favorites.length}</span></button><button class="sidebar-help" data-command="info">${embedded?'Dingdang 工作区':'购物智能体'}</button></div>
      </aside>
      <main class="main">
        <div class="workspace">
          <section class="conversation">
            <header class="section-head"><div><p class="eyebrow">${embedded?'DINGDANG · SHOPPING':'SHIGUANG · SHOPPING COMPANION'}</p><h1>${escape(state.messages.length?state.title:'把喜欢的，慢慢挑出来')}</h1><p>告诉我想买什么，剩下的我们一起挑。</p></div><div class="head-actions"><span class="stage">${escape(stage())}</span><button class="quiet" data-command="compare" ${products().length<2?'disabled':''}>比较候选</button></div></header>
            <div class="feed" id="feed" aria-live="polite" aria-busy="${state.busy}">${state.messages.length?state.messages.map(turn).join(''):empty}${busy}${error}${handoff}</div>
            <form class="composer" id="composer"><div class="compose-row"><textarea id="message" aria-label="告诉拾光你的购物需求" placeholder="说说想买什么、预算，或问问刚才那件商品..." rows="2" maxlength="4000" ${locked?'disabled':''}>${escape(state.draft)}</textarea><button class="send" aria-label="发送消息" ${locked?'disabled':''}>${icon('arrow-up')}</button></div><p class="compose-note">${embedded?'消息仅用于当前 Dingdang 购物会话':'AI 导购建议仅供选购参考，Enter 发送'}</p></form>
          </section>
          <aside class="context" aria-label="购物上下文">
            <p class="context-kicker">YOUR SHOPPING CONTEXT</p><h2>这次，按你的心意挑</h2><p class="context-lead">在对话里补充偏好，我会用它们继续缩小选择范围。</p>
            <section class="context-section"><h3>想买的</h3><div class="context-chips">${category}</div></section>
            <section class="context-section"><h3>已经确认</h3><div class="context-chips">${preferences}</div></section>
            <section class="context-section"><h3>本次候选</h3><div class="context-row"><span>已找到</span><b>${products().length} 件商品</b></div><div class="context-row"><span>已收藏</span><b>${favorites.length} 件商品</b></div><button class="favorite-box" data-command="favorites">我的收藏<span>保存在当前浏览器，随时回来继续</span></button></section>
            <section class="context-section"><h3>选择依据</h3><p class="context-copy">这里会记录本次需求、问卷偏好、候选商品和收藏，方便继续缩小选择范围。</p></section>
          </aside>
        </div>
      </main>
    </div>`;
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
  function scroll(behavior = 'smooth') {
    requestAnimationFrame(()=>requestAnimationFrame(()=>window.scrollTo({top:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight),behavior})));
  }
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
    if(name==='history'){const d=modal('最近的购物会话',sessions.length?sessions.map(s=>`<button class="history-item" data-session="${escape(s.id)}">${escape(s.title)}<small>${s.messages.length} 条消息</small></button>`).join(''):'<p>完成第一轮对话后，会在这里保留会话。</p>');d.querySelectorAll('[data-session]').forEach(b=>b.onclick=()=>{if(state.busy)return;persist();state=structuredClone(sessions.find(s=>s.id===b.dataset.session));d.close();render();});}
    if(name==='favorites'){const d=modal('我的收藏',favorites.length?favorites.map(p=>`<button class="history-item" data-detail="${escape(p.id)}">${escape(p.title)}<small>${typeof p.price==='number'?'¥'+p.price:'价格待核实'} · ${escape(source(p))}</small></button>`).join(''):'<p>点击商品右上角的爱心，就能把喜欢的商品留在这里。</p>');d.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>detail(b.dataset.detail));}
    if(name==='info')modal('关于这个工作区',`<p>${embedded?'当前工作区通过 Dingdang 的隔离通道交流。只接收本次主动共享的任务和消息，临时问叮当的内容不会自动传入。':'这是拾光的独立电脑端入口。部署到 Dingdang 后，同一套购物界面会出现在专属工作区中，由 DD 管理共享范围、会话恢复与交回。'}</p><p>本工作区仅提供商品推荐、需求澄清与导购，不执行下单或付款。</p>`);
    if(name==='compare')send('请比较刚才这些候选商品的价格、推荐理由，以及还需要确认的信息。');
    if(name==='sync')bridgeRequest('sync-request').then(adopt).catch(e=>{state.error=e.message;render();});
    if(name==='finish'){const d=modal('为这次购物收个尾', '<p>结束后将整理本次需求与候选商品。你可以在历史会话里查看结果。</p><footer><button class="primary" id="confirm-finish">确认结束</button></footer>');d.querySelector('#confirm-finish').onclick=()=>{d.close();if(embedded)bridgeRequest('close-request').catch(e=>{state.error=e.message;render();});else{state.phase='closed';state.handoff=`本次需求：${state.title}\n已整理 ${products().length} 件候选商品，收藏 ${favorites.length} 件。\n${products().map(p=>p.title).join('、') || '尚未选定商品，可在新会话继续挑选。'}\n未进行下单或付款。`;persist();render();scroll();}};}
  }
  async function send(text, answer) {
    if(!text?.trim()||state.busy||state.pending||state.phase!=='open'||(embedded&&!port))return;
    text=text.trim();state.busy=true;state.error='';state.draft='';render();scroll();
    try {
      if(embedded){adopt(await bridgeRequest('user-action',{revision:state.revision,input:answer?{type:'action',actionId:'shopping.answer',arguments:answer,contextRefs:['shopping.workspace']}:{type:'message',text,resourceRefs:[]}}));}
      else {
        const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:state.id,userId:browserUserId,message:text,answer}),signal:AbortSignal.timeout(250000)});const r=await response.json();if(typeof r.ok!=='boolean')throw Error(r.error?.message||'导购服务暂时不可用，请稍后重试。');
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
  render();
  if (state.messages.length) scroll('auto');
})();
