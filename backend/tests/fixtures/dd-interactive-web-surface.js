// Generic renderer boundary. Business markup, style, and local interaction belong to the Partner.
export function createWebSurface({sessionId, document:sourceDocument, name, node, dispatch, closeRequest, notify}) {
  const element = node('div', 'is-feed is-web-frame-holder');
  const frame = node('iframe', 'is-agent-frame');
  frame.title = `${name}专属工作区`; frame.setAttribute('sandbox', 'allow-scripts allow-forms');
  frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'");
  const status = node('p', 'is-frame-status', '正在载入智能体自己的界面…'); status.setAttribute('role', 'status');
  element.append(status, frame);
  let port = null, nonce = '', disposed = false, state = null, timer;
  const packet = (type, extra={}) => ({protocol:'dingdang.embed-bridge', version:'1', sessionId, nonce, type, ...extra});
  const fallback = node('details', 'is-frame-fallback'); fallback.append(node('summary','','查看智能体文字版'));
  const text = node('p'); fallback.append(text); element.append(fallback);
  const update = value => { state = value; text.textContent = (value.snapshot?.body.content.messages || []).map(m=>m.text).join('\n'); if (port) port.postMessage(packet('context-update', value)); };
  const ready = event => {
    if (disposed || event.source !== frame.contentWindow || event.origin !== 'null'
        || event.data?.protocol !== 'dingdang.embed-bridge' || event.data?.version !== '1' || event.data?.type !== 'ready') return;
    port?.close(); const channel = new MessageChannel(); port = channel.port1; nonce = crypto.randomUUID();
    port.onmessage = async event => {
      const data = event.data;
      if (disposed || !data || data.protocol !== 'dingdang.embed-bridge' || data.version !== '1'
          || data.sessionId !== sessionId || data.nonce !== nonce) return;
      if (data.type === 'initialized') { clearTimeout(timer); status.hidden = true; return; }
      if (!['user-action','sync-request','close-request'].includes(data.type)
          || typeof data.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.requestId)) return;
      try {
        if (data.type === 'close-request') { closeRequest(); port?.postMessage(packet('result', {requestId:data.requestId, result:null})); return; }
        if (data.type === 'user-action' && (!data.input || !['message','action'].includes(data.input.type))) throw Error('不支持的工作区操作');
        const result = await dispatch(data.type === 'sync-request' ? 'sync' : 'input', data);
        if (!disposed) port?.postMessage(packet('result', {requestId:data.requestId,
          result:result ? {snapshot:result.snapshot, phase:result.phase, pending:result.pending, error:result.error} : null}));
      } catch (error) { if (!disposed) port?.postMessage(packet('result', {requestId:data.requestId, error:error.message})); }
    };
    frame.contentWindow.postMessage(packet('initialize', state || {}), '*', [channel.port2]);
  };
  window.addEventListener('message', ready);
  timer = setTimeout(() => { status.textContent = '智能体界面暂未就绪，可恢复核对或查看文字版；请勿重复提交。'; notify(status.textContent); }, 15000);
  const doc = new DOMParser().parseFromString(sourceDocument.html, 'text/html');
  // Active assets arrive over the same verified Partner response; no external script URLs.
  doc.querySelectorAll('script,link,base,meta,iframe,object,embed').forEach(n => n.remove());
  const scriptNonce = crypto.randomUUID();
  const csp = doc.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy';
  csp.content = `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline'; img-src https: data:; connect-src 'none'; font-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
  const origin = doc.createElement('meta'); origin.name = 'dingdang-host-origin'; origin.content = location.origin;
  const style = doc.createElement('style'); style.textContent = sourceDocument.css.replace(/<\/style/gi, '<\\/style');
  const script = doc.createElement('script'); script.setAttribute('nonce',scriptNonce); script.textContent = sourceDocument.script.replace(/<\/script/gi, '<\\/script');
  doc.head.prepend(csp, origin); doc.head.append(style); doc.body.append(script);
  frame.srcdoc = '<!doctype html>' + doc.documentElement.outerHTML;
  return {element, update, dispose() { disposed = true; clearTimeout(timer); port?.postMessage(packet('dispose')); port?.close(); window.removeEventListener('message',ready); element.remove(); }};
}
