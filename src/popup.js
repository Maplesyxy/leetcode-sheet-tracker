function msg(type, extra = {}) {
  return new Promise(resolve => chrome.runtime.sendMessage({ type, ...extra }, r => resolve(r || {})));
}
const $ = id => document.getElementById(id);

function timeAgo(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

async function refresh() {
  const [st, settings] = await Promise.all([msg('getStatus'), getSettings()]);
  const s = st.session;
  $('dot').classList.toggle('on', !!s);
  $('sessionState').textContent = s ? `started ${new Date(s.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'none active';
  $('elapsed').textContent = s ? fmtMinutes(s.elapsedMinutes) : '0m';
  $('active').textContent = s ? fmtMinutes(s.activeMinutes) : '0m';
  $('attempted').textContent = s ? s.problemsAttempted : 0;
  $('solved').textContent = s ? s.problemsSolved : 0;
  $('subs').textContent = s ? s.submissions : 0;
  $('endSession').hidden = !s;

  const showProb = !!(s && st.currentSlug);
  $('problemCard').hidden = !showProb;
  if (showProb) {
    $('probTitle').textContent = st.currentTitle || st.currentSlug;
    $('probTitle').title = st.currentTitle || st.currentSlug;
    $('probTime').textContent = fmtMinutes(st.currentProblemMinutes);
    $('probStatus').textContent = st.currentProblemSolved ? '✓ solved' :
      st.currentProblemSubmissions ? `${st.currentProblemSubmissions} failed` : 'in progress';
    $('probStatus').className = st.currentProblemSolved ? 'ok' : st.currentProblemSubmissions ? 'bad' : 'muted';
  }

  if (st.lastAttempt) {
    const a = st.lastAttempt;
    $('lastAttempt').textContent = `${a.title} · ${a.result} · ${timeAgo(a.at)}${a.delivered ? '' : ' (queued)'}`;
    $('lastAttempt').className = 'ellipsis ' + (a.passed ? 'ok' : 'bad');
  }
  if (st.lastSession) {
    const l = st.lastSession;
    $('lastSession').textContent = `${fmtMinutes(l.durationMinutes)} · ${l.problemsSolved}/${l.problemsAttempted} solved · ${timeAgo(l.endedAt)}`;
  }

  $('queue').hidden = !st.queueLength;
  $('queue').textContent = st.queueLength ? `${st.queueLength} row(s) waiting to be sent to the sheet.` : '';
  $('retry').hidden = !st.queueLength;

  let err = st.lastError || '';
  if (!settings.scriptUrl) err = 'Not connected to a sheet yet. Open Settings to finish setup.';
  $('error').hidden = !err;
  $('error').textContent = err;

  $('openSheet').hidden = !settings.sheetUrl;
  $('openSheet').href = settings.sheetUrl || '#';
}

$('options').onclick = () => chrome.runtime.openOptionsPage();
$('endSession').onclick = async () => { await msg('endSession'); refresh(); };
$('retry').onclick = async () => { $('retry').textContent = 'Sending…'; await msg('retryQueue'); $('retry').textContent = 'Retry sending'; refresh(); };

refresh();
setInterval(refresh, 2000);
