// Gmail API returns headers as [{name, value}], body as base64url-encoded parts
export function getHeader(headers, name) {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function decodeBase64Url(data) {
  return Buffer.from(data, 'base64').toString('utf8');
}

export function findTextPlainPart(payload) {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts || []) {
    const found = findTextPlainPart(part);
    if (found) return found;
  }
  return null;
}
