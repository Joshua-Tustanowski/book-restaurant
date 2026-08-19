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

// Outcomes that mean "stop trying this event". 'booked' is settled. So is
// 'payment_required': the spot is already held under our name and the only
// remaining step is a human entering card details. Re-running the confirm link
// then would either race the checkout the user is part-way through or hold a
// second table, so we stay out of the way and let the alert do its job.
const SETTLED_OUTCOMES = new Set(['booked', 'payment_required']);

// Have we already secured this exact event/date? Lets a caller skip
// re-attempting confirmation for a slot that no longer needs the bot.
export function isEventAlreadyBooked(parsed) {
  const state = load();
  const record = state.events[eventKey(parsed)];
  return SETTLED_OUTCOMES.has(record?.outcome);
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
