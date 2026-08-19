import { chromium } from 'playwright';
import { getHeader, findTextPlainPart } from './shared.js';
import { ScreenshotTrace } from './trace.js';
import { log } from '../logger.js';

const SENDER_MATCH = 'noreply-reservations@tebi.co';
const SUBJECT_MATCH = /spot is available/i;
const CONFIRM_LINK_RE = /https:\/\/live\.tebi\.co\/ecom\/reservations\/\S+/;

// Tebi's confirm-link page renders one of a few states depending on timing:
// - still-waitlisted ("Waitlist confirmed" / "We will contact you when a spot becomes available")
//   -> the link registered you but did NOT secure the table
// - booked/reserved confirmation -> no "waitlist" language, shows a booked/reservation-confirmed heading
// - error/expired page
// We don't yet have a real sample of the "booked" state, so success detection is a heuristic:
// treat it as booked only if the waitlist-still-pending phrase is ABSENT and no error indicators are present.
const STILL_WAITLISTED_RE = /waitlist confirmed|we will contact you when a spot becomes available/i;
const ERROR_RE = /expired|no longer available|something went wrong|not found/i;

// The restaurant says a deposit (~£40) is taken at booking time, so the flow
// almost certainly continues into a payment step we've never seen. Until we
// have a real trace of it we don't try to drive it - we just record loudly
// whether the page in front of us is asking for money or card details.
const PAYMENT_RE = /deposit|prepayment|pre-authoris|pre-authoriz|card details|payment|£\s*\d/i;

// Settle time after load. Kept as a named constant because it's the main knob
// between "screenshot caught a spinner" and "wasted a second of a race".
const SETTLE_MS = 1500;

