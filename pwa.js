// Registers the service worker and offers "install as app" where the browser supports it.
(() => {
  function notice(message) {
    let status = document.getElementById('offlineStatus');
    if (!status) { status = document.createElement('p'); status.id = 'offlineStatus'; status.setAttribute('role', 'status'); status.style.cssText = 'margin:12px 24px;color:#475569;font:13px/1.6 system-ui'; document.body.append(status); }
    status.textContent = message;
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(registration => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => { if (!event.data.ready) notice('오프라인 준비가 일부 완료되지 않았습니다. 인터넷에 연결해 다시 열어주세요.'); channel.port1.close(); };
        registration.active?.postMessage('CACHE_STATUS', [channel.port2]);
      }).catch(() => notice('오프라인 앱을 준비하지 못했습니다. 현재는 인터넷 연결이 필요합니다.'));
    });
    addEventListener('offline', () => notice('오프라인입니다. 준비된 도구를 사용할 수 있습니다. 처음 쓰는 OCR 언어·엔진은 인터넷 연결이 필요합니다.'));
    addEventListener('online', () => { const status = document.getElementById('offlineStatus'); if (status) status.textContent = ''; });
  }
  let deferred = null;
  addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); deferred = event;
    const button = document.getElementById('installApp'); if (button) button.hidden = false;
  });
  addEventListener('appinstalled', () => { const button = document.getElementById('installApp'); if (button) button.hidden = true; deferred = null; });
  document.addEventListener('click', async event => {
    if (!event.target.closest('#installApp') || !deferred) return;
    deferred.prompt(); await deferred.userChoice.catch(() => {}); deferred = null;
    document.getElementById('installApp').hidden = true;
  });
})();
