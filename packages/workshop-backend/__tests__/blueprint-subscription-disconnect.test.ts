import { env } from "cloudflare:workers";
import { RpcTarget, RpcStub, newWebSocketRpcSession } from "capnweb";
import { beforeAll, expect, it, vi } from "vitest";
class Callback extends RpcTarget {
  presence() {}
  operation() {}
  deckChanged() {}
}
beforeAll(async () => {
  await env.TEST_DOCS_SUBSCRIPTIONS.getByName("transport-warmup").subscriberCount();
}, 30_000);
it.each(["TEST_DOCS_SUBSCRIPTIONS", "TEST_SHEETS_SUBSCRIPTIONS", "TEST_SLIDES_SUBSCRIPTIONS"] as const)("%s receives a Cap'n Web callback through native RPC", async name => {
  const gadget = env[name].getByName(crypto.randomUUID());
  const callback = new RpcStub(new Callback());
  await gadget.subscribe(callback);
  expect(await gadget.subscriberCount()).toBe(1);
  callback[Symbol.dispose]();
});

it.each(["TEST_DOCS_SUBSCRIPTIONS", "TEST_SHEETS_SUBSCRIPTIONS", "TEST_SLIDES_SUBSCRIPTIONS"] as const)("%s cleans up after a Cap'n Web WebSocket closes", async name => {
  const gadget = env[name].getByName(crypto.randomUUID());
  class Bridge extends RpcTarget {
    async subscribe(callback: Callback) { return await gadget.subscribe(callback); }
  }
  const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
  clientSocket.accept(); serverSocket.accept();
  const server = newWebSocketRpcSession(serverSocket, new Bridge());
  const client = newWebSocketRpcSession<Bridge>(clientSocket);
  let disconnected = false;
  server.onRpcBroken(() => { disconnected = true; });
  try {
    await client.subscribe(new Callback());
    expect(await gadget.subscriberCount()).toBe(1);
    // An awaited native call after registration lets the hook RPC complete first.
    await gadget.subscriberCount();
    clientSocket.close(1000, "test disconnect");
    await vi.waitFor(() => expect(disconnected).toBe(true));
    await vi.waitFor(async () => expect(await gadget.subscriberCount()).toBe(0), { timeout: 1500 });
  } finally {
    client[Symbol.dispose](); server[Symbol.dispose]();
    try { clientSocket.close(); } catch {}
    try { serverSocket.close(); } catch {}
  }
});

it("a local Cap'n Web disconnect handler remains callable", async () => {
  let callback: RpcStub<Callback> | undefined;
  let notified = false;
  class Bridge extends RpcTarget {
    subscribe(incoming: RpcStub<Callback>) {
      callback = incoming.dup();
      callback.onRpcBroken(() => { notified = true; });
    }
  }
  const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
  clientSocket.accept(); serverSocket.accept();
  const server = newWebSocketRpcSession(serverSocket, new Bridge());
  const client = newWebSocketRpcSession<Bridge>(clientSocket);
  try {
    await client.subscribe(new Callback());
    clientSocket.close(1000, "test disconnect");
    await vi.waitFor(() => expect(notified).toBe(true));
  } finally {
    callback?.[Symbol.dispose]();
    client[Symbol.dispose](); server[Symbol.dispose]();
    try { clientSocket.close(); } catch {}
    try { serverSocket.close(); } catch {}
  }
});
