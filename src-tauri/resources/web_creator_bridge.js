(() => {
  // A small, provider-agnostic media bridge for the embedded creator view.
  // It intentionally avoids a root-level hot MutationObserver and periodic
  // full-document scans so the main C.le. window stays responsive.
  if (window.__CLE_WEB_CREATOR_BRIDGE__) return;

  const platform = String(window.__CLE_WEB_CREATOR_PLATFORM__ || 'unknown');
  const assets = new Map();
  const xyqResolved = new Set();

  const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);
  const mediaKind = (value) => {
    const lower = String(value).toLowerCase();
    if (/\.(?:mp4|webm|mov|m3u8)(?:[?#]|$)/.test(lower) || /(?:video|play|stream|media)/.test(lower)) return 'video';
    if (/\.(?:png|jpe?g|webp|gif|avif)(?:[?#]|$)/.test(lower) || /(?:image|img|picture|photo)/.test(lower)) return 'image';
    return null;
  };
  const cleanUrl = (value) => {
    if (!isHttpUrl(value)) return value;
    try {
      const url = new URL(value);
      if (platform === 'doubao') {
        url.searchParams.set('watermark', '0');
        if (url.searchParams.has('lr')) url.searchParams.set('lr', 'video_gen_no_watermark');
        if (url.searchParams.has('logo_type')) url.searchParams.set('logo_type', 'video_gen_no_watermark');
        url.searchParams.delete('logo');
      } else if (platform === 'douyin') {
        url.pathname = url.pathname.replace(/playwm/gi, 'play');
        url.searchParams.delete('watermark');
      } else if (platform === 'jimeng') {
        ['watermark', 'display_watermark_busi_user', 'logo_type', 'l', 'cd', 'cs', 'ds', 'ft'].forEach((key) => url.searchParams.delete(key));
      } else if (platform === 'xiaoyunque') {
        url.searchParams.delete('watermark');
        url.searchParams.delete('logo_type');
      }
      return url.toString();
    } catch (_) {
      return value;
    }
  };
  const add = (raw, kind, source, title) => {
    if (!isHttpUrl(raw)) return;
    const url = String(raw).replace(/["'<>\s]+$/g, '');
    const detected = kind || mediaKind(url);
    if (!detected) return;
    const normalized = cleanUrl(url);
    const key = normalized || url;
    assets.set(key, {
      id: `${detected}:${key}`,
      url,
      cleanUrl: normalized,
      kind: detected,
      source: source || 'page',
      title: String(title || document.title || platform).slice(0, 160),
      platform,
      discoveredAt: Date.now(),
    });
    if (assets.size > 240) assets.delete(assets.keys().next().value);
  };
  const decodeDoubaoUrl = (value) => {
    if (typeof value !== 'string' || value.length < 32 || value.length > 12000 || !/^[A-Za-z0-9+/=_-]+$/.test(value)) return null;
    try {
      let decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
      if (/^https?:\/\//i.test(decoded)) return decoded;
      decoded = atob(decoded);
      return /^https?:\/\//i.test(decoded) ? decoded : null;
    } catch (_) { return null; }
  };
  const resolveXyqOriginal = (draftKey, renderTaskId, title) => {
    if (platform !== 'xiaoyunque' || !draftKey || !renderTaskId || xyqResolved.size >= 30) return;
    const key = `${draftKey}:${renderTaskId}`;
    if (xyqResolved.has(key)) return;
    xyqResolved.add(key);
    window.setTimeout(async () => {
      try {
        const response = await fetch('https://xyq.jianying.com/api/biz/v1/editor/get_package_info', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ draft_key: draftKey, package_id: '', render_task_id: renderTaskId, entrance_from: 'web' }),
        });
        const data = await response.json();
        const url = data?.data?.package_info?.package_origin?.segment_materials?.[0]?.videos?.[0]?.url;
        add(url, 'video', 'package_origin', title || '小云雀无水印视频');
      } catch (_) { /* a failed original lookup leaves the captured display URL available */ }
    }, 0);
  };
  const walk = (value, depth = 0) => {
    if (depth > 5 || value == null) return;
    if (typeof value === 'string') {
      if (isHttpUrl(value)) add(value, null, 'network');
      // Some providers return JSON encoded inside a string.
      if (value.length < 500000 && /^[\[{]/.test(value.trim())) {
        try { walk(JSON.parse(value), depth + 1); } catch (_) { /* not JSON */ }
      }
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 160)) walk(item, depth + 1);
      return;
    }
    if (platform === 'xiaoyunque') {
      const video = value.video && typeof value.video === 'object' ? value.video : value;
      resolveXyqOriginal(video.draft_key, video.render_task_id, video.prompt);
    }
    for (const [key, item] of Object.entries(value).slice(0, 180)) {
      if (typeof item === 'string' && isHttpUrl(item)) add(item, mediaKind(item), key, document.title);
      else if (platform === 'doubao' && typeof item === 'string' && /(?:main_?url|play_?url|video_?url)/i.test(key)) {
        const decoded = decodeDoubaoUrl(item);
        if (decoded) add(decoded, 'video', key, document.title);
      }
      else walk(item, depth + 1);
    }
  };
  const scanNode = (root) => {
    if (!root || !root.querySelectorAll) return;
    const nodes = root.matches?.('img,video,source,a') ? [root, ...root.querySelectorAll('img,video,source,a')] : [...root.querySelectorAll('img,video,source,a')];
    for (const node of nodes) {
      const url = node.currentSrc || node.src || node.href || node.getAttribute?.('data-src') || node.getAttribute?.('data-url');
      add(url, node.tagName === 'VIDEO' || node.tagName === 'SOURCE' ? 'video' : node.tagName === 'IMG' ? 'image' : null, 'dom', node.alt || node.title || document.title);
    }
  };
  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async (...args) => {
      const response = await originalFetch.apply(window, args);
      try {
        const type = response.headers.get('content-type') || '';
        const length = Number(response.headers.get('content-length') || 0);
        if (/json|text|javascript/i.test(type) && (!length || length <= 2_000_000)) response.clone().text().then((text) => { if (text.length > 2_000_000) return; try { walk(JSON.parse(text)); } catch (_) { walk(text); } }).catch(() => {});
      } catch (_) { /* provider fetch can be opaque */ }
      return response;
    };
  }
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__cleCreatorUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', () => {
      try {
        if (typeof this.response === 'object') walk(this.response);
        else if (typeof this.responseText === 'string') { try { walk(JSON.parse(this.responseText)); } catch (_) { walk(this.responseText); } }
      } catch (_) { /* ignored */ }
    }, { once: true });
    return originalSend.apply(this, args);
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) scanNode(node);
  });
  const start = () => {
    scanNode(document.body);
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.__CLE_WEB_CREATOR_BRIDGE__ = {
    platform,
    assets: () => Array.from(assets.values()).sort((a, b) => b.discoveredAt - a.discoveredAt).slice(0, 60),
    clear: () => assets.clear(),
    rescan: () => { scanNode(document.body); return assets.size; },
  };
})();
