import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots');

// Tebi's confirm-link page renders one of a few states depending on timing:
// - still-waitlisted ("Waitlist confirmed" / "We will contact you when a spot becomes available")
//   -> the link registered you but did NOT secure the table (spot likely taken by someone else first)
// - booked/reserved confirmation -> no "waitlist" language, shows a booked/reservation-confirmed heading
// - error/expired page
// We don't yet have a real sample of the "booked" state, so success detection is a heuristic:
// treat it as booked only if the waitlist-still-pending phrase is ABSENT and no error indicators are present.
const STILL_WAITLISTED_RE = /waitlist confirmed|we will contact you when a spot becomes available/i;
const ERROR_RE = /expired|no longer available|something went wrong|not found/i;

export async function confirmReservation(confirmLink, { messageId } = {}) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(confirmLink, { waitUntil: 'networkidle', timeout: 30_000 });

    // give any client-side rendering a moment to settle
    await page.waitForTimeout(1500);

    const bodyText = await page.innerText('body');

    const screenshotPath = path.join(SCREENSHOT_DIR, `${messageId || Date.now()}.png`);
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
}
