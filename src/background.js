importScripts('common.js');

const TICK_ALARM = 'lc-tick';
const MAX_QUEUE = 500;
const MAX_SEEN = 300;

// ---------- state persistence (serialized so concurrent messages don't clobber each other) ----------
let chain = Promise.resolve();
function withState(fn) {
  const run = chain.then(async () => {
    const { state } = await chrome.storage.local.get('state');
    const s = normalize(state);
    const result = await fn(s);
    await chrome.storage.local.set({ state: s });
    return result;
  });
  chain = run.catch(err => console.error('[lc-tracker]', err));
  return run;
}

function normalize(s) {
  s = s || {};
  s.session = s.session || null;
  s.queue = Array.isArray(s.queue) ? s.queue : [];
  s.seen = Array.isArray(s.seen) ? s.seen : [];
  s.currentSlug = s.currentSlug || null;
  s.currentTitle = s.currentTitle || '';
  s.lastError = s.lastError || '';
  s.lastAttempt = s.lastAttempt || null;
  s.lastSession = s.lastSession || null;
  s.lastRetry = s.lastRetry || 0;
  return s;
}

// ---------- lifecycle ----------
chrome.runtime.onInstalled.addListener(() => ensureAlarm());
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  withState(async s => {
    if (s.session) await finalizeSession(s, await getSettings(), 'browser restarted');
    await updateBadge(s);
  });
});
function ensureAlarm() { chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 }); }

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== TICK_ALARM) return;
  withState(async s => {
    const settings = await getSettings();
    const now = Date.now();
    if (s.session && now - s.session.lastActive > settings.idleMinutes * 60000) {
      await finalizeSession(s, settings, 'idle');
    }
    if (s.queue.length && now - s.lastRetry > 4 * 60000) await flushQueue(s, settings);
    await updateBadge(s);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true;
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'heartbeat': return withState(s => onHeartbeat(s, msg));
    case 'submission': return withState(s => onSubmission(s, msg));
    case 'getStatus': return withState(s => buildStatus(s));
    case 'endSession': return withState(async s => {
      if (s.session) await finalizeSession(s, await getSettings(), 'ended manually');
      await updateBadge(s);
      return buildStatus(s);
    });
    case 'retryQueue': return withState(async s => {
      await flushQueue(s, await getSettings());
      return buildStatus(s);
    });
    case 'testConnection': {
      const url = msg.scriptUrl || (await getSettings()).scriptUrl;
      return post(url, { type: 'ping' });
    }
    case 'sendTestRow': {
      const settings = await getSettings();
      return post(settings.scriptUrl, {
        type: 'attempt',
        timestamp: new Date().toISOString(),
        sessionId: 'test',
        problemId: '0',
        title: 'Test Row (delete me)',
        url: 'https://leetcode.com/problemset/',
        difficulty: 'Easy',
        topics: ['Test'],
        language: 'none',
        result: 'Accepted',
        passed: true,
        testsPassed: 1,
        totalTests: 1,
        runtime: '0 ms',
        memory: '0 MB',
        minutesOnProblem: 0,
        minutesDelta: 0,
        submissionId: 'test-' + Date.now()
      });
    }
    case 'settingsChanged': return withState(s => updateBadge(s).then(() => ({ ok: true })));
    default: return { ok: false, error: 'unknown message ' + msg.type };
  }
}

