// Shared shapes passed between poll.js and the handlers. Plain objects only -
// they get destructured at call sites and dumped straight into logs, so nothing
// here should carry behaviour or fail a JSON round-trip.

/**
 * An offered spot, read out of a single email.
 *
 * @typedef {object} Invitation
 * @property {string} messageId
 * @property {string} threadId
 * @property {string} subject
 * @property {string} restaurantName
 * @property {string|null} eventName
 * @property {string|null} date
 * @property {number|null} partySize
 * @property {string} confirmLink - the URL the handler will visit to claim the spot
 */

/**
 * One screenshot in a claim attempt's timeline.
 *
 * @typedef {object} TraceFrame
 * @property {number} index - 1-based capture order; also the filename prefix
 * @property {string} label - what had just happened, e.g. 'loaded', 'navigated'
 * @property {string} filename
 * @property {string} path
 * @property {string|null} url - page URL at capture time
 * @property {number} atMs - ms since the attempt started
 * @property {string} at - ISO timestamp
 */

/**
 * A control the page was offering when we last looked.
 *
 * @typedef {object} PageAction
 * @property {string} text
 * @property {string} tag
 * @property {string|null} href
 * @property {boolean} disabled
 * @property {boolean} visible
 */

/**
 * What happened when the handler tried to claim the spot.
 *
 * @typedef {object} Attempt
 * @property {'booked'|'payment_required'|'still_waitlisted'|'error'} outcome
 *   - `booked` - table secured, nothing left to do
 *   - `payment_required` - spot HELD, but needs card details a human must enter
 *   - `still_waitlisted` - spot gone before we arrived
 *   - `error` - expired/not-found/unexpected page
 * @property {string|null} screenshotPath - the frame that justifies the outcome; poll.js attaches it to the reply
 * @property {string} finalUrl
 * @property {string} bodyText
 * @property {string} [traceDir] - directory holding every frame plus trace.json
 * @property {string|null} [manifestPath]
 * @property {TraceFrame[]} [frames] - the full timeline, in capture order
 * @property {boolean} [mentionsPayment] - page asked for card details
 * @property {string|null} [holdExpiresIn] - how long the held spot lasts, e.g. '59 minutes 48 seconds'
 * @property {string|null} [fee] - no-show fee quoted on the payment step, e.g. '£20.00'
 * @property {PageAction[]} [actions] - controls present on the final page
 */

/**
 * Outcome copy, rendered once and reused across every notification channel
 * (Gmail reply, Pushover) so channels stay out of the handler interface.
 *
 * @typedef {object} Description
 * @property {string} headline - short, used as the Pushover title
 * @property {string} detail - full body of the Gmail reply
 */

/**
 * A source of bookable emails: how to find them, how to read them, how to act.
 *
 * @typedef {object} Handler
 * @property {string} name
 * @property {string} inboxQuery - Gmail search that surfaces candidate messages
 * @property {(args: {message: object}) => boolean} isHandled
 * @property {(args: {message: object}) => Invitation} readInvitation
 * @property {(args: {invitation: Invitation}) => Promise<Attempt>} claimSpot
 * @property {(args: {invitation: Invitation, attempt: Attempt}) => Description} describe
 */

export {};