/** @type {import('./types.js').Handler} */
export const tebiHandler = {
  name: 'tebi',

  inboxQuery: `is:unread from:${SENDER_MATCH} subject:"spot is available"`,

  isHandled({ message }) {
    const headers = message.payload.headers;
    const from = getHeader(headers, 'From');
    const subject = getHeader(headers, 'Subject');
    return from.includes(SENDER_MATCH) && SUBJECT_MATCH.test(subject);
  },

  readInvitation({ message }) {
    const headers = message.payload.headers;
    const from = getHeader(headers, 'From');
    const subject = getHeader(headers, 'Subject');
    const text = findTextPlainPart(message.payload);

    if (!text) {
      throw new Error(`No text/plain part found for message ${message.id}`);
    }

    // quoted-printable soft-wraps end lines with '='; strip those before matching
    const unwrapped = text.replace(/=\r?\n/g, '');

    const linkMatch = unwrapped.match(CONFIRM_LINK_RE);
    if (!linkMatch) {
      throw new Error(`No confirm link found in message ${message.id}`);
    }
    // trim any trailing quoted-printable artifacts or whitespace
    const confirmLink = linkMatch[0].replace(/=+$/, '').trim();

    const restaurantMatch = from.match(/^"?([^"<]+)"?\s*</);
    const restaurantName = restaurantMatch ? restaurantMatch[1].trim() : from;

    const partySizeMatch = unwrapped.match(/for (\d+) people/i);
    const partySize = partySizeMatch ? parseInt(partySizeMatch[1], 10) : null;

    // subject form: "A spot is available for {event} on {date}"
    const eventMatch = subject.match(/available for (.+?) on (.+)$/i);

    return {
      messageId: message.id,
      threadId: message.threadId,
      subject,
      restaurantName,
      eventName: eventMatch ? eventMatch[1].trim() : null,
      date: eventMatch ? eventMatch[2].trim() : null,
      partySize,
      confirmLink,
    };
  },

  async claimSpot({ invitation }) {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const trace = new ScreenshotTrace(invitation.messageId);

    // Any navigation the page performs on its own (redirect, SPA route change,
    // post-submit hop) is a step in the flow we'd otherwise never see, because
    // we only screenshot at points we chose. Capturing on the event means the
    // timeline records the page's moves as well as ours.
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      trace.capture(page, 'navigated').catch(() => {});
    });

    try {
      await page.goto(invitation.confirmLink, { waitUntil: 'networkidle', timeout: 30_000 });
      await trace.capture(page, 'loaded');

      // give any client-side rendering a moment to settle
      await page.waitForTimeout(SETTLE_MS);
      await trace.capture(page, 'settled');

      const bodyText = await page.innerText('body');

      // What can we actually do here? The current outcome heuristic reads text
      // only, which cannot distinguish "this page is the end of the flow" from
      // "this page has a button we never pressed". Recording the controls makes
      // that difference visible in the trace instead of invisible in a verdict.
      const actions = await readAvailableActions(page);
      if (actions.length) {
        log.info(`[${invitation.messageId}] page offers: ${actions.map((a) => `"${a.text}"`).join(', ')}`);
      } else {
        log.info(`[${invitation.messageId}] page offers no clickable controls`);
      }

      const mentionsPayment = PAYMENT_RE.test(bodyText);
      if (mentionsPayment) {
        log.info(`[${invitation.messageId}] page mentions payment/deposit - capturing for review, not driving it`);
      }

      const stillWaitlisted = STILL_WAITLISTED_RE.test(bodyText);
      const hasError = ERROR_RE.test(bodyText);

      let outcome;
      if (hasError) {
        outcome = 'error';
      } else if (stillWaitlisted) {
        outcome = 'still_waitlisted';
      } else if (mentionsPayment) {
        // 'booked' is inferred from the ABSENCE of waitlist language, so a
        // payment page - which has none - would otherwise read as success and
        // page us saying the table is secured when nothing has been paid.
        // Needs a human: report it as an error rather than a false win.
        outcome = 'error';
      } else {
        outcome = 'booked';
      }

      await trace.capture(page, `final-${outcome}`);

      // Listener-driven frames are queued, not awaited - drain them so the
      // manifest describes the whole timeline rather than part of it.
      await trace.settle();

      const manifestPath = trace.writeManifest({
        messageId: invitation.messageId,
        restaurantName: invitation.restaurantName,
        eventName: invitation.eventName,
        date: invitation.date,
        confirmLink: invitation.confirmLink,
        outcome,
        finalUrl: page.url(),
        mentionsPayment,
        actions,
      });

      const frames = trace.frames;

      return {
        outcome,
        bodyText,
        // poll.js attaches a single screenshot to the reply; the last frame is
        // the one that justifies the outcome, so that stays the headline image.
        screenshotPath: frames.at(-1)?.path ?? null,
        traceDir: trace.dir,
        manifestPath,
        frames,
        mentionsPayment,
        actions,
        finalUrl: page.url(),
      };
    } finally {
      await browser.close();
    }
  },

  describe({ invitation, attempt }) {
    const header = `${invitation.restaurantName} - ${invitation.eventName || ''} on ${invitation.date}${invitation.partySize ? ` (${invitation.partySize} people)` : ''}`;
    const trace = describeTrace(attempt);

    if (attempt.outcome === 'booked') {
      return {
        headline: 'Reservation booked!',
        detail: `${header}\n\nBooked automatically. Screenshot attached.${trace}`,
      };
    }
    if (attempt.outcome === 'still_waitlisted') {
      return {
        headline: 'Waitlist spot missed',
        detail: `${header}\n\nTried to confirm but the page still shows "waitlist confirmed" - either the spot went before we got there, or the flow needed a step we didn't take. The trace below shows which.\n\nScreenshot attached.${trace}`,
      };
    }
    if (attempt.mentionsPayment) {
      return {
        headline: 'Deposit needed - finish manually',
        detail: `${header}\n\nThe page is asking for a payment or deposit, which the bot does not attempt. The spot is NOT booked. Open the link and finish it yourself:\n${invitation.confirmLink}\n\nScreenshot attached.${trace}`,
      };
    }
    return {
      headline: 'Reservation bot error',
      detail: `${header}\n\nSomething went wrong trying to confirm this automatically (outcome: ${attempt.outcome}). Please check manually:\n${invitation.confirmLink}\n\nScreenshot attached.${trace}`,
    };
  },
};

// Buttons/links/submits the page is offering, in DOM order, with enough detail
// to tell an active control from a disabled or hidden one.
async function readAvailableActions(page) {
  try {
    return await page.$$eval(
      'button, a[href], input[type=submit], [role=button]',
      (nodes) =>
        nodes
          .map((el) => ({
            text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
            tag: el.tagName.toLowerCase(),
            href: el.getAttribute('href'),
            disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
            visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
          }))
          .filter((a) => a.text && a.visible),
    );
  } catch (err) {
    log.error('[trace] could not read page actions:', err.message);
    return [];
  }
}

function describeTrace(attempt) {
  if (!attempt.frames?.length) return '';

  const lines = attempt.frames.map((f) => `  ${f.index}. ${f.label} (+${f.atMs}ms)${f.url ? `\n     ${f.url}` : ''}`);

  const parts = [
    '',
    '',
    `Timeline (${attempt.frames.length} frames, full set in ${attempt.traceDir}):`,
    ...lines,
  ];

  if (attempt.actions?.length) {
    parts.push('', `Controls on the final page: ${attempt.actions.map((a) => `"${a.text}"${a.disabled ? ' (disabled)' : ''}`).join(', ')}`);
  }
  if (attempt.mentionsPayment) {
    parts.push('', 'This page mentions a payment/deposit. The bot did NOT attempt to pay - check the trace and finish manually if needed.');
  }

  return parts.join('\n');
}
