# book-restaurant

Auto-confirms Tebi waitlist reservation emails (e.g. "A spot is available for...") the moment they land in Gmail, without needing to watch the inbox.

Currently scoped to Tebi's waitlist notify-and-confirm flow (sender `noreply-reservations@tebi.co`).
Other restaurant platforms (Resy, OpenTable, direct booking pages) are not yet supported - the parser
and confirm step are Tebi-specific for now.

## How it works

1. Polls Gmail every 10s for unread mail from Tebi matching "spot is available".
2. Parses the plain-text body for restaurant name, event, date, party size, and the confirm link.
3. Opens the confirm link in a headless browser (Playwright) and inspects the resulting page.
4. Classifies the outcome:
   - `booked` - no "still waitlisted" language present
   - `still_waitlisted` - page still says "Waitlist confirmed / we will contact you" (spot was likely taken by someone else first)
   - `error` - expired/not-found/error language detected
5. Labels the email (`Reservations/Booked` or `Reservations/Needs-you`) and replies in the thread to your own inbox with the outcome and the screenshot attached.
6. Records the outcome in `state.json`, keyed by restaurant + event + date. If a later email arrives for an event already recorded as `booked`, it's skipped rather than re-attempted.
7. Sends a Pushover alert to your phone at emergency priority (repeats until acknowledged) for every outcome - `booked`, `still_waitlisted`, or `error`.

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

At the current 10s poll interval, a no-match cycle costs 5 units (list only) - 8,640 cycles/day = ~43,200 units/day, a trivial fraction of the daily quota. A cycle with a match costs roughly 115 units (list + get + modify + send). Polling far more aggressively (down to ~1s) would still stay well under both caps - the real constraint on interval is local resource use (spinning up Playwright/Chromium per match), not Gmail's API limits.

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

- Success-state detection (`booked`) is a heuristic - we haven't seen a real "booked" page yet, only the "still waitlisted" state, since the one live email tested against had already lost its spot. Verify the first real `booked` classification against a screenshot before trusting it fully.
- Local-only: no GCP Pub/Sub push, no watch renewal. Polling stops when the process isn't running.
- Only handles Tebi's waitlist flow. A genuinely different restaurant platform needs its own parser + confirm adapter.

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
4. **HTTP handler instead of `setInterval`**: the current `pollOnce()` loop in `poll.js`
   becomes a POST handler triggered by the Pub/Sub push, which calls `users.history.list()`
   to find what changed since the last known `historyId`, then runs the same
   parse -> confirm -> label -> reply logic unchanged.
5. **Dockerfile** with Playwright/Chromium deps for the Cloud Run image.

The 7-day OAuth refresh-token expiry (Testing-status app, see above) is unaffected by this
move - still needs a manual `npm run auth` weekly, just re-authorizing against a secret in
Secret Manager instead of a local file.
