import { chromium } from 'playwright';
import { getHeader, findTextPlainPart, screenshotPathFor } from './shared.js';

const SENDER_MATCH = 'noreply-reservations@tebi.co';
const SUBJECT_MATCH = /spot is available/i;
const CONFIRM_LINK_RE = /https:\/\/live\.tebi\.co\/ecom\/reservations\/\S+/;

// Tebi's confirm-link page renders one of a few states depending on timing:
// - still-waitlisted ("Waitlist confirmed" / "We will contact you when a spot becomes available")
//   -> the link registered you but did NOT secure the table (spot likely taken by someone else first)
// - booked/reserved confirmation -> no "waitlist" language, shows a booked/reservation-confirmed heading
// - error/expired page
// We don't yet have a real sample of the "booked" state, so success detection is a heuristic:
// treat it as booked only if the waitlist-still-pending phrase is ABSENT and no error indicators are present.
const STILL_WAITLISTED_RE = /waitlist confirmed|we will contact you when a spot becomes available/i;
const ERROR_RE = /expired|no longer available|something went wrong|not found/i;

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

    try {
      await page.goto(invitation.confirmLink, { waitUntil: 'networkidle', timeout: 30_000 });

      // give any client-side rendering a moment to settle
      await page.waitForTimeout(1500);

      const bodyText = await page.innerText('body');

      const screenshotPath = screenshotPathFor(invitation.messageId);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      const stillWaitlisted = STILL_WAITLISTED_RE.test(bodyText);
      const hasError = ERROR_RE.test(bodyText);

      let outcome;
      if (hasError) {
        outcome = 'error';
      } else if (stillWaitlisted) {
        outcome = 'still_waitlisted';
      } else {
        outcome = 'booked';
      }

      return { outcome, bodyText, screenshotPath, finalUrl: page.url() };
    } finally {
      await browser.close();
    }
  },

  describe({ invitation, attempt }) {
    const header = `${invitation.restaurantName} - ${invitation.eventName || ''} on ${invitation.date}${invitation.partySize ? ` (${invitation.partySize} people)` : ''}`;

    if (attempt.outcome === 'booked') {
      return {
        headline: 'Reservation booked!',
        detail: `${header}\n\nBooked automatically. Screenshot attached.`,
      };
    }
    if (attempt.outcome === 'still_waitlisted') {
      return {
        headline: 'Waitlist spot missed',
        detail: `${header}\n\nTried to confirm but the page still shows "waitlist confirmed" - the spot was likely taken before we got to it. Still on the waitlist.\n\nScreenshot attached.`,
      };
    }
    return {
      headline: 'Reservation bot error',
      detail: `${header}\n\nSomething went wrong trying to confirm this automatically (outcome: ${attempt.outcome}). Please check manually:\n${invitation.confirmLink}\n\nScreenshot attached.`,
    };
  },
};
