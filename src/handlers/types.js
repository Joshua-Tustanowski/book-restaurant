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
 * What happened when the handler tried to claim the spot.
 *
 * @typedef {object} Attempt
 * @property {'booked'|'still_waitlisted'|'error'} outcome
 * @property {string} screenshotPath - always written; poll.js attaches it to the reply
 * @property {string} finalUrl
 * @property {string} bodyText
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
