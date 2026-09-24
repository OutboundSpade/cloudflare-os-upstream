# Gadget subscription disconnect handlers are disposed before Cap'n Web invokes them

Reproduced at `bfe217f5` with the repository's locked dependencies (Cap'n Web 0.12.0,
workerd 1.20260831.1).

## What happens

[`SubscriberRegistry.add()`](https://github.com/cloudflare/cloudflare-os/blob/bfe217f5e5ef93748a67bc4f44fa56d8add34de6/packages/bundled-blueprints/libraries/sync/src/subscribers.ts#L85)
retains a callback and registers a disconnect handler:

```ts
const stub = (subscriber as Callbacks & SubscriberStub).dup();
const others = this.members();
this.#subscribers.set(stub, who);
stub.onRpcBroken(() => {
  if (this.#drop(stub)) this.#announceLeave(who);
});
```

When the callback is a Cap'n Web stub forwarded through native RPC, registration
succeeds: Cap'n Web's `RpcStub` exposes `onRpcBroken`. However, the handler argument
crosses native RPC and is borrowed for that call. Cap'n Web
[stores it without duplicating it](https://github.com/cloudflare/capnweb/blob/7702075d4122e6808512ee50acc591310b77da7a/src/rpc.ts#L278).
Under [native parameter lifetime rules](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/#stubs-received-as-parameters-in-an-rpc-call),
it has been disposed by the time disconnect invokes it.

## Evidence

A WebSocketPair/Cap'n Web → native RPC reproduction uses the actual bundled gadget
servers, with test subclasses exposing subscriber counts. After confirming the
receiving session observed disconnect, Docs, Sheets, and Slides each retain one
subscriber instead of zero and report:

```text
Error: RPC stub used after being disposed.
AssertionError: expected 1 to be +0
```

Registration controls pass for all three gadgets. A disconnect handler registered
locally on a Cap'n Web stub also runs successfully.

```sh
git clone --branch repro/subscription-disconnect https://github.com/OutboundSpade/cloudflare-os-upstream.git
cd cloudflare-os-upstream
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/blueprint-subscription-disconnect.test.ts
```

[Test source](https://github.com/OutboundSpade/cloudflare-os-upstream/blob/db8db8ba/packages/workshop-backend/__tests__/blueprint-subscription-disconnect.test.ts).
Expected: three disconnect failures, four passing controls. The outer test execution
context stays alive to inspect the registries; this does not demonstrate retention
after all Worker contexts end or quantify a production billing impact.

## Possible fix

Return a native subscription `RpcTarget` whose disposer removes and disposes the
retained callback. The client owns that subscription and releases it on view
teardown, including when setup finishes after teardown. Preserve cleanup on failed
delivery. This avoids passing the long-lived disconnect handler as a borrowed RPC
parameter. The generation example in `agent.ts` uses the same pattern and would
also need updating.

A [reference implementation and before/after instructions](https://github.com/OutboundSpade/cloudflare-os-upstream/blob/docs/native-subscription-lifetimes/docs/native-subscription-lifetimes.md)
make the same seven checks pass. Happy to adapt the approach to the preferred
ownership model; no PR submitted.
