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

// A live spot leads to a card-guarantee step, not a prepayment: Tebi stores a
// card and charges a no-show fee only if you miss the booking or cancel late.
// The bot never drives that step - it stops at the boundary and hands over.
const PAYMENT_RE = /card details|security code|no.?show|will be charged|guarantee your reservation|deposit|prepayment|pre-authoris|pre-authoriz/i;

// Adyen Secured Fields render the card inputs inside cross-origin iframes, so
// the card number never enters Tebi's DOM. The iframe host is a far stronger
// signal that we're on the payment step than any wording, which changes per
// restaurant and per locale.
const ADYEN_FRAME_RE = /checkoutshopper[^/]*\.adyen\.com/i;

// "This reservation expires in 59 minutes 48 seconds" - reaching the payment
// step means the spot is already HELD. That window is the whole reason the bot
// can stop here safely: the race is getting to the form, not paying.
const HOLD_EXPIRY_RE = /reservation expires in ([^.\n]+)/i;

// The fee quoted alongside the card form, e.g. "A fee of £20.00 will be charged".
const FEE_RE = /(?:fee of\s*)?(£\s?\d+(?:\.\d{2})?)/i;

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

      // Two independent signals; either alone is enough. The iframe survives
      // reworded copy, the text survives Adyen being swapped out.
      const hasAdyenFrame = page.frames().some((f) => ADYEN_FRAME_RE.test(f.url()));
      const mentionsPayment = hasAdyenFrame || PAYMENT_RE.test(bodyText);

      const holdExpiresIn = bodyText.match(HOLD_EXPIRY_RE)?.[1]?.trim() ?? null;
      const fee = mentionsPayment ? (bodyText.match(FEE_RE)?.[1]?.replace(/\s/g, '') ?? null) : null;

      if (mentionsPayment) {
        log.info(
          `[${invitation.messageId}] payment step reached${hasAdyenFrame ? ' (Adyen frame)' : ' (text match)'}` +
            `${fee ? `, fee ${fee}` : ''}${holdExpiresIn ? `, hold expires in ${holdExpiresIn}` : ''}` +
            ' - spot held, handing over for manual completion',
        );
      }

      const stillWaitlisted = STILL_WAITLISTED_RE.test(bodyText);
      const hasError = ERROR_RE.test(bodyText);

      let outcome;
      if (hasError) {
        outcome = 'error';
      } else if (stillWaitlisted) {
        outcome = 'still_waitlisted';
      } else if (mentionsPayment) {
        // Distinct from both 'booked' and 'error'. The spot IS held - this is
        // the good path - but it is not booked until a human enters the card,
        // so calling it either would misreport what happened.
        outcome = 'payment_required';
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
        holdExpiresIn,
        fee,
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
        holdExpiresIn,
        fee,
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
    if (attempt.outcome === 'payment_required') {
      // The deadline goes first in both headline and body: this is the one
      // outcome where the reply is a call to action on a clock, not a report.
      const deadline = attempt.holdExpiresIn ? ` - ${attempt.holdExpiresIn} left` : '';
      return {
        headline: `Spot held${deadline} - add card`,
        detail: [
          header,
          '',
          `THE SPOT IS HELD${attempt.holdExpiresIn ? ` AND EXPIRES IN ${attempt.holdExpiresIn.toUpperCase()}` : ''}.`,
          '',
          'Tebi is asking for card details to guarantee the reservation. The bot',
          'does not enter card details, so the last step is yours:',
          '',
          invitation.confirmLink,
          '',
          attempt.fee
            ? `Nothing is charged now. ${attempt.fee} applies only if you no-show or cancel late.`
            : 'Card is stored as a guarantee - check the page for the exact terms.',
          '',
          'Not booked until you finish it. Screenshot attached.',
        ].join('\n') + trace,
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
