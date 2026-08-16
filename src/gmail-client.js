import { google } from 'googleapis';
import { getAuthedClient } from './gmail-auth.js';

let gmailSingleton = null;

export async function getGmail() {
  if (gmailSingleton) return gmailSingleton;
  const auth = await getAuthedClient();
  gmailSingleton = google.gmail({ version: 'v1', auth });
  return gmailSingleton;
}

export async function listUnreadFrom(query) {
  const gmail = await getGmail();
  const res = await gmail.users.messages.list({ userId: 'me', q: query });
  return res.data.messages || [];
}

export async function getFullMessage(id) {
  const gmail = await getGmail();
  const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  return res.data;
}

async function findOrCreateLabel(name) {
  const gmail = await getGmail();
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  const existing = data.labels.find((l) => l.name === name);
  if (existing) return existing.id;

  const { data: created } = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
  return created.id;
}

const labelIdCache = new Map();

export async function applyLabel(messageId, labelName) {
  if (!labelIdCache.has(labelName)) {
    labelIdCache.set(labelName, await findOrCreateLabel(labelName));
  }
  const labelId = labelIdCache.get(labelName);
  const gmail = await getGmail();
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: [labelId], removeLabelIds: ['UNREAD'] },
  });
}

export async function replyInThread({ threadId, messageId, to, subject, bodyText, attachment }) {
  const gmail = await getGmail();
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  let raw;
  if (attachment) {
    const boundary = `boundary_${messageId}`;
    const rawLines = [
      `To: ${to}`,
      `Subject: ${replySubject}`,
      `In-Reply-To: <${messageId}>`,
      `References: <${messageId}>`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      bodyText,
      '',
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      attachment.data.toString('base64'),
      '',
      `--${boundary}--`,
    ];
    raw = Buffer.from(rawLines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } else {
    const rawLines = [
      `To: ${to}`,
      `Subject: ${replySubject}`,
      `In-Reply-To: <${messageId}>`,
      `References: <${messageId}>`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      bodyText,
    ];
    raw = Buffer.from(rawLines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId },
  });
}
