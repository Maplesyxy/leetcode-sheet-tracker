// Isolated-world content script on leetcode.com.
// - Figures out which problem is open (SPA-aware) and fetches its metadata (title, difficulty, topics).
// - Sends activity heartbeats to the background so session + per-problem time can be tracked.
// - Receives submission verdicts from inject.js (network) with a DOM fallback, and reports them.
(() => {
  if (window.__lcTrackerContent) return;
  window.__lcTrackerContent = true;

  const HEARTBEAT_MS = 10000;
  const VERDICT_RE = /^(Accepted|Wrong Answer|Time Limit Exceeded|Memory Limit Exceeded|Runtime Error|Compile Error|Output Limit Exceeded|Internal Error)$/;

  let currentSlug = null;
  let currentMeta = null;
  const metaCache = new Map();
  const seenSubmissions = new Set();
  let lastSubmitClick = 0;
  let lastNetworkVerdict = 0;
  let lastDomVerdictText = '';

  // ---------- helpers ----------
  function slugFromPath() {
    const m = location.pathname.match(/\/problems\/([^\/?#]+)/);
    return m ? m[1] : null;
  }

  function problemUrl(slug) {
    const m = location.pathname.match(/^(.*\/problems\/[^\/?#]+)/);
    return `${location.origin}${m ? m[1] : `/problems/${slug}`}/`;
  }

  function send(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, resp => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  async function fetchMeta(slug) {
    if (!slug) return null;
    if (metaCache.has(slug)) return metaCache.get(slug);
    const fallback = {
      id: '',
      title: document.title.replace(/\s*-\s*LeetCode\s*$/i, '').trim() || slug,
      slug,
      difficulty: '',
      topics: [],
      url: problemUrl(slug)
    };
    try {
      const query = `query q($slug: String!) {
        question(titleSlug: $slug) { questionFrontendId title titleSlug difficulty topicTags { name } }
      }`;
      const res = await fetch('/graphql', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { slug } })
      });
      const json = await res.json();
      const q = json && json.data && json.data.question;
      if (q) {
        const meta = {
          id: q.questionFrontendId || '',
          title: q.title || fallback.title,
          slug,
          difficulty: q.difficulty || '',
          topics: (q.topicTags || []).map(t => t.name),
          url: problemUrl(slug)
        };
        metaCache.set(slug, meta);
        return meta;
      }
    } catch (_) { /* fall through */ }
    return fallback; // not cached so a later retry can succeed
  }

  // ---------- toast ----------
  let toastEl = null, toastTimer = null;
  function toast(text, ok = true) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      Object.assign(toastEl.style, {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647,
        padding: '10px 14px', borderRadius: '8px', fontSize: '13px',
        fontFamily: 'system-ui, -apple-system, sans-serif', color: '#fff',
        boxShadow: '0 4px 16px rgba(0,0,0,.25)', transition: 'opacity .3s', opacity: '0',
        pointerEvents: 'none', maxWidth: '320px'
      });
      document.documentElement.appendChild(toastEl);
    }
    toastEl.style.background = ok ? '#16a34a' : '#dc2626';
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 3500);
  }

  // ---------- heartbeat ----------
  async function heartbeat() {
    const slug = slugFromPath();
    if (!slug) return;
    if (slug !== currentSlug || !currentMeta || (currentMeta.topics.length === 0 && !metaCache.has(slug))) {
      currentSlug = slug;
      currentMeta = await fetchMeta(slug);
    }
    send({ type: 'heartbeat', slug, active: document.visibilityState === 'visible', meta: currentMeta });
  }
  setInterval(heartbeat, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', heartbeat);
  heartbeat();

  // ---------- submission handling ----------
  async function handleVerdict(r, via) {
    const id = r.submission_id ? String(r.submission_id) : '';
    if (id) {
      if (seenSubmissions.has(id)) return;
      seenSubmissions.add(id);
    }
    const slug = slugFromPath();
    if (!slug) return;
    const meta = await fetchMeta(slug);
    const statusMsg = r.status_msg || '';
    const passed = r.status_code === 10 || statusMsg === 'Accepted';
    const resp = await send({
      type: 'submission',
      slug,
      meta,
      result: {
        submissionId: id,
        statusMsg,
        statusCode: r.status_code,
        passed,
        lang: r.pretty_lang || r.lang || '',
        totalCorrect: r.total_correct,
        totalTestcases: r.total_testcases,
        runtime: r.status_runtime || '',
        memory: r.status_memory || '',
        via
      }
    });
    if (resp && resp.duplicate) return;
    if (resp && resp.ok) toast(`Logged to sheet: ${statusMsg}${passed ? ' ✓' : ''}`, true);
    else if (resp && resp.queued) toast(`Saved locally (sheet unreachable): ${resp.error || ''}`, false);
    else toast(`Tracker: ${resp && resp.error ? resp.error : 'not logged'}`, false);
  }

  // Network path (from inject.js)
  window.addEventListener('message', ev => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'lc-tracker') return;
    if (ev.data.kind === 'submission' && ev.data.payload) {
      lastNetworkVerdict = Date.now();
      handleVerdict(ev.data.payload, 'network');
    }
  });

  // DOM fallback: only trusted shortly after a real click on the Submit button.
  document.addEventListener('click', ev => {
    const btn = ev.target && ev.target.closest && ev.target.closest('button, [role="button"]');
    if (!btn) return;
    const isSubmit = btn.matches('[data-e2e-locator="console-submit-button"]') ||
      /^\s*submit\s*$/i.test(btn.textContent || '');
    if (isSubmit) { lastSubmitClick = Date.now(); lastDomVerdictText = ''; }
  }, true);

  let domCheckTimer = null;
  const observer = new MutationObserver(() => {
    if (domCheckTimer) return;
    domCheckTimer = setTimeout(() => {
      domCheckTimer = null;
      const el = document.querySelector('[data-e2e-locator="submission-result"]');
      if (!el) return;
      const text = (el.textContent || '').trim();
      if (!VERDICT_RE.test(text) || text === lastDomVerdictText) return;
      const now = Date.now();
      if (now - lastSubmitClick > 120000) return;          // not from a recent submit
      lastDomVerdictText = text;
      if (now - lastNetworkVerdict < 30000) return;        // network path already handled it
      lastSubmitClick = 0;
      handleVerdict({ status_msg: text, status_code: text === 'Accepted' ? 10 : 0, submission_id: '' }, 'dom');
    }, 400);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})();
