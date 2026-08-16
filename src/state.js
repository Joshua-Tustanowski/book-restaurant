import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE_PATH = path.join(ROOT, 'state.json');

function eventKey(parsed) {
  return `${parsed.restaurantName}::${parsed.eventName || ''}::${parsed.date}`;
}

function load() {
  if (!fs.existsSync(STATE_PATH)) {
    return { processedMessageIds: [], events: {} };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function save(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function isMessageProcessed(messageId) {
  return load().processedMessageIds.includes(messageId);
}

// Have we already booked this exact event/date before? Lets a caller skip
// re-attempting confirmation for a slot we know is already secured.
export function isEventAlreadyBooked(parsed) {
  const state = load();
  const record = state.events[eventKey(parsed)];
  return record?.outcome === 'booked';
}

export function recordOutcome(messageId, parsed, outcome) {
  const state = load();

  if (!state.processedMessageIds.includes(messageId)) {
    state.processedMessageIds.push(messageId);
  }

  state.events[eventKey(parsed)] = {
    restaurantName: parsed.restaurantName,
    eventName: parsed.eventName,
    date: parsed.date,
    outcome,
    messageId,
    updatedAt: new Date().toISOString(),
  };

  save(state);
}
