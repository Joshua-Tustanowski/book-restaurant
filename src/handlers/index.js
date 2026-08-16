import { tebiHandler } from './tebi.js';
import { testHandler } from './test.js';

// One handler is active per run. Test mode replaces the real one rather than
// running alongside it, so a test session can never act on a live reservation.
export function activeHandler() {
  return process.env.TEST_MODE === '1' ? testHandler : tebiHandler;
}