// ---------- sessions ----------
function sessionIdFor(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function startSession(s, now) {
  s.session = {
    id: sessionIdFor(now),
    start: now,
    lastActive: now,
    activeSeconds: 0,
    problems: {},
    submissions: 0,
    accepted: 0
  };
}

async function ensureSession(s, settings, now) {
  if (s.session && now - s.session.lastActive > settings.idleMinutes * 60000) {
    await finalizeSession(s, settings, 'idle');
  }
  if (!s.session) startSession(s, now);
  return s.session;
}

function problemEntry(session, slug, meta) {
  const p = session.problems[slug] || (session.problems[slug] = {
    slug, title: slug, id: '', difficulty: '', topics: [], url: '',
    seconds: 0, secondsAtLastSubmit: 0, submissions: 0, accepted: 0, solved: false
  });
  if (meta) {
    if (meta.title) p.title = meta.title;
    if (meta.id) p.id = meta.id;
    if (meta.difficulty) p.difficulty = meta.difficulty;
    if (meta.topics && meta.topics.length) p.topics = meta.topics;
    if (meta.url) p.url = meta.url;
  }
  return p;
}

async function onHeartbeat(s, msg) {
  const settings = await getSettings();
  const now = Date.now();
  s.currentSlug = msg.slug;
  s.currentTitle = (msg.meta && msg.meta.title) || msg.slug;

  if (s.session && now - s.session.lastActive > settings.idleMinutes * 60000) {
    await finalizeSession(s, settings, 'idle');
  }

  let active = !!msg.active;
  if (active) {
    try {
      const idle = await chrome.idle.queryState(300); // 5 min with no input = not really working
      if (idle !== 'active') active = false;
    } catch (_) {}
  }

  if (active) {
    if (!s.session) startSession(s, now);
    const p = problemEntry(s.session, msg.slug, msg.meta);
    const dt = Math.min(Math.max(0, (now - s.session.lastActive) / 1000), 30);
    p.seconds += dt;
    s.session.activeSeconds += dt;
    s.session.lastActive = now;
  } else if (s.session && s.session.problems[msg.slug]) {
    problemEntry(s.session, msg.slug, msg.meta); // keep metadata fresh
  }
  await updateBadge(s);
  return { ok: true };
}

async function onSubmission(s, msg) {
  const settings = await getSettings();
  const now = Date.now();
  const r = msg.result || {};
  const meta = msg.meta || {};

  if (r.submissionId) {
    if (s.seen.includes(r.submissionId)) return { ok: true, duplicate: true };
    s.seen.push(r.submissionId);
    if (s.seen.length > MAX_SEEN) s.seen.splice(0, s.seen.length - MAX_SEEN);
  }

  const session = await ensureSession(s, settings, now);
  session.lastActive = now;
  const p = problemEntry(session, msg.slug, meta);
  p.submissions += 1;
  session.submissions += 1;
  if (r.passed) { p.accepted += 1; p.solved = true; session.accepted += 1; }
  // Minutes spent on this problem since its previous submission (the sheet keeps a running total).
  const minutesDelta = round(Math.max(0, p.seconds - (p.secondsAtLastSubmit || 0)) / 60, 1);
  p.secondsAtLastSubmit = p.seconds;

  const payload = {
    type: 'attempt',
    timestamp: new Date(now).toISOString(),
    sessionId: session.id,
    problemId: p.id,
    title: p.title,
    url: p.url,
    difficulty: p.difficulty,
    topics: p.topics,
    language: r.lang || '',
    result: r.statusMsg || (r.passed ? 'Accepted' : 'Failed'),
    passed: !!r.passed,
    testsPassed: r.totalCorrect,
    totalTests: r.totalTestcases,
    runtime: r.runtime || '',
    memory: r.memory || '',
    minutesOnProblem: round(p.seconds / 60, 1),
    minutesDelta,
    submissionId: r.submissionId || '',
    via: r.via || ''
  };

  const res = await deliver(s, settings, payload);
  s.lastAttempt = { title: p.title, result: payload.result, passed: payload.passed, at: now, delivered: res.ok };
  await updateBadge(s);
  return res;
}

async function finalizeSession(s, settings, reason) {
  const sess = s.session;
  if (!sess) return;
  s.session = null;

  const end = sess.lastActive;
  const problems = Object.values(sess.problems);
  const attempted = problems.filter(p => p.submissions > 0);
  const durationMinutes = round((end - sess.start) / 60000, 1);

  const summary = {
    type: 'session',
    sessionId: sess.id,
    start: new Date(sess.start).toISOString(),
    end: new Date(end).toISOString(),
    durationMinutes,
    activeMinutes: round(sess.activeSeconds / 60, 1),
    problemsAttempted: attempted.length,
    problemsSolved: attempted.filter(p => p.solved).length,
    submissions: sess.submissions,
    accepted: sess.accepted,
    problems: problems.map(p => `${p.title}${p.solved ? ' ✓' : p.submissions ? ' ✗' : ''}`),
    topics: [...new Set(problems.flatMap(p => p.topics || []))],
    reason
  };

  // Skip sessions that were just a brief page open with nothing done.
  if (durationMinutes < 1 && sess.submissions === 0) return;

  const res = await deliver(s, settings, summary);
  s.lastSession = { ...summary, delivered: res.ok, endedAt: Date.now() };
}

// ---------- delivery ----------
async function deliver(s, settings, payload) {
  if (!settings.scriptUrl) {
    enqueue(s, payload);
    s.lastError = 'No Apps Script URL set (open the extension options).';
    return { ok: false, queued: true, error: s.lastError };
  }
  const res = await post(settings.scriptUrl, payload);
  if (res.ok) { s.lastError = ''; return res; }
  enqueue(s, payload);
  s.lastError = res.error || 'Unknown error';
  return { ok: false, queued: true, error: s.lastError };
}

function enqueue(s, payload) {
  s.queue.push({ payload, at: Date.now() });
  if (s.queue.length > MAX_QUEUE) s.queue.splice(0, s.queue.length - MAX_QUEUE);
}

async function flushQueue(s, settings) {
  s.lastRetry = Date.now();
  if (!settings.scriptUrl || !s.queue.length) return;
  while (s.queue.length) {
    const item = s.queue[0];
    const res = await post(settings.scriptUrl, item.payload);
    if (!res.ok) { s.lastError = res.error || 'Unknown error'; return; }
    s.queue.shift();
  }
  s.lastError = '';
}

async function post(url, payload) {
  if (!url) return { ok: false, error: 'No Apps Script URL set' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch (_) {
      const hint = /accounts\.google\.com|Sign in/i.test(text)
        ? 'Apps Script asked for a Google login. Redeploy with "Who has access: Anyone".'
        : 'Non-JSON response: ' + text.replace(/\s+/g, ' ').slice(0, 140);
      return { ok: false, error: hint };
    }
    if (!res.ok || !json.ok) return { ok: false, error: json.error || `HTTP ${res.status}` };
    return json;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ---------- status / badge ----------
function buildStatus(s) {
  const now = Date.now();
  const sess = s.session;
  let session = null;
  if (sess) {
    const problems = Object.values(sess.problems);
    session = {
      id: sess.id,
      start: sess.start,
      elapsedMinutes: (now - sess.start) / 60000,
      activeMinutes: sess.activeSeconds / 60,
      problemsVisited: problems.length,
      problemsAttempted: problems.filter(p => p.submissions > 0).length,
      problemsSolved: problems.filter(p => p.solved).length,
      submissions: sess.submissions,
      accepted: sess.accepted,
      lastActive: sess.lastActive
    };
  }
  const cur = sess && s.currentSlug ? sess.problems[s.currentSlug] : null;
  return {
    ok: true,
    session,
    currentSlug: s.currentSlug,
    currentTitle: s.currentTitle,
    currentProblemMinutes: cur ? cur.seconds / 60 : 0,
    currentProblemSubmissions: cur ? cur.submissions : 0,
    currentProblemSolved: cur ? cur.solved : false,
    queueLength: s.queue.length,
    lastError: s.lastError,
    lastAttempt: s.lastAttempt,
    lastSession: s.lastSession
  };
}

async function updateBadge(s) {
  try {
    if (s.session) {
      const mins = (Date.now() - s.session.start) / 60000;
      await chrome.action.setBadgeBackgroundColor({ color: s.queue.length ? '#d97706' : '#16a34a' });
      await chrome.action.setBadgeText({ text: fmtBadge(mins) });
    } else {
      await chrome.action.setBadgeText({ text: s.queue.length ? String(s.queue.length) : '' });
      if (s.queue.length) await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
    }
  } catch (_) {}
}
