import { chromium } from 'playwright';
import { getHeader, findTextPlainPart } from './shared.js';
import { ScreenshotTrace } from './trace.js';

// Exercises the whole framework - Gmail match, parse, browser step, screenshot,
// label, threaded reply, state, Pushover - without touching a real reservation.
// Trigger it by emailing yourself a subject like:
//
//   [bot-test]: sushi london
//
// Anything after the prefix becomes the search term the browser step runs, so a
// new test is a new email rather than a restart.

const SUBJECT_PREFIX = process.env.TEST_SUBJECT_PREFIX || '[bot-test]';
const DEFAULT_SEARCH_QUERY = process.env.TEST_SEARCH_QUERY || 'test reservation';

const VALID_OUTCOMES = ['booked', 'payment_required', 'still_waitlisted', 'error'];
const DEFAULT_OUTCOME = 'booked';

// Google and DuckDuckGo both serve headless Chromium a consent wall or a CAPTCHA
// instead of results, which makes for a useless screenshot. Bing renders real
// results with no gate, so the attachment shows something worth looking at.
const SEARCH_URL = 'https://www.bing.com/search';

function forcedOutcome() {
  const raw = process.env.TEST_OUTCOME;
  if (!raw) return DEFAULT_OUTCOME;
  if (!VALID_OUTCOMES.includes(raw)) {
    throw new Error(`TEST_OUTCOME must be one of ${VALID_OUTCOMES.join(' | ')}, got "${raw}"`);
  }
  return raw;
}

// "[bot-test]: sushi london" -> "sushi london"; bare "[bot-test]:" falls back.
function searchTermFrom(subject) {
  const afterPrefix = subject.slice(subject.indexOf(SUBJECT_PREFIX) + SUBJECT_PREFIX.length);
  const term = afterPrefix.replace(/^\s*:\s*/, '').trim();
  return term || DEFAULT_SEARCH_QUERY;
}

/** @type {import('./types.js').Handler} */
export const testHandler = {
  name: 'test',

  // The outcome reply lands in the same thread, from and to the same address, with
  // the prefix still in its "Re:" subject - so without excluding sent mail the bot
  // would answer its own reply and loop. -in:sent drops it; the Re: guard in
  // isHandled covers the case where Gmail hasn't finished labelling it yet.
  inboxQuery: `is:unread subject:"${SUBJECT_PREFIX}"`,

  isHandled({ message }) {
    const subject = getHeader(message.payload.headers, 'Subject');
    if (/^\s*re:/i.test(subject)) return false;
    return subject.includes(SUBJECT_PREFIX);
  },

  // Deliberately relaxed compared to the Tebi parser: a test email is hand-typed
  // from a phone, so every field except the subject has a default and nothing throws.
  readInvitation({ message }) {
    const headers = message.payload.headers;
    const subject = getHeader(headers, 'Subject');
    const from = getHeader(headers, 'From');
    const text = findTextPlainPart(message.payload) || '';

    const searchTerm = searchTermFrom(subject);

    const senderMatch = from.match(/^"?([^"<]+)"?\s*</);
    const partySizeMatch = text.match(/(\d+)\s*people/i);

    return {
      messageId: message.id,
      threadId: message.threadId,
      subject,
      restaurantName: senderMatch ? senderMatch[1].trim() : from || 'Test sender',
      eventName: `test search: ${searchTerm}`,
      date: new Date().toISOString().slice(0, 10),
      partySize: partySizeMatch ? parseInt(partySizeMatch[1], 10) : null,
      // Not a reservation link - the URL the no-op browser step will visit.
      confirmLink: `${SEARCH_URL}?q=${encodeURIComponent(searchTerm)}`,
    };
  },

  // No-op stand-in for a real confirmation: drives a real browser at a harmless
  // page and screenshots it, so the attachment and reply paths get exercised,
  // then reports whatever outcome TEST_OUTCOME asked for.
  async claimSpot({ invitation }) {
    const outcome = forcedOutcome();

    const browser = await chromium.launch();
    const page = await browser.newPage();
    const trace = new ScreenshotTrace(invitation.messageId);

    try {
      await page.goto(invitation.confirmLink, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await trace.capture(page, 'loaded');

      await page.waitForTimeout(1000);
      await trace.capture(page, `final-${outcome}`);

      const bodyText = await page.innerText('body');

      // Listener-driven frames are queued, not awaited - drain them so the
      // manifest describes the whole timeline rather than part of it.
      await trace.settle();

      const manifestPath = trace.writeManifest({
        messageId: invitation.messageId,
        confirmLink: invitation.confirmLink,
        outcome,
        finalUrl: page.url(),
      });

      const frames = trace.frames;

      return {
        outcome,
        bodyText,
        screenshotPath: frames.at(-1)?.path ?? null,
        traceDir: trace.dir,
        manifestPath,
        frames,
        finalUrl: page.url(),
      };
    } finally {
      await browser.close();
    }
  },

  describe({ invitation, attempt }) {
    const header = `TEST MODE - ${invitation.eventName} (${invitation.date})`;

    return {
      headline: `[test] ${attempt.outcome}`,
      detail: [
        header,
        '',
        `Forced outcome: ${attempt.outcome} (TEST_OUTCOME)`,
        `Visited: ${attempt.finalUrl}`,
        '',
        'No reservation was attempted. Screenshot attached.',
      ].join('\n'),
    };
  },
};
