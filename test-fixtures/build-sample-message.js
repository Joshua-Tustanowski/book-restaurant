import fs from 'fs';
import path from 'path';

// Builds a fake Gmail API `message` object (matching users.messages.get shape)
// from the raw text-fixture, to unit-test the parser without live Gmail API calls.
const raw = fs.readFileSync(path.join(import.meta.dirname, 'sample-tebi-email.txt'), 'utf8');

export function buildSampleMessage() {
  return {
    id: 'test-msg-1',
    threadId: 'test-thread-1',
    payload: {
      headers: [
        { name: 'From', value: '"392 Kingsland Rd." <noreply-reservations@tebi.co>' },
        { name: 'Subject', value: 'A spot is available for Wednesday Jazz: Dinner  on Wednesday, August 26, 2026' },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from(raw, 'utf8').toString('base64') },
    },
  };
}
