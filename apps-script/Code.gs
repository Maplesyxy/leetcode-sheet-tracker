// ============================================================
//  LeetCode Sheet Tracker — Google Apps Script backend
//  Setup: open your Google Sheet → Extensions → Apps Script →
//  replace everything with this file → Deploy → New deployment →
//  type "Web app", Execute as "Me", Who has access "Anyone" →
//  copy the Web app URL into the extension's options page.
//
//  Tabs written:
//    Problems   — one row per problem: running totals + the latest submission's details
//    Sessions   — one row per sitting
//    Weak Areas — per-topic struggle ranking, rebuilt from Problems after every submission
// ============================================================

// Leave blank when this script is bound to the sheet (opened via Extensions → Apps Script).
const SHEET_ID = '';

const SHEETS = { problems: 'Problems', sessions: 'Sessions', summary: 'Weak Areas' };

const HEADERS = {
  problems: ['Problem #', 'Title', 'Difficulty', 'Topics', 'Status', 'Attempts', 'Attempts to Solve', 'Minutes',
             'First Attempt', 'Solved On', 'Last Attempt',
             'Last Result', 'Passed', 'Language', 'Tests', 'Runtime', 'Memory', 'Submission ID'],
  sessions: ['Session ID', 'Start', 'End', 'Duration (min)', 'Active (min)', 'Problems Attempted',
             'Problems Solved', 'Submissions', 'Accepted', 'Problems', 'Topics'],
  summary:  ['Topic', 'Problems', 'Solved', 'Solve Rate', 'Avg Attempts', 'Avg Minutes',
             'Struggle Score', 'Verdict', 'Unsolved Problems']
};

// 0-based column indexes into a Problems row.
const C = {};
HEADERS.problems.forEach((h, i) => { C[h] = i; });
const W = HEADERS.problems.length;

const VERDICT_COLORS = { 'Struggling': '#f4c7c3', 'Needs practice': '#fce8b2', 'Solid': '#b7e1cd' };
const RESULT_COLORS  = { pass: '#b7e1cd', fail: '#f4c7c3' };

