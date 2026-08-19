import fs from 'fs';
import path from 'path';
import { listUnreadFrom, getFullMessage, applyLabel, replyInThread } from './gmail-client.js';
import { activeHandler } from './handlers/index.js';
import { isMessageProcessed, isEventAlreadyBooked, recordOutcome } from './state.js';
import { sendPushoverAlert } from './pushover.js';
import { log } from './logger.js';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MIN_POLL_INTERVAL_MS = 1_000;

const LABEL_BOOKED = 'Reservations/Booked';
const LABEL_NEEDS_YOU = 'Reservations/Needs-you';

const handler = activeHandler();

// Messages currently being handled by this process. A message can stay in the
// Gmail result set for the whole time claimSpot() drives the browser (it's still
// unread, and state.json isn't written until the outcome is known), so without
// this a second cycle would pick it up and confirm/label/reply/page all over again.
const inFlight = new Set();

// CLI flag beats env var beats default, so a one-off run can override a VM's .env.
function resolvePollIntervalMs() {
  const flag = process.argv.find((a) => a.startsWith('--interval='))?.split('=')[1];
  const raw = flag ?? process.env.POLL_INTERVAL_MS;

  if (raw === undefined || raw === '') return DEFAULT_POLL_INTERVAL_MS;

  const source = flag !== undefined ? '--interval' : 'POLL_INTERVAL_MS';
  const ms = Number(raw);

  if (!Number.isFinite(ms)) {
    throw new Error(`${source}: expected a number of milliseconds, got "${raw}"`);
  }
  if (ms < MIN_POLL_INTERVAL_MS) {
    throw new Error(`${source}: ${ms}ms is below the ${MIN_POLL_INTERVAL_MS}ms minimum`);
  }

  return ms;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processMessage(id) {
  const message = await getFullMessage(id);

  if (!handler.isHandled({ message })) return;

  let invitation;
  try {
    invitation = handler.readInvitation({ message });
  } catch (err) {
    log.error(`[${id}] parse failed:`, err.message);
    return;
  }

  if (isEventAlreadyBooked(invitation)) {
    log.info(`[${id}] ${invitation.restaurantName} - ${invitation.eventName} on ${invitation.date} already booked, skipping`);
    return;
  }

  log.info(`[${id}] ${invitation.restaurantName} - ${invitation.eventName} on ${invitation.date}, confirming...`);

  const attempt = await handler.claimSpot({ invitation });
  log.info(`[${id}] outcome: ${attempt.outcome}${attempt.frames?.length ? ` (${attempt.frames.length} frames in ${attempt.traceDir})` : ''}`);

  const { headline, detail } = handler.describe({ invitation, attempt });

  const label = attempt.outcome === 'booked' ? LABEL_BOOKED : LABEL_NEEDS_YOU;
  await applyLabel(id, label);

  // Reply goes to the account owner (self-note in the thread), not the restaurant -
  // reply-to on these emails points at the restaurant's own inbox.
  const headers = message.payload.headers;
  const toHeader = headers.find((h) => h.name.toLowerCase() === 'to');

  // A missing or unreadable screenshot must not cost us the notification - the
  // outcome is the point, the image is supporting evidence.
  let attachment;
  try {
    if (attempt.screenshotPath) {
      attachment = {
        filename: path.basename(attempt.screenshotPath),
        contentType: 'image/png',
        data: fs.readFileSync(attempt.screenshotPath),
      };
    } else {
      log.error(`[${id}] no screenshot captured; replying without an attachment`);
    }
  } catch (err) {
    log.error(`[${id}] could not read screenshot ${attempt.screenshotPath}:`, err.message);
  }

  await replyInThread({
    threadId: message.threadId,
    messageId: message.id,
    to: toHeader.value,
    subject: invitation.subject,
    bodyText: detail,
    attachment,
  });

  recordOutcome(id, invitation, attempt.outcome);

  await sendPushoverAlert({
    title: headline,
    message: `${invitation.restaurantName} - ${invitation.eventName || ''} on ${invitation.date}\n\n${invitation.confirmLink}`,
    url: invitation.confirmLink,
    urlTitle: 'Open confirm link',
  });
}

function isAuthExpiredError(err) {
  return err?.response?.data?.error === 'invalid_grant' || err?.message?.includes('invalid_grant');
}

async function pollOnce() {
  const messages = await listUnreadFrom(handler.inboxQuery);

  const toProcess = messages.filter((m) => !isMessageProcessed(m.id) && !inFlight.has(m.id));
  if (toProcess.length === 0) {
    log.info('no new waitlist emails');
    return;
  }

  for (const { id } of toProcess) {
    inFlight.add(id);
    try {
      await processMessage(id);
    } catch (err) {
      log.error(`[${id}] failed:`, err);
      await sendPushoverAlert({
        title: 'Reservation bot crashed',
        message: `Message ${id} threw before finishing: ${err.message}`,
      });
    } finally {
      // Dropped on failure too: nothing was recorded in state.json, so the next
      // cycle should retry rather than silently abandon the spot.
      inFlight.delete(id);
    }
  }
}

async function main() {
  const watch = process.argv.includes('--watch');
  const intervalMs = resolvePollIntervalMs();

  log.info(`handler: ${handler.name} | query: ${handler.inboxQuery}`);

  await pollOnce();

  if (!watch) return;

  // Sequential loop rather than setInterval: a cycle can outlast the interval
  // (claimSpot drives a real browser), and setInterval would fire the next one
  // on top of it. The interval is the gap between cycles, not a fixed period.
  log.info(`Watching every ${intervalMs / 1000}s. Ctrl+C to stop.`);

  for (;;) {
    await sleep(intervalMs);

    try {
      await pollOnce();
    } catch (err) {
      if (isAuthExpiredError(err)) {
        log.error('Refresh token expired or revoked (Testing-status OAuth apps expire it after 7 days).');
        log.error('Run: rm token.json && npm run auth');
        process.exit(1);
      }
      log.error('poll cycle failed:', err);
    }
  }
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
