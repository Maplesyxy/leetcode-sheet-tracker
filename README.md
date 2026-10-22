# LeetCode Sheet Tracker

Chrome extension that turns on automatically on leetcode.com and logs to a Google Sheet:

- every real **Submit** (pass/fail, verdict, tests passed, language, runtime, topics, difficulty, minutes spent),
- each **session** (start, end, total duration, active minutes, problems attempted/solved, topics covered),
- a per-problem **Problems** sheet and a per-topic **Weak Areas** sheet ranked by a struggle score.

## Install (unpacked)

1. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick this folder.
2. Click the extension icon → **Settings** and follow the on-page guide (paste `apps-script/Code.gs`
   into your sheet's Apps Script editor, deploy as a Web app with access "Anyone", paste the `/exec` URL back).
3. Press **Test connection**, then **Send a test row** to see the tabs get created.

## How it works

| Piece | Role |
|---|---|
| `src/inject.js` | Runs in the page's main world; watches LeetCode's own submission-result polling (`/submissions/detail/<id>/check/`) and forwards the final verdict. "Run" test executions are ignored. |
| `src/content.js` | Finds the open problem (SPA-aware), fetches title/difficulty/topics via LeetCode's GraphQL, sends 10 s activity heartbeats, has a DOM fallback for verdicts, shows a toast when a row is logged. |
| `src/background.js` | Owns the session clock (ends after N idle minutes or on browser restart), per-problem time, dedupe, posting to Apps Script, and an offline retry queue. Badge shows session length. |
| `apps-script/Code.gs` | Upserts the problem's row (matched by Problem #) and rebuilds Weak Areas after each attempt. |

Struggle score per topic = 0.6 × (share of problems unsolved) + 0.4 × (extra attempts per problem, capped at 3).
≥ 0.45 → Struggling, ≥ 0.2 → Needs practice, else Solid.

## Notes

- Only leetcode.com is supported (not leetcode.cn). Contest problems under `/contest/.../problems/<slug>` are picked up too.
- Time counting pauses when the tab is hidden or the computer has been idle for 5 minutes.
- If you edit the Problems tab by hand, run `rebuildNow` in the Apps Script editor to refresh the derived tabs.
