# Gadget disconnect handlers cross native RPC without retained ownership

**Correction to the earlier explanation:** a plain native callback rejects
`onRpcBroken`, but that is not a sufficient model of the browser path. Cap'n Web's
`RpcStub` extends native `RpcTarget` in Workers and exposes `onRpcBroken` as a method.
Forwarding a Cap'n Web stub through native RPC therefore allows registration to
succeed. The reproduced failure happens later: the disconnect handler has already
been disposed when Cap'n Web invokes it.

## Reproduction and scope

Upstream revision: [`bfe217f5`](https://github.com/cloudflare/cloudflare-os/commit/bfe217f5e5ef93748a67bc4f44fa56d8add34de6),
still `main` when checked September 24, 2026. Dependencies are from its lockfile,
including Cap'n Web 0.12.0 and workerd 1.20260831.1.

The reproduction uses a real WebSocketPair, Cap'n Web sessions, and native RPC to
SQLite Durable Objects subclassing the actual Docs, Sheets, and Slides servers.
The subclasses expose counts but do not replace `subscribe()` or the registry.
The outer test execution context remains alive so the registry can be inspected
following WebSocket closure. This is a transport-level reproduction, not a full
browser/Overseer integration or a measurement after the entire Worker context ends.

```text
Cap'n Web client callback
  -> WebSocket session
  -> Cap'n Web callback stub in the bridge
  -> native RPC gadget.subscribe(callback)
  -> native RPC callback.onRpcBroken(handler)
  -> Cap'n Web stores handler without duplicating it
  -> registration RPC returns; borrowed handler is disposed
  -> WebSocket closes; Cap'n Web invokes handler
  -> "RPC stub used after being disposed."; registry still has one subscriber
```

On unmodified upstream application code, all three gadget disconnect checks fail:

```text
AssertionError: expected 1 to be +0
Error: RPC stub used after being disposed.
Tests  3 failed | 4 passed (7)
Errors  3 errors
```

The checks first confirm that the receiving Cap'n Web session observed disconnect,
then wait up to 1.5 seconds for the registry to empty. The four passing controls
show that registration succeeds through native RPC for each gadget, and a handler
registered locally on a Cap'n Web stub runs on disconnect.

With the existing subscription-owner fix, the same seven checks pass: registries
return to zero after WebSocket closure with no unhandled test errors. The new
checks do not depend on a new subscription return shape. Together with the eight
original native lifecycle checks, **15 tests pass**.

## Why the handler is disposed

The upstream [`SubscriberRegistry.add()`](https://github.com/cloudflare/cloudflare-os/blob/bfe217f5e5ef93748a67bc4f44fa56d8add34de6/packages/bundled-blueprints/libraries/sync/src/subscribers.ts#L85)
duplicates the callback, stores it, then calls `stub.onRpcBroken(handler)`.
The gadget receives a native stub, so this registration itself is a native RPC.

In the installed Cap'n Web version, [`RpcStub.onRpcBroken()`](https://github.com/cloudflare/capnweb/blob/7702075d4122e6808512ee50acc591310b77da7a/src/core.ts#L549)
forwards its argument to the hook. [`ImportTableEntry.onBroken()`](https://github.com/cloudflare/capnweb/blob/7702075d4122e6808512ee50acc591310b77da7a/src/rpc.ts#L278)
stores that argument directly. A native RPC parameter must be duplicated to survive
the call, per [Workers RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/#stubs-received-as-parameters-in-an-rpc-call).
The stored disconnect handler has no retained native reference. This source path
explains the observed use-after-disposal when the WebSocket closes.

This distinction matters: native RPC itself has no built-in `onRpcBroken` hook,
but a native target can expose an application method of that name. The earlier
native-only reproduction proved the first statement, not the browser-path failure.

## Run the evidence

Use Node 24 and the pnpm version pinned in `package.json`:

```sh
git clone --branch repro/subscription-disconnect https://github.com/OutboundSpade/cloudflare-os-upstream.git
cd cloudflare-os-upstream
# db8db8ba: upstream application code plus test fixtures and reproductions.
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/blueprint-subscription-disconnect.test.ts
# Expected: exit 1; three disconnect failures, four controls pass.

git switch docs/native-subscription-lifetimes
pnpm build
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/blueprint-subscription-disconnect.test.ts __tests__/blueprint-subscription-lifetime.test.ts
# Expected: exit 0; 15 pass.
```

The original native-only reproduction remains at `2772e738`. Six of its seven
failures also depend on the new return shape; they should not be presented as
independent evidence of leaks. Its separate Docs failed-snapshot check directly
shows that registration before a fallible read leaves a subscriber behind.

## Possible fix

Return a native subscription `RpcTarget` whose disposer calls
`SubscriberRegistry.remove(retainedCallback)`. Have the browser own that returned
stub and release it when the view closes; session teardown also releases exported
owners. Handle setup resolving after view teardown. This avoids passing a long-lived
disconnect callback as a borrowed native RPC parameter.

The reference implementation changes the shared registry and all three clients and
servers together, preserving cleanup on failed broadcast delivery and independence
between subscribers. It also loads the Docs snapshot before registration, inside
its mutation queue, and corrects the generation example that teaches the same
remote disconnect-hook pattern. No polling or forced object resets are introduced.

A different boundary adapter could explicitly retain and release the remote
handler, but that would need its own lifecycle design. This report does not claim
that the subscription-owner implementation is the only valid fix.

## Validation and limits

The implementation at `7b28805a` previously passed lint (existing warnings), script
types, build, and the full test run: 4,339 passing Vitest tests, seven skipped, one
expected failure, plus successful other test commands. Unchanged tasks used the
repository cache. After adding the WebSocket reproduction, both focused suites
were run directly and all 15 tests passed. No runtime implementation was changed
for this follow-up.

The evidence establishes failed disconnect cleanup in the transport reproduction.
It does not quantify production GB-seconds, show indefinite retention after all
execution contexts end, or prove that every active-session duration charge comes
from this defect. Failed broadcast delivery can also remove a retained subscriber.
A full browser reconnect/back-forward-cache exercise remains outside this test.
Existing persisted gadgets require their own source updates when adopting a fix.

The concise proposed issue is in [native-subscription-issue-draft.md](native-subscription-issue-draft.md).
No issue or PR has been filed upstream. The current complete implementation exceeds
upstream's [contribution size guideline](../CONTRIBUTING.md); a bug report with this
reproduction lets maintainers choose the implementation and review scope.
