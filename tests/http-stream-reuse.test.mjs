import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

const baseUrl = process.env.TEST_BASE_URL;
const userId = process.env.TEST_USER_A_ID;
const authEmail = process.env.TEST_AUTH_EMAIL ?? 'qa@example.invalid';
const suite = baseUrl && userId ? test : test.skip;
const base = baseUrl ? new URL(baseUrl) : new URL('http://127.0.0.1');
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const preferred = new Date(`${today}T12:00:00Z`);
preferred.setUTCDate(preferred.getUTCDate() + 1);
const preferredDate = preferred.toISOString().slice(0, 10);

function validBody(name) {
  return JSON.stringify({
    submissionKey: crypto.randomUUID(), name, contact: 'qa@example.invalid',
    service: 'repair', area: 'Billings', source: 'direct', preferredDate, note: '',
  });
}

function send(agent, body, {
  authenticated = false, wrongOrigin = false, chunked = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'content-type': 'application/json',
      origin: wrongOrigin ? 'https://other.example' : base.origin,
    };
    if (!chunked) headers['content-length'] = Buffer.byteLength(body);
    if (authenticated) {
      headers['oai-authenticated-user-id'] = userId;
      headers['oai-authenticated-user-email'] = authEmail;
    }
    const request = http.request({
      hostname: base.hostname, port: base.port || 80, path: '/api/inquiries',
      method: 'POST', agent, headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString(),
        socketPort: request.socketPort,
        responseConnection: response.headers.connection,
      }));
    });
    request.on('socket', (socket) => {
      request.socketPort = socket.localPort;
      socket.on('connect', () => { request.socketPort = socket.localPort; });
    });
    request.on('error', reject);
    if (chunked) request.write(body);
    request.end(chunked ? undefined : body);
  });
}

suite('same-connection recovery after rejected inquiry writes (two repetitions per case)', async () => {
  const scenarios = [
    { name: 'anonymous known-length write', first: { authenticated: false } },
    { name: 'wrong-origin known-length write', first: { authenticated: true, wrongOrigin: true } },
    { name: 'anonymous chunked write', first: { authenticated: false, chunked: true } },
    { name: 'wrong-origin chunked write', first: { authenticated: true, wrongOrigin: true, chunked: true } },
    { name: 'oversized anonymous write', first: { authenticated: false }, oversized: true },
  ];

  for (const scenario of scenarios) {
    for (let repetition = 1; repetition <= 2; repetition += 1) {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const marker = `QA ${scenario.name} ${crypto.randomUUID()}`;
        const firstPayload = scenario.oversized
          ? JSON.stringify({ note: 'x'.repeat(9000) })
          : validBody(marker);
        const first = await send(agent, firstPayload, scenario.first);
        assert.equal(first.status, scenario.first.wrongOrigin ? 403 : 401,
          `${scenario.name} repetition ${repetition} must preserve auth/origin status; body=${first.body}`);

        const successfulPayload = validBody(`QA ok ${crypto.randomUUID()}`);
        const second = await send(agent, successfulPayload, { authenticated: true });
        assert.equal(second.status, 201,
          `${scenario.name} repetition ${repetition}: follow-up returned ${second.status}: ${second.body}`);
        assert.equal(second.socketPort, first.socketPort,
          `${scenario.name} repetition ${repetition}: next request did not reuse the keep-alive socket`);
      } finally {
        agent.destroy();
      }
    }
  }
});

test('same-connection suite configuration', { skip: !(baseUrl && userId) }, () => {
  assert.ok(baseUrl && userId);
});
