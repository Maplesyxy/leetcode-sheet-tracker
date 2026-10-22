const $ = id => document.getElementById(id);
function msg(type, extra = {}) {
  return new Promise(resolve => chrome.runtime.sendMessage({ type, ...extra }, r => resolve(r || {})));
}
function setStatus(el, text, ok) {
  el.textContent = text;
  el.className = 'status ' + (ok === undefined ? '' : ok ? 'ok' : 'bad');
}

async function load() {
  const s = await getSettings();
  $('scriptUrl').value = s.scriptUrl;
  $('sheetUrl').value = s.sheetUrl;
  $('idleMinutes').value = s.idleMinutes;
  try {
    const res = await fetch(chrome.runtime.getURL('apps-script/Code.gs'));
    $('code').textContent = await res.text();
  } catch (e) {
    $('code').textContent = 'Could not load Code.gs: ' + e;
  }
}

function readForm() {
  return {
    scriptUrl: $('scriptUrl').value.trim(),
    sheetUrl: $('sheetUrl').value.trim(),
    idleMinutes: Math.min(120, Math.max(2, Number($('idleMinutes').value) || 10))
  };
}

$('save').onclick = async () => {
  await saveSettings(readForm());
  await msg('settingsChanged');
  setStatus($('saveStatus'), 'Saved.', true);
  setTimeout(() => setStatus($('saveStatus'), ''), 2500);
};

$('test').onclick = async () => {
  const url = $('scriptUrl').value.trim();
  if (!url) return setStatus($('connStatus'), 'Paste the Web app URL first.', false);
  setStatus($('connStatus'), 'Testing…');
  const r = await msg('testConnection', { scriptUrl: url });
  if (r.ok) {
    await saveSettings(readForm());
    setStatus($('connStatus'), `Connected to "${r.sheet}". Settings saved.`, true);
  } else {
    setStatus($('connStatus'), 'Failed: ' + (r.error || 'unknown error'), false);
  }
};

$('testRow').onclick = async () => {
  await saveSettings(readForm());
  setStatus($('connStatus'), 'Sending…');
  const r = await msg('sendTestRow');
  setStatus($('connStatus'), r.ok ? 'Test row written to the Attempts sheet (delete it whenever).' : 'Failed: ' + (r.error || 'unknown error'), !!r.ok);
};

$('copyCode').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('code').textContent);
    $('copyCode').textContent = 'Copied!';
  } catch (_) {
    $('copyCode').textContent = 'Select & copy manually';
  }
  setTimeout(() => { $('copyCode').textContent = 'Copy script'; }, 2000);
};

load();
