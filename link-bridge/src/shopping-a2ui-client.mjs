import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { A2uiSurface, basicCatalog } from '@a2ui/lit/v0_9';

const processors = new Map();

window.disposeShoppingA2ui = (key) => {
  if (key) {
    processors.get(key)?.dispose();
    processors.delete(key);
    return;
  }
  for (const processor of processors.values()) processor.dispose();
  processors.clear();
};

window.renderShoppingA2ui = async (host, presentation, key = presentation?.surfaceId || 'detail') => {
  window.disposeShoppingA2ui(key);
  if (!host || presentation?.protocol !== 'v0.9.1' || !Array.isArray(presentation.messages)) return false;
  try {
    const processor = new MessageProcessor([basicCatalog], (action) => {
      if (action.name === 'open_source' && /^https?:\/\//.test(presentation.sourceUrl || ''))
        window.open(presentation.sourceUrl, '_blank', 'noopener,noreferrer');
    });
    processor.processMessages(presentation.messages);
    processors.set(key, processor);
    const surface = processor.getSurface(presentation.surfaceId || 'link-preview');
    if (!surface) return false;
    const element = document.createElement('a2ui-surface');
    element.surface = surface;
    host.replaceChildren(element);
    await element.updateComplete;
    const shadow = element.shadowRoot;
    if (shadow) {
      shadow.addEventListener('error', (event) => {
        if (!(event.target instanceof HTMLImageElement)) return;
        const fallback = document.createElement('div');
        fallback.className = 'a2ui-image-fallback';
        fallback.textContent = '图片暂时无法显示，可打开原链接查看';
        event.target.replaceWith(fallback);
      }, true);
    }
    return true;
  } catch {
    window.disposeShoppingA2ui(key);
    return false;
  }
};

void A2uiSurface;
window.dispatchEvent(new Event('shopping-a2ui-ready'));