// ---------------- entry points ----------------
function doGet() {
  return json({ ok: true, service: 'leetcode-tracker', sheet: ss().getName() });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const data = JSON.parse(e.postData.contents);
    switch (data.type) {
      case 'ping':
        return json({ ok: true, sheet: ss().getName() });
      case 'attempt': {
        const added = recordAttempt(data);
        if (added) rebuildSummary();
        return json({ ok: true, added });
      }
      case 'session':
        return json({ ok: true, added: recordSession(data) });
      case 'rebuild':
        rebuildSummary();
        return json({ ok: true });
      default:
        return json({ ok: false, error: 'Unknown type: ' + data.type });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// Run this from the Apps Script editor if you edit the Problems tab by hand.
function rebuildNow() { rebuildSummary(); }

// ---------------- Problems: one row per problem, updated in place ----------------
function recordAttempt(d) {
  const sh = getSheet('problems');
  const sid = d.submissionId ? String(d.submissionId) : '';
  const now = toDate(d.timestamp) || new Date();
  const passed = d.passed === true;

  const rowIndex = findProblemRow(sh, d);
  const old = rowIndex ? sh.getRange(rowIndex, 1, 1, W).getValues()[0] : null;
  if (old && sid && String(old[C['Submission ID']]) === sid) return false;   // retried duplicate

  const attempts = (old ? Number(old[C['Attempts']]) || 0 : 0) + 1;
  const prevSolvedOn = old && old[C['Solved On']] instanceof Date ? old[C['Solved On']] : null;
  const solvedOn = prevSolvedOn || (passed ? now : '');
  const attemptsToSolve = old && old[C['Attempts to Solve']] !== '' ? old[C['Attempts to Solve']]
                        : (passed ? attempts : '');

  // Extension sends minutes spent since the previous submission on this problem.
  // Fallback for older extension builds: credit the session total only on the first attempt.
  const delta = d.minutesDelta !== undefined && d.minutesDelta !== null
    ? Number(d.minutesDelta) : (old ? 0 : Number(d.minutesOnProblem));
  const minutes = round1((old ? Number(old[C['Minutes']]) || 0 : 0) + (delta || 0));

  const topics = (d.topics || []).length ? d.topics.join(', ') : (old ? old[C['Topics']] : '');
  const title = d.title || (old ? old[C['Title']] : '') || '';
  const tests = (d.testsPassed !== undefined && d.testsPassed !== null && d.testsPassed !== '' &&
                 d.totalTests !== undefined && d.totalTests !== null && d.totalTests !== '')
    ? `${d.testsPassed}/${d.totalTests}` : '';

  const row = [
    str(d.problemId) || (old ? old[C['Problem #']] : ''),
    titleCell(title, d.url),
    d.difficulty || (old ? old[C['Difficulty']] : ''),
    topics,
    solvedOn ? 'Solved' : 'Unsolved',
    attempts,
    attemptsToSolve,
    minutes,
    old && old[C['First Attempt']] instanceof Date ? old[C['First Attempt']] : now,
    solvedOn,
    now,
    d.result || '',
    passed,
    d.language || '',
    tests,
    d.runtime || '',
    d.memory || '',
    sid
  ];

  const target = rowIndex || sh.getLastRow() + 1;
  sh.getRange(target, 1, 1, W).setValues([row]);
  sh.getRange(target, C['Status'] + 1).setBackground(solvedOn ? RESULT_COLORS.pass : RESULT_COLORS.fail);
  sh.getRange(target, C['Last Result'] + 1).setBackground(passed ? RESULT_COLORS.pass : RESULT_COLORS.fail);
  return true;
}

// Match on Problem # when we have one, otherwise on the displayed title.
function findProblemRow(sh, d) {
  const n = sh.getLastRow();
  if (n < 2) return 0;
  const vals = sh.getRange(2, 1, n - 1, 2).getValues();   // [Problem #, Title]
  const num = str(d.problemId);
  for (let i = 0; i < vals.length; i++) {
    if (num && String(vals[i][0]) === num) return i + 2;
    if (!num && d.title && String(vals[i][1]) === d.title) return i + 2;
  }
  return 0;
}

function titleCell(title, url) {
  if (!url) return title;
  const esc = s => String(s).replace(/"/g, '""');
  return `=HYPERLINK("${esc(url)}", "${esc(title || url)}")`;
}

// ---------------- Sessions ----------------
function recordSession(d) {
  const sh = getSheet('sessions');
  if (d.sessionId && columnHas(sh, 1, String(d.sessionId))) return false;
  sh.appendRow([
    d.sessionId || '', toDate(d.start), toDate(d.end), Number(d.durationMinutes) || 0,
    Number(d.activeMinutes) || 0, Number(d.problemsAttempted) || 0, Number(d.problemsSolved) || 0,
    Number(d.submissions) || 0, Number(d.accepted) || 0,
    (d.problems || []).join(', '), (d.topics || []).join(', ')
  ]);
  return true;
}

// ---------------- Weak Areas: rebuilt from the Problems tab ----------------
function rebuildSummary() {
  const sh = getSheet('problems');
  const n = sh.getLastRow();
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, W).getValues() : [];

  const topics = {};
  rows.forEach(r => {
    const title = String(r[C['Title']] || '');
    if (!title && !r[C['Problem #']]) return;
    const solved = String(r[C['Status']]) === 'Solved';
    const attempts = Number(r[C['Attempts']]) || 0;
    const minutes = Number(r[C['Minutes']]) || 0;
    const list = splitTopics(r[C['Topics']]);
    (list.length ? list : ['(untagged)']).forEach(t => {
      const a = topics[t] || (topics[t] = { problems: 0, solved: 0, attempts: 0, minutes: 0, unsolved: [] });
      a.problems++;
      if (solved) a.solved++; else a.unsolved.push(title);
      a.attempts += attempts;
      a.minutes += minutes;
    });
  });

  const out = Object.keys(topics).map(t => {
    const a = topics[t];
    const solveRate = a.problems ? a.solved / a.problems : 0;
    const avgAttempts = a.problems ? a.attempts / a.problems : 0;
    const avgMinutes = a.problems ? a.minutes / a.problems : 0;
    // 0 = everything solved first try, 1 = nothing solved after many tries.
    const score = 0.6 * (1 - solveRate) + 0.4 * Math.min(1, Math.max(0, (avgAttempts - 1) / 3));
    const verdict = score >= 0.45 ? 'Struggling' : score >= 0.2 ? 'Needs practice' : 'Solid';
    return [t, a.problems, a.solved, solveRate, round1(avgAttempts), round1(avgMinutes),
            Math.round(score * 100) / 100, verdict, a.unsolved.join(', ')];
  });
  out.sort((x, y) => y[6] - x[6] || y[1] - x[1]);

  const sum = writeTable('summary', out);
  if (out.length) {
    sum.getRange(2, 4, out.length, 1).setNumberFormat('0%');
    sum.getRange(2, 8, out.length, 1).setBackgrounds(out.map(r => [VERDICT_COLORS[r[7]] || null]));
  }
}

// ---------------- sheet helpers ----------------
function ss() { return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActive(); }

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSheet(key) {
  const book = ss();
  let sh = book.getSheetByName(SHEETS[key]);
  if (!sh) sh = book.insertSheet(SHEETS[key]);
  const headers = HEADERS[key];
  const current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  if (current.join('|') !== headers.join('|')) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function writeTable(key, rows) {
  const sh = getSheet(key);
  const width = HEADERS[key].length;
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, Math.max(width, sh.getLastColumn())).clearContent().setBackground(null);
  if (rows.length) sh.getRange(2, 1, rows.length, width).setValues(rows);
  return sh;
}

function columnHas(sh, col, value) {
  const n = sh.getLastRow();
  if (n < 2) return false;
  return sh.getRange(2, col, n - 1, 1).getValues().some(r => String(r[0]) === value);
}

function splitTopics(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}
function toDate(v) { const d = new Date(v); return isNaN(d) ? '' : d; }
function str(v) { return v === null || v === undefined ? '' : String(v); }
function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }
