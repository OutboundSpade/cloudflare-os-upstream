// Run against a disposable deployment, with no other clients connected to this workspace.
// Supply API_URL (wss://.../api), AUTH_TOKEN, and WORKSPACE_ID through the environment.
// Optional HOLD_MS defaults to four minutes. Never logs credentials or workspace identifiers.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../../packages/workshop-shared/package.json', import.meta.url));
const { newWebSocketRpcSession } = await import(require.resolve('capnweb'));
const { API_URL, AUTH_TOKEN, WORKSPACE_ID } = process.env;
assert(API_URL && AUTH_TOKEN && WORKSPACE_ID, 'Set API_URL, AUTH_TOKEN, and WORKSPACE_ID');
const holdMs = Number(process.env.HOLD_MS ?? 240_000);
assert(Number.isFinite(holdMs) && holdMs >= 120_000, 'Use a window of at least two minutes');
const record = (event, fields = {}) => console.log(JSON.stringify({
  event, at: new Date().toISOString(), ...fields,
}));
const hold = () => new Promise(resolve => setTimeout(resolve, holdMs));
const socket = new WebSocket(API_URL);
const api = newWebSocketRpcSession(socket);
api.onRpcBroken(() => {});
socket.addEventListener('close', () => record('transport.closed'));
let auth, workspace;
let keepaliveError;
// PublicApi.ping() is a Worker-only no-op. Keep the same transport alive in both windows
// without touching the Overseer. Otherwise platform idle connection shedding can end a run.
const keepalive = setInterval(() => {
  void api.ping().catch(error => { keepaliveError = error; });
}, 10_000);
try {
  auth = await api.authenticate(AUTH_TOKEN);
  workspace = await auth.openGadget(WORKSPACE_ID);
  await workspace.getMetadata();
  record('capability.held');
  await hold();
  assert(!keepaliveError, 'Worker-only keepalive failed');
  assert.equal(socket.readyState, WebSocket.OPEN, 'Transport closed during the hold window');
  workspace[Symbol.dispose]();
  workspace = undefined;
  await api.ping();
  record('capability.released', { transportOpen: socket.readyState === WebSocket.OPEN });
  await hold();
  assert(!keepaliveError, 'Worker-only keepalive failed');
  assert.equal(socket.readyState, WebSocket.OPEN, 'Transport closed during the release window');
  await api.ping();
  record('release-window.complete', { transportOpen: true });
} finally {
  clearInterval(keepalive);
  workspace?.[Symbol.dispose]();
  auth?.[Symbol.dispose]();
  api[Symbol.dispose]();
  socket.close();
}
