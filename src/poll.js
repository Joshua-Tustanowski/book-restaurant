import fs from 'fs';
import path from 'path';
import { listUnreadFrom, getFullMessage, applyLabel, replyInThread } from './gmail-client.js';
import { isTebiWaitlistEmail, parseTebiWaitlistEmail } from './parse-tebi-email.js';
import { confirmReservation } from './confirm-reservation.js';
import { isMessageProcessed, isEventAlreadyBooked, recordOutcome } from './state.js';
import { sendPushoverAlert } from './pushover.js';

const POLL_INTERVAL_MS = 10_000;

const GMAIL_QUERY = 'is:unread from:noreply-reservations@tebi.co subject:"spot is available"';

const LABEL_BOOKED = 'Reservations/Booked';
const LABEL_NEEDS_YOU = 'Reservations/Needs-you';

function replyBodyFor(parsed, result) {
  const header = `${parsed.restaurantName} - ${parsed.eventName || ''} on ${parsed.date}${parsed.partySize ? ` (${parsed.partySize} people)` : ''}`;

  if (result.outcome === 'booked') {
    return `${header}\n\nBooked automatically. Screenshot attached.`;
  }
  if (result.outcome === 'still_waitlisted') {
    return `${header}\n\nTried to confirm but the page still shows "waitlist confirmed" - the spot was likely taken before we got to it. Still on the waitlist.\n\nScreenshot attached.`;
  }
  return `${header}\n\nSomething went wrong trying to confirm this automatically (outcome: ${result.outcome}). Please check manually:\n${parsed.confirmLink}\n\nScreenshot attached.`;
}

function pushTitleFor(result) {
  if (result.outcome === 'booked') return 'Reservation booked!';
  if (result.outcome === 'still_waitlisted') return 'Waitlist spot missed';
  return 'Reservation bot error';
}

async function processMessage(id) {
  const message = await getFullMessage(id);

  if (!isTebiWaitlistEmail(message)) return;

  let parsed;
  try {
    parsed = parseTebiWaitlistEmail(message);
  } catch (err) {
    console.error(`[${id}] parse failed:`, err.message);
    return;
  }

  if (isEventAlreadyBooked(parsed)) {
    console.log(`[${id}] ${parsed.restaurantName} - ${parsed.eventName} on ${parsed.date} already booked, skipping`);
    return;
  }

  console.log(`[${id}] ${parsed.restaurantName} - ${parsed.eventName} on ${parsed.date}, confirming...`);

  const result = await confirmReservation(parsed.confirmLink, { messageId: id });
  console.log(`[${id}] outcome: ${result.outcome}`);

  const label = result.outcome === 'booked' ? LABEL_BOOKED : LABEL_NEEDS_YOU;
  await applyLabel(id, label);

  // Reply goes to the account owner (self-note in the thread), not the restaurant -
  // reply-to on these emails points at the restaurant's own inbox.
  const headers = message.payload.headers;
  const toHeader = headers.find((h) => h.name.toLowerCase() === 'to');

  await replyInThread({
    threadId: message.threadId,
    messageId: message.id,
    to: toHeader.value,
    subject: parsed.subject,
    bodyText: replyBodyFor(parsed, result),
    attachment: {
      filename: path.basename(result.screenshotPath),
      contentType: 'image/png',
      data: fs.readFileSync(result.screenshotPath),
    },
  });

  recordOutcome(id, parsed, result.outcome);

  await sendPushoverAlert({
    title: pushTitleFor(result),
    message: `${parsed.restaurantName} - ${parsed.eventName || ''} on ${parsed.date}\n\n${parsed.confirmLink}`,
    url: parsed.confirmLink,
    urlTitle: 'Open confirm link',
  });
}

function isAuthExpiredError(err) {
  return err?.response?.data?.error === 'invalid_grant' || err?.message?.includes('invalid_grant');
}

async function pollOnce() {
  const messages = await listUnreadFrom(GMAIL_QUERY);

  const toProcess = messages.filter((m) => !isMessageProcessed(m.id));
  if (toProcess.length === 0) {
    console.log(new Date().toISOString(), '- no new waitlist emails');
    return;
  }

  for (const { id } of toProcess) {
    try {
      await processMessage(id);
    } catch (err) {
      console.error(`[${id}] failed:`, err);
      await sendPushoverAlert({
        title: 'Reservation bot crashed',
        message: `Message ${id} threw before finishing: ${err.message}`,
      });
    }
  }
}

async function main() {
  const watch = process.argv.includes('--watch');

  await pollOnce();

  if (watch) {
    console.log(`Watching every ${POLL_INTERVAL_MS / 1000}s. Ctrl+C to stop.`);
    const timer = setInterval(async () => {
      try {
        await pollOnce();
      } catch (err) {
        if (isAuthExpiredError(err)) {
          console.error('\nRefresh token expired or revoked (Testing-status OAuth apps expire it after 7 days).');
          console.error('Run: rm token.json && npm run auth\n');
          clearInterval(timer);
          process.exit(1);
        }
        console.error('poll cycle failed:', err);
      }
    }, POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
