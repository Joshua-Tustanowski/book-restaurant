const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';

// Emergency priority repeats the notification (retry) until acknowledged or it hits
// expire seconds - the closest thing Pushover has to a real alarm rather than a
// one-shot push.
const EMERGENCY_RETRY_SECONDS = 60;
const EMERGENCY_EXPIRE_SECONDS = 3600;

export async function sendPushoverAlert({ title, message, url, urlTitle }) {
  const userKey = process.env.PUSHOVER_USER_KEY;
  const appToken = process.env.PUSHOVER_APP_TOKEN;

  if (!userKey || !appToken) {
    console.error('Pushover not configured (missing PUSHOVER_USER_KEY / PUSHOVER_APP_TOKEN), skipping alert');
    return;
  }

  const params = {
    token: appToken,
    user: userKey,
    title,
    message,
    priority: '2',
    retry: String(EMERGENCY_RETRY_SECONDS),
    expire: String(EMERGENCY_EXPIRE_SECONDS),
  };
  if (url) params.url = url;
  if (urlTitle) params.url_title = urlTitle;

  const res = await fetch(PUSHOVER_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('Pushover alert failed:', res.status, body);
  }
}
