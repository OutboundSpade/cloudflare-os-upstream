import { env, RpcStub, RpcTarget } from "cloudflare:workers";
import { beforeAll, expect, it, vi } from "vitest";
import type { TestDocsSubscriptions, TestSheetsSubscriptions, TestSlidesSubscriptions } from "./test-worker.ts";

declare module "cloudflare:workers" {
  interface Env {
    TEST_DOCS_SUBSCRIPTIONS: DurableObjectNamespace<TestDocsSubscriptions>;
    TEST_SHEETS_SUBSCRIPTIONS: DurableObjectNamespace<TestSheetsSubscriptions>;
    TEST_SLIDES_SUBSCRIPTIONS: DurableObjectNamespace<TestSlidesSubscriptions>;
  }
}

// A real native callback: deliberately no onRpcBroken method. The Node fixtures previously
// supplied that Cap'n Web-only API and concealed the invalid call in the server registry.
class Callback extends RpcTarget {
  disposed = false;
  fail = false;
  deliveries = 0;
  presence() { this.deliver(); }
  operation() { this.deliver(); }
  deckChanged() { this.deliver(); }
  deliver() {
    if (this.fail) throw new Error("callback disconnected");
    this.deliveries++;
  }
  [Symbol.dispose]() { this.disposed = true; }
}

const names = ["TEST_DOCS_SUBSCRIPTIONS", "TEST_SHEETS_SUBSCRIPTIONS", "TEST_SLIDES_SUBSCRIPTIONS"] as const;
// The first DO access loads the backend test Worker's full module graph through Vite.
// Warm it separately so cold compilation does not consume a lifecycle assertion's timeout.
beforeAll(async () => {
  await env.TEST_DOCS_SUBSCRIPTIONS.getByName("subscription-test-warmup").subscriberCount();
}, 30_000);

it.each(names)("%s releases each callback with its returned subscription", async name => {
  const gadget = env[name].getByName(crypto.randomUUID());
  const first = new Callback();
  const a = new RpcStub(first);
  const one = await gadget.subscribe(a);
  const second = new Callback();
  const b = new RpcStub(second);
  const two = await gadget.subscribe(b);
  a[Symbol.dispose](); b[Symbol.dispose]();
  expect(await gadget.subscriberCount()).toBe(2);
  one.subscription[Symbol.dispose]();
  await vi.waitFor(() => expect(first.disposed).toBe(true));
  expect(second.disposed).toBe(false);
  expect(await gadget.subscriberCount()).toBe(1);
  const delivered = second.deliveries;
  await gadget.emit();
  await vi.waitFor(() => expect(second.deliveries).toBeGreaterThan(delivered));
  two.subscription[Symbol.dispose]();
  await vi.waitFor(() => expect(second.disposed).toBe(true));
  expect(await gadget.subscriberCount()).toBe(0);
});

it.each(names)("%s releases a failed delivery without waiting for client disposal", async name => {
  const gadget = env[name].getByName(crypto.randomUUID());
  const callback = new Callback();
  const stub = new RpcStub(callback);
  const result = await gadget.subscribe(stub);
  stub[Symbol.dispose]();
  callback.fail = true;
  await gadget.emit();
  await vi.waitFor(() => expect(callback.disposed).toBe(true));
  expect(await gadget.subscriberCount()).toBe(0);
  result.subscription[Symbol.dispose]();
});

it.each(["TEST_DOCS_SUBSCRIPTIONS", "TEST_SHEETS_SUBSCRIPTIONS"] as const)("%s does not retain a callback when snapshot setup fails", async name => {
  const gadget = env[name].getByName(crypto.randomUUID());
  await gadget.failSnapshot();
  const callback = new Callback();
  const stub = new RpcStub(callback);
  let message = "";
  try { await gadget.subscribe(stub); } catch (error) { message = (error as Error).message; }
  stub[Symbol.dispose]();
  expect(message).toContain("snapshot unavailable");
  expect(await gadget.subscriberCount()).toBe(0);
  await vi.waitFor(() => expect(callback.disposed).toBe(true));
});
