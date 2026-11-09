// Registers the service worker and offers "install as app" where the browser supports it.
(() => {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
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
