// Creates a fresh bundled Docs workspace on a disposable deployment, subscribes once,
// then closes the WebSocket. Supply API_URL and AUTH_TOKEN through the environment.
// No iframe, presence heartbeat, agent, or integration is involved.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../../packages/workshop-shared/package.json', import.meta.url));
const { newWebSocketRpcSession, RpcTarget } = await import(require.resolve('capnweb'));
assert(process.env.API_URL && process.env.AUTH_TOKEN, 'Set API_URL and AUTH_TOKEN');
const record = (event, fields = {}) => console.log(JSON.stringify({
  event, at: new Date().toISOString(), ...fields,
}));
const socket = new WebSocket(process.env.API_URL);
const api = newWebSocketRpcSession(socket);
api.onRpcBroken(() => {});
try {
  const auth = await api.authenticate(process.env.AUTH_TOKEN);
  const workspace = await auth.newGadgetFromBlueprint('format.document', {});
  const metadata = await workspace.getMetadata();
  const client = await workspace.getGadget(metadata.defaultGadgetId ?? 0);
  const gadget = await client.connectToGadget();
  const callback = new class extends RpcTarget { operation() {} presence() {} }();
  const initial = await gadget.subscribe(callback, { clientId: 'control', name: 'Control', color: '#555555' });
  if (process.env.TEST_FIXTURE_FILE) {
    writeFileSync(process.env.TEST_FIXTURE_FILE, JSON.stringify({ workspaceId: metadata.id }), { mode: 0o600 });
  }
  record('subscription.held', { hasOwner: !!initial.subscription });
  await new Promise(resolve => setTimeout(resolve, 60_000));
  assert.equal(socket.readyState, WebSocket.OPEN, 'Transport closed before planned teardown');
  const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
  socket.close();
  await closed;
  record('transport.closed');
  // Intentionally retain the local references until after transport close: this models a
  // disconnected client, rather than testing an explicit pre-disconnect unsubscribe.
  void initial;
} finally {
  socket.close();
}
