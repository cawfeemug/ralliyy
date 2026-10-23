// Small wrapper around fetch for the Ralliyy REST API.
// Resolves to { ok, status, data }; rejects only on network failure.
export async function api(method, path, { body, hostToken, participantId } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (hostToken) headers.Authorization = `Bearer ${hostToken}`;
  if (participantId) headers['X-Participant-Id'] = participantId;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}
