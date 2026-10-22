// Runs in the page's MAIN world at document_start.
// Observes LeetCode's own submission-polling responses (/submissions/detail/<id>/check/)
// and forwards the final verdict to the isolated content script via window.postMessage.
// Only numeric ids are real submissions; "Run" test executions use runcode_* ids and are ignored.
(() => {
  if (window.__lcTrackerInjected) return;
  window.__lcTrackerInjected = true;

  const CHECK_RE = /\/submissions\/detail\/(\d+)\/check\/?(\?|$)/;

  function report(url, text) {
    try {
      if (!CHECK_RE.test(url)) return;
      const data = JSON.parse(text);
      if (data && data.state === 'SUCCESS') {
        window.postMessage({ source: 'lc-tracker', kind: 'submission', payload: data }, location.origin);
      }
    } catch (_) { /* not JSON or not ours */ }
  }

  // --- fetch ---
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const promise = origFetch.apply(window, arguments);
    try {
      const url = input instanceof Request ? input.url : String(input);
      if (CHECK_RE.test(url)) {
        promise.then(res => {
          res.clone().text().then(t => report(url, t)).catch(() => {});
        }).catch(() => {});
      }
    } catch (_) {}
    return promise;
  };

  // --- XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__lcUrl = String(url); } catch (_) {}
    return origOpen.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    try {
      this.addEventListener('loadend', () => {
        try {
          if (this.__lcUrl && CHECK_RE.test(this.__lcUrl)) report(this.__lcUrl, this.responseText);
        } catch (_) {}
      });
    } catch (_) {}
    return origSend.apply(this, arguments);
  };
})();
