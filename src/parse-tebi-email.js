const SENDER_MATCH = 'noreply-reservations@tebi.co';
const SUBJECT_MATCH = /spot is available/i;
const CONFIRM_LINK_RE = /https:\/\/live\.tebi\.co\/ecom\/reservations\/\S+/;

// Gmail API returns headers as [{name, value}], body as base64url-encoded parts
function getHeader(headers, name) {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function decodeBase64Url(data) {
  return Buffer.from(data, 'base64').toString('utf8');
}

function findTextPlainPart(payload) {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts || []) {
    const found = findTextPlainPart(part);
    if (found) return found;
  }
  return null;
}

export function isTebiWaitlistEmail(message) {
  const headers = message.payload.headers;
  const from = getHeader(headers, 'From');
  const subject = getHeader(headers, 'Subject');
  return from.includes(SENDER_MATCH) && SUBJECT_MATCH.test(subject);
}

export function parseTebiWaitlistEmail(message) {
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
    restaurantName,
    eventName: eventMatch ? eventMatch[1].trim() : null,
    date: eventMatch ? eventMatch[2].trim() : null,
    partySize,
    confirmLink,
    subject,
  };
}
