# book-restaurant

Auto-confirms Tebi waitlist reservation emails (e.g. "A spot is available for...") the moment they land in Gmail, without needing to watch the inbox.

Currently scoped to Tebi's waitlist notify-and-confirm flow (sender `noreply-reservations@tebi.co`).
Other restaurant platforms (Resy, OpenTable, direct booking pages) are not yet supported - the parser
and confirm step are Tebi-specific for now.

## How it works

1. Polls Gmail every 10s (configurable, see [Poll interval](#poll-interval)) for unread mail from Tebi matching "spot is available".
2. Parses the plain-text body for restaurant name, event, date, party size, and the confirm link.
3. Opens the confirm link in a headless browser (Playwright) and inspects the resulting page, capturing an ordered screenshot trace of every step (see [Screenshot traces](#screenshot-traces)).
4. Classifies the outcome:
   - `booked` - no "still waitlisted" language present
   - `still_waitlisted` - page still says "Waitlist confirmed / we will contact you" (spot was likely taken by someone else first)
   - `error` - expired/not-found/error language detected
5. Labels the email (`Reservations/Booked` or `Reservations/Needs-you`) and replies in the thread to your own inbox with the outcome, the frame-by-frame timeline, and the final screenshot attached.
6. Records the outcome in `state.json`, keyed by restaurant + event + date. If a later email arrives for an event already recorded as `booked`, it's skipped rather than re-attempted.
7. Sends a Pushover alert to your phone at emergency priority (repeats until acknowledged) for every outcome - `booked`, `still_waitlisted`, or `error`.

## Screenshot traces

A claim attempt captures a *sequence* of screenshots, not one.
The confirm link can redirect, render client-side, or move through several states, and a single frame can't tell you which of those happened.

Each attempt writes a directory keyed by Gmail message ID:

```
screenshots/<messageId>/
  01-navigated.png
  02-loaded.png
  03-settled.png
  04-final-still_waitlisted.png
  trace.json
```

Frames are numbered from 1 in capture order and zero-padded, so a plain alphabetical listing is chronological.
The ordinal is baked into the filename rather than inferred from mtimes, which get rewritten when files are copied off the VM.

`trace.json` records the same order plus, per frame, the URL at capture time and the offset in milliseconds from the start of the attempt.
It also records the controls the final page was offering and whether the page mentioned a payment or deposit.

Frames come from two sources: points the handler explicitly captures (`loaded`, `settled`, `final-<outcome>`) and a `framenavigated` listener that fires whenever the page moves on its own.
Captures are serialised through a queue, so the two sources can't race for the same ordinal.
A frame that fails to capture is logged and skipped - it never aborts the attempt, since a lost screenshot must not cost a reservation.

The Gmail reply quotes the timeline inline and attaches the final frame; the full set stays on disk.

## The deposit question

The restaurant takes a deposit (~£40) at booking time, so the expectation was that the confirm link leads into a payment step the bot was failing to complete.

Tracing a live confirm link shows it doesn't - at least not from a link whose spot has already gone.
That page offers exactly three controls: "Unsubscribe from the waitlist", "Make another reservation", and the Tebi footer link.
There is no reserve button, no card field, and no mention of a deposit.
It is a dead end, not an unfinished flow.

So `still_waitlisted` looks genuine rather than a missed step: by the time the bot arrives, the spot is gone and Tebi has degraded the link to a plain waitlist-status page.
The deposit step presumably only appears on a link that still has a spot attached - which is exactly the case we've never captured.
The trace is what will show it: the first attempt that reaches a live spot will record the payment page frame by frame, and `mentionsPayment` in `trace.json` flags it.

The bot deliberately does **not** attempt to pay. It captures and reports; paying is a manual decision.

## Setup

1. In Google Cloud Console, create an OAuth client of type "Desktop app" for your Google account, enable the Gmail API, download the client JSON.
2. Save it as `credentials.json` in the repo root.
3. Install dependencies:

   ```bash
   npm install
   npx playwright install chromium
   ```

4. Run the one-time OAuth flow:

   ```bash
   npm run auth
   ```

   Opens a URL to authorize, paste the resulting code back into the terminal. Saves `token.json` locally.

5. (Optional but recommended) Set up phone alerts via [Pushover](https://pushover.net):
   - Sign up, copy your **User Key** from the dashboard
   - Create an Application at pushover.net/apps/build to get an **App Token**
   - Copy `.env.example` to `.env` and fill in both:

     ```bash
     cp .env.example .env
     ```

   Without a `.env`, the bot still runs fine - it just skips sending phone alerts and logs a
   warning instead.

6. Run once, or continuously:

   ```bash
   npm run poll          # single pass
   npm run poll:watch    # loop every 10s
   ```

## Poll interval

Watch mode waits a fixed gap between cycles, 10s by default. Override it with `POLL_INTERVAL_MS` in
`.env` (persistent, e.g. on the VM) or `--interval=<ms>` on the command line, which wins over the env var:

```bash
POLL_INTERVAL_MS=30000 npm run poll:watch
npm run poll:watch -- --interval=5000
```

Values below 1000ms, or anything non-numeric, are rejected at startup rather than silently coerced.
The value is only used in watch mode, but it's still validated on a single pass so a broken `.env` is
caught immediately instead of on the next long-running restart.

The loop is sequential, not a fixed-period timer: the next cycle starts `POLL_INTERVAL_MS` after the
previous one *finishes*, so the interval is a gap between cycles rather than a period. This matters
because a cycle that finds a match can easily run longer than the interval - `claimSpot` drives a real
browser, which took ~20s in practice against a 10s interval. A `setInterval` would fire the next cycle
on top of the in-flight one, and since the email is still unread and `state.json` isn't written until
the outcome is known, that second cycle would re-confirm the same spot and send a second label, reply,
and phone alert. Overlapping cycles did exactly this in production on 2026-08-17, handling one email
three times.

In-process, messages currently being handled are also tracked in a set and skipped, so overlap can't
double-handle even if a future change reintroduces concurrent cycles. That set is cleared when a message
*fails*, deliberately: nothing was written to `state.json`, so the next cycle retries the spot rather than
abandoning it. The tradeoff is that a repeatedly-failing message is retried every cycle - each failure
pages your phone, so this surfaces loudly rather than silently.

## Handlers

An email source is a **handler** - one object describing how to find its mail, read it, and act on it.
`poll.js` owns everything around that (dedupe, labelling, threaded reply, state, Pushover, logging) and never
knows which handler it's driving.

```js
{
  name,                              // 'tebi'
  inboxQuery,                        // Gmail search that surfaces candidates
  isHandled({ message }),            // is this message mine to act on?
  readInvitation({ message }),       // -> Invitation
  claimSpot({ invitation }),         // perform the action -> Attempt
  describe({ invitation, attempt }), // -> { headline, detail } for reply + push
}
```

`Invitation` (the offered spot) and `Attempt` (what happened when we tried to take it) are plain objects,
typed as JSDoc `@typedef`s in `src/handlers/types.js` - they get destructured at call sites and dumped
straight into logs, so no classes.

Two handlers ship today: `tebi` (real) and `test` (below). One is active per run.

## Test mode

Exercises the whole framework - Gmail match, parse, browser step, screenshot, label, threaded reply,
`state.json`, Pushover - without touching a real reservation.

```bash
npm run dev:poll:test          # single pass
npm run dev:poll:test:watch    # loop every 10s
```

Then email yourself, subject prefixed `[bot-test]`:

```
[bot-test]: sushi london
```

Whatever follows the prefix becomes the search term the no-op browser step runs, so trying a different
term means sending another email rather than restarting the watcher. A bare `[bot-test]:` falls back to
`test reservation`.

The no-op `claimSpot` opens a real headless browser at a Bing search for that term, screenshots the
results full-page, and closes - then reports whatever outcome you asked for. Nothing is booked. The
screenshot is real, so the reply attachment path gets exercised properly.

Bing rather than Google or DuckDuckGo because both of those serve headless Chromium a consent wall or a
CAPTCHA instead of results, which makes for a useless screenshot.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEST_MODE=1` | off | Set by the npm scripts. Swaps in the test handler; the real one is not run. |
| `TEST_OUTCOME` | `booked` | Forced outcome: `booked`, `still_waitlisted`, or `error`. Anything else throws. |
| `TEST_SUBJECT_PREFIX` | `[bot-test]` | Subject prefix that triggers the handler. |

```bash
TEST_OUTCOME=still_waitlisted npm run dev:poll:test
```

Side effects are deliberately real - labels are applied, the threaded reply is sent, `state.json` is
written, and Pushover fires at the same emergency priority as production. The point is testing the
framework, so nothing is stubbed but the confirmation itself.

Two consequences worth knowing:

- Test runs write into the same `state.json` as real ones. Harmless (keys are restaurant + event + date,
  and test entries use the sender name plus today's date) but the file accumulates test rows.
- The outcome reply lands in the same thread with the prefix still in its `Re:` subject. Both the Gmail
  query (`-in:sent`) and `isHandled` (rejects `Re:`) exclude it, so the bot doesn't answer itself and loop.

## Phone alerts (Pushover)

Gmail/Mail app push notifications are easy to miss - soft banner, no escalation. Instead, the
bot pages your phone directly the moment it processes an email, using Pushover's **emergency**
priority: the notification repeats and vibrates every 60s for up to an hour until you
acknowledge it. This fires as the last step of handling an email, after the confirm attempt,
Gmail labeling, and thread reply are already done - it's a notification layer on top of
completed work, not a gate that blocks it.

Covers every outcome:

- `booked`, `still_waitlisted`, `error` - a graceful outcome, alerted from inside `processMessage()`
- a hard crash (network timeout, Playwright exception, unparseable email) - alerted separately
  from `pollOnce()`'s catch block, so a failure that happens *before* an outcome is even
  reached still pages you instead of only showing up in terminal/VM logs later

## Logs

Every run (`poll` or `poll:watch`) writes to both the console and `logs/YYYY-MM-DD.log` -
useful when running detached in `tmux` on a VM, where console output otherwise disappears once
the session scrolls past or the tab closes. A new dated file starts automatically at midnight.

Requires the free Pushover iOS app plus a paid one-time app unlock (~$5) to receive
notifications past the trial period. See step 5 in Setup above for the `.env` values needed.

## Gmail API quota

Free tier limits (per project):

- 1,000,000,000 quota units/day
- 250 quota units/user/second (burst cap)

Cost per call: `messages.list` = 5, `messages.get` = 5, `messages.modify` (labels) = 5, `messages.send` = 100.

At the default 10s poll interval, a no-match cycle costs 5 units (list only) - 8,640 cycles/day = ~43,200 units/day, a trivial fraction of the daily quota. A cycle with a match costs roughly 115 units (list + get + modify + send). Polling far more aggressively (down to the 1s floor) would still stay well under both caps - the real constraint on interval is local resource use (spinning up Playwright/Chromium per match), not Gmail's API limits.

## Auth token expiry (running for multiple days)

The `access_token` expires hourly - handled automatically, the client refreshes it in-memory using the `refresh_token`, and `gmail-auth.js` persists the rotated token back to `token.json` so this survives process restarts.

The `refresh_token` itself is the thing to watch. As long as the OAuth consent screen is in **Testing** status (the default, and the only option without Google app verification for a restricted scope like `gmail.modify`), Google expires the refresh token after **7 days**. `poll:watch` detects this (`invalid_grant` error) and exits with instructions rather than looping uselessly.

To keep it running past 7 days:

```bash
rm token.json
npm run auth
```

Re-authorize, then restart `npm run poll:watch`. There's no way around the 7-day limit short of getting the OAuth app formally verified by Google (irrelevant overhead for personal single-user use) - re-running the auth step weekly is the practical path.

## Known limitations

- Success-state detection (`booked`) is a heuristic - we haven't seen a real "booked" page yet, only the "still waitlisted" state, since every live link tested against had already lost its spot. Verify the first real `booked` classification against its trace before trusting it fully.
- The deposit/payment step has never been observed (see [The deposit question](#the-deposit-question)). If a live link does lead to one, the bot captures it and reports - it does not pay. That attempt will classify as `booked` under the current heuristic despite no booking having completed, so the first trace showing `mentionsPayment: true` needs reading before the outcome is believed.
- Traces are never pruned. Each attempt writes a handful of full-page PNGs, which is negligible at the current volume but is unbounded over time.
- Local-only: no GCP Pub/Sub push, no watch renewal. Polling stops when the process isn't running.
- Only handles Tebi's waitlist flow. A genuinely different restaurant platform needs its own handler in
  `src/handlers/` - the framework around it (dedupe, labels, reply, state, alerts) is already platform-agnostic.
- One handler is active per run, chosen at startup. Watching two platforms at once would need `poll.js` to
  fan out across handlers rather than pick one.

## Next step: move off local polling to Gmail push (Cloud Run + Pub/Sub)

Running `poll:watch` requires a laptop on 24/7. The practical next step is switching from
polling to push: Gmail notifies a Pub/Sub topic the instant mail arrives, which wakes a
Cloud Run service (scaled to zero the rest of the time) to handle it. No always-on machine,
near-instant reaction instead of a 10s lag, and likely $0/month given the actual email volume.

What this needs, roughly:

1. **Pub/Sub topic + push subscription** pointing at a Cloud Run URL, with Gmail's push
   service account (`gmail-api-push@system.gserviceaccount.com`) granted publish rights on
   the topic.
2. **`users.watch()` registration** - a call (not a gcloud command) that tells Gmail to start
   publishing to that topic. Expires after 7 days, needs a renewal call on a schedule
   (Cloud Scheduler hitting a `/renew-watch` endpoint works, and conveniently lines up with
   the existing 7-day refresh-token cadence below).
3. **Stateless rewrite**: `state.json` and `token.json` currently live on local disk, which
   doesn't survive a scale-to-zero container. These move to Firestore (state/dedupe) and
   Secret Manager (OAuth tokens).
4. **HTTP handler instead of the poll loop**: the current `pollOnce()` loop in `poll.js`
   becomes a POST handler triggered by the Pub/Sub push, which calls `users.history.list()`
   to find what changed since the last known `historyId`, then runs the same
   parse -> confirm -> label -> reply logic unchanged.
5. **Dockerfile** with Playwright/Chromium deps for the Cloud Run image.

The 7-day OAuth refresh-token expiry (Testing-status app, see above) is unaffected by this
move - still needs a manual `npm run auth` weekly, just re-authorizing against a secret in
Secret Manager instead of a local file.
