import fs from 'fs';
import path from 'path';
import { log } from '../logger.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots');

// A single claimSpot() run captures many screenshots, not one. The Tebi confirm
// link is a multi-step reservation flow (the email says "Reserve now to secure
// your spot"), so the interesting question is never "what did the page look
// like" but "what did it look like at each step, and in what order". A bare
// timestamp doesn't answer that: several frames can land in the same second,
// and the mtimes get rewritten by any copy off the VM. So the ordinal is baked
// into the filename and recorded in a manifest written alongside the frames.
//
//   screenshots/<messageId>/01-loaded.png
//   screenshots/<messageId>/02-after-click-reserve.png
//   screenshots/<messageId>/trace.json
//
// Frames are numbered from 1 in capture order and zero-padded so a plain
// alphabetical listing (ls, Finder, an unzipped attachment) is chronological.

const MAX_LABEL_LENGTH = 40;

// Filenames end up in shell commands, zip files and Gmail attachments, so keep
// them to a conservative charset rather than trusting whatever the page gave us.
function slugify(label) {
  const slug = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LABEL_LENGTH)
    .replace(/-+$/, '');
  return slug || 'frame';
}

/**
 * Ordered screenshot recorder for one claim attempt.
 *
 * Capture failures are swallowed deliberately: a trace is diagnostic, and losing
 * a frame must never be the reason we abandon a reservation we could still get.
 */
export class ScreenshotTrace {
  #dir;
  #frames = [];
  #startedAt = Date.now();
  // Captures are serialised through this chain. Frames arrive from two places -
  // awaited calls in the handler and the framenavigated listener - and taking a
  // screenshot is slow enough that two can overlap. Without a queue they race
  // for the same ordinal and the timeline stops being a timeline.
  #queue = Promise.resolve();
  #reserved = 0;

  constructor(messageId) {
    // Date.now() only as a last-resort fallback, matching the previous behaviour
    // for the manual/ad-hoc case where there's no message to key against.
    this.#dir = path.join(SCREENSHOT_DIR, String(messageId || Date.now()));
    fs.mkdirSync(this.#dir, { recursive: true });
  }

  get dir() {
    return this.#dir;
  }

  /** Captured frames in ordinal order (the queue preserves it; sort is belt-and-braces). */
  get frames() {
    return [...this.#frames].sort((a, b) => a.index - b.index);
  }

  /** Ordinal of the next frame, 1-based. */
  get nextIndex() {
    return this.#reserved + 1;
  }

  /**
   * Capture the current page state as the next frame in the timeline.
   *
   * @param {import('playwright').Page} page
   * @param {string} label - what just happened, e.g. 'loaded', 'after-click-reserve'
   * @returns {Promise<object|null>} the frame record, or null if capture failed
   */
  capture(page, label) {
    // The ordinal and the URL are both claimed synchronously, before any await.
    // A redirect chain can move the page on while a screenshot is still being
    // written, so reading the URL afterwards would label the frame with a
    // location it never showed.
    const index = ++this.#reserved;
    const atMs = Date.now() - this.#startedAt;
    const at = new Date().toISOString();

    let url = null;
    try {
      url = page.url();
    } catch {
      // page closed or crashed - the image is still worth keeping
    }

    const filename = `${String(index).padStart(2, '0')}-${slugify(label)}.png`;
    const filePath = path.join(this.#dir, filename);

    const run = async () => {
      try {
        await page.screenshot({ path: filePath, fullPage: true });
      } catch (err) {
        log.error(`[trace] frame ${index} (${label}) failed to capture:`, err.message);
        return null;
      }

      const frame = { index, label, filename, path: filePath, url, atMs, at };

      this.#frames.push(frame);
      log.info(`[trace] ${filename}${url ? ` (${url})` : ''}`);

      return frame;
    };

    this.#queue = this.#queue.then(run, run);
    return this.#queue;
  }

  /** Wait for every queued capture to finish. Call before writing the manifest. */
  async settle() {
    await this.#queue.catch(() => {});
  }

  /**
   * Write the manifest. Called once the attempt is over, successful or not, so
   * the order survives being copied off the VM and separated from the mtimes.
   */
  writeManifest(extra = {}) {
    const manifestPath = path.join(this.#dir, 'trace.json');
    const manifest = {
      ...extra,
      startedAt: new Date(this.#startedAt).toISOString(),
      frameCount: this.#frames.length,
      frames: this.frames.map(({ path: _abs, ...rest }) => rest),
    };

    try {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch (err) {
      log.error('[trace] failed to write manifest:', err.message);
      return null;
    }

    return manifestPath;
  }
}
