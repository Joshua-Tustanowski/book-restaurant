import fs from 'fs';
import path from 'path';
import { listUnreadFrom, getFullMessage, applyLabel, replyInThread } from './gmail-client.js';
import { activeHandler } from './handlers/index.js';
import { isMessageProcessed, isEventAlreadyBooked, recordOutcome } from './state.js';
import { sendPushoverAlert } from './pushover.js';
import { log } from './logger.js';

const POLL_INTERVAL_MS = 10_000;

const LABEL_BOOKED = 'Reservations/Booked';
const LABEL_NEEDS_YOU = 'Reservations/Needs-you';

const handler = activeHandler();

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
  log.info(`[${id}] outcome: ${attempt.outcome}`);

  const { headline, detail } = handler.describe({ invitation, attempt });

  const label = attempt.outcome === 'booked' ? LABEL_BOOKED : LABEL_NEEDS_YOU;
  await applyLabel(id, label);

  // Reply goes to the account owner (self-note in the thread), not the restaurant -
  // reply-to on these emails points at the restaurant's own inbox.
  const headers = message.payload.headers;
  const toHeader = headers.find((h) => h.name.toLowerCase() === 'to');

  await replyInThread({
    threadId: message.threadId,
    messageId: message.id,
    to: toHeader.value,
    subject: invitation.subject,
    bodyText: detail,
    attachment: {
      filename: path.basename(attempt.screenshotPath),
      contentType: 'image/png',
      data: fs.readFileSync(attempt.screenshotPath),
    },
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

  const toProcess = messages.filter((m) => !isMessageProcessed(m.id));
  if (toProcess.length === 0) {
    log.info('no new waitlist emails');
    return;
  }

  for (const { id } of toProcess) {
    try {
      await processMessage(id);
    } catch (err) {
      log.error(`[${id}] failed:`, err);
      await sendPushoverAlert({
        title: 'Reservation bot crashed',
        message: `Message ${id} threw before finishing: ${err.message}`,
      });
    }
  }
}

async function main() {
  const watch = process.argv.includes('--watch');

  log.info(`handler: ${handler.name} | query: ${handler.inboxQuery}`);

  await pollOnce();

  if (watch) {
    log.info(`Watching every ${POLL_INTERVAL_MS / 1000}s. Ctrl+C to stop.`);
    const timer = setInterval(async () => {
      try {
        await pollOnce();
      } catch (err) {
        if (isAuthExpiredError(err)) {
          log.error('Refresh token expired or revoked (Testing-status OAuth apps expire it after 7 days).');
          log.error('Run: rm token.json && npm run auth');
          clearInterval(timer);
          process.exit(1);
        }
        log.error('poll cycle failed:', err);
      }
    }, POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
