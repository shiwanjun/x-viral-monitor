// Isolated-world bridge: forwards only normalized records and commands.
(() => {
  'use strict';
  if (window.__xvmLibraryBridgeLoaded) return;
  window.__xvmLibraryBridgeLoaded = true;
  const FORWARD = new Set([
    'XVM_LIBRARY_CAPTURE_BATCH', 'XVM_LIBRARY_SOURCE_REMOVED', 'XVM_LIBRARY_TEMPLATE',
    'XVM_LIBRARY_SYNC_PROGRESS', 'XVM_LIBRARY_SYNC_COMPLETE', 'XVM_LIBRARY_PAGE_READY',
    'XVM_LIBRARY_X_ACTION_RESULT', 'XVM_LIBRARY_ERROR',
  ]);
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'x-tools-library-main' || !FORWARD.has(event.data.type)) return;
    try { chrome.runtime.sendMessage(event.data); } catch (_) {}
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'XVM_LIBRARY_SYNC_COMMAND' || message?.type === 'XVM_LIBRARY_X_ACTION_COMMAND') {
      window.postMessage({ ...message, source: 'x-tools-library-isolated' }, location.origin);
    }
  });
})();
