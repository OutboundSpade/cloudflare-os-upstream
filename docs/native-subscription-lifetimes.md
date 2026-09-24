# Native gadget subscriptions retain callbacks without a working disconnect hook

The bundled Docs, Sheets, and Slides gadgets register callback cleanup using
`onRpcBroken()`, an API of Cap'n Web that native Workers RPC does not implement.
The callback is duplicated and stored before that call fails. Quiet subscriptions
therefore lack the intended cleanup path and have no client-owned unsubscribe handle.
Docs additionally retains its callback if loading the initial snapshot fails.

This is reproducible using upstream code, ordinary native RPC callbacks, and local
SQLite Durable Objects. No deployment configuration or external integration is needed.

Audited upstream revision: [`bfe217f5`](https://github.com/cloudflare/cloudflare-os/commit/bfe217f5e5ef93748a67bc4f44fa56d8add34de6),
the latest `main` fetched on September 24, 2026.

## Show the failure

The original [`SubscriberRegistry.add()`](https://github.com/cloudflare/cloudflare-os/blob/bfe217f5e5ef93748a67bc4f44fa56d8add34de6/packages/bundled-blueprints/libraries/sync/src/subscribers.ts#L85)
does the following, in this order:

```ts
const stub = (subscriber as Callbacks & SubscriberStub).dup();
const others = this.members();
this.#subscribers.set(stub, who);
stub.onRpcBroken(() => {
  if (this.#drop(stub)) this.#announceLeave(who);
});
```

The native stub treats `onRpcBroken` as a remote application method, rather than a
local transport hook. The callback does not implement that method. Running the
actual gadget servers in workerd produces:

```text
TypeError: The RPC receiver does not implement the method "onRpcBroken".
```

That rejected RPC is not awaited or caught. Nothing installs the intended hook,
and the registry still owns its duplicate. This is the chain of events:

```text
subscribe(callback)
  -> callback.dup()
  -> registry stores duplicate
  -> native RPC calls callback.onRpcBroken(...)
  -> callback has no such method: rejection
  -> registry still contains duplicate; client has no subscription to release
```

The path is native despite the browser using Cap'n Web: the
[`getGadgetFacet()` proxy](https://github.com/cloudflare/cloudflare-os/blob/bfe217f5e5ef93748a67bc4f44fa56d8add34de6/packages/workshop-backend/src/overseer.ts#L5153)
forwards gadget calls to a native facet. A browser transport API cannot be assumed
to exist on the server's callback stub.

The original Node registry tests concealed this mismatch by providing a fake
`onRpcBroken()` method. The new regression uses a real `RpcTarget` with only the
application callbacks and a disposer. Its test Durable Objects subclass the actual
bundled gadget servers; they do not replace `subscribe()` or the registry.

## Reproduce before and after

Use Node 24 and the pnpm version pinned in `package.json`. From a fresh clone:

```sh
git clone --branch fix/native-subscription-lifetimes https://github.com/OutboundSpade/cloudflare-os-upstream.git
cd cloudflare-os-upstream

# Upstream application code plus the new native regression tests, without the fix.
git switch --detach 2772e738
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/blueprint-subscription-lifetime.test.ts
# Expected: exit 1.

# Same tests, now with the fix.
git switch fix/native-subscription-lifetimes
pnpm build
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/blueprint-subscription-lifetime.test.ts
# Expected: exit 0.
```

Observed results on September 24, 2026:

| Check | Before: `2772e738` | After: `7b28805a` |
| --- | --- | --- |
| Native regression suite | 7 failed, 1 passed; 10 unhandled errors | 8 passed; no unhandled test errors |
| Calling the nonexistent native hook | Missing-method rejection | No hook call |
| Releasing the first of two subscriptions | No returned subscription handle; registry count reaches 2 | Count becomes 1; remaining callback still receives updates |
| Releasing the remaining subscription | No returned subscription handle | Count becomes 0; callback disposer runs |
| Docs snapshot failure | Count is 1, expected 0 | Count is 0; callback released |
| Sheets snapshot failure | Already passes | Still passes |

The seven baseline failures are not seven distinct leaks: six cases also require
the new subscription return value, which the old API lacks. In particular, the
old registry already removes callbacks on failed delivery; that behavior is preserved.
The transport rejection and the Docs `expected 1 to be +0` assertion are direct
evidence of the two defects, independent of that API extension.

Both runs intentionally inject `callback disconnected` and `snapshot unavailable`
errors. workerd logs those exceptions even when the assertions pass. They are
different from the unhandled `onRpcBroken` rejections in the baseline.

## The fix and why each part is needed

The lifetime invariant is: **each retained callback has one returned subscription
owner; releasing that owner removes and disposes the callback exactly once.**

The essential server change is:

```ts
const stub = this.subscribers.add(callback, info);
return {
  ...snapshot,
  subscription: createSubscription(RpcTarget, () => {
    this.subscribers.remove(stub);
  }),
};
```

`createSubscription()` creates a native `RpcTarget` with an idempotent
`[Symbol.dispose]()` cleanup. The client keeps its returned stub and disposes it
when the view ends. Native RPC invokes the target's disposer after the last remote
handle is released; that release is asynchronous. See
[Workers RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/#disposers-and-rpctarget-classes).

- Remove the invalid native hook and the fake hook from the registry's test doubles.
- Return subscription owners from all three bundled gadgets, and update their clients
  and protocol types together. Deleting only the bad hook would leave no explicit owner.
- Use one small client owner helper to release a subscription even if its asynchronous
  setup completes after `pagehide`. Slides installs teardown handling before its first
  asynchronous read. A teardown handler added after setup would miss that race.
- Load the Docs snapshot before retaining the callback, inside its existing mutation
  queue. This prevents failed setup from retaining a subscriber and keeps snapshot
  creation and registration ordered with edits. Sheets already had this ordering.
- Keep existing cleanup on failed broadcasts and independent ownership for multiple
  subscribers. No polling, forced object resets, session timeouts, or transport rewrite
  is introduced.
- Correct the generation example in `agent.ts`, which teaches the same invalid native
  hook and unconditional resubscription from a disposer. The replacement demonstrates
  explicit ownership and describes bounded reconnection that stops on teardown.

The server and client helpers are 13 and 24 lines respectively and are shared by the
three gadgets. The separate prompt commit can be reviewed independently from the
bundled implementation. The reproducible native tests account for 118 added lines.

## Scope, validation, and contribution status

This establishes a callback ownership bug. Retaining RPC capabilities can prolong
resource lifetimes, but these tests do not measure production GB-seconds or prove
that all active-session duration comes from this defect. Durable Objects can still
incur duration while active or idle and non-hibernateable; see
[Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).
The distinction between the transports is documented in
[Cap'n Web's disconnect API](https://github.com/cloudflare/capnweb#listening-for-disconnect)
and the Workers RPC lifecycle documentation above.

At `7b28805a`, `pnpm lint:check` (existing warnings only), `pnpm types:scripts`,
`pnpm build`, and `pnpm test` all exited successfully. The full test run reported
4,339 passing Vitest tests, seven skipped, and one expected failure; other test
commands also completed successfully. The repository task runner reused cached
results for unchanged packages. The focused eight-test native run above was also
run directly.

The native suite verifies subscription release, isolation between subscribers,
failed delivery, and failed setup. Unit tests also cover repeated disposal,
replacement, and setup resolving after client teardown. A full browser reconnect
and back/forward-cache exercise is not part of this reproduction; neither is a
production billing benchmark.

This updates bundled source and future gadget generation guidance. Existing
gadgets have their own persisted source: their callback subscription and teardown
code must also be reviewed when adopting the pattern. This change does not rewrite
those gadgets automatically.

Implementation: `fix/native-subscription-lifetimes`. This report lives on
`docs/native-subscription-lifetimes` so it need not be included in a code-only review.
The commits separate the reproducer, bundled fix, and generation guidance.

[CONTRIBUTING.md](../CONTRIBUTING.md) currently discourages external changes larger
than roughly a dozen lines, and the [PR template](../.github/pull_request_template.md)
asks for an issue first. This complete fix exceeds that size guideline, even though
it addresses a single ownership contract. It is prepared for review in the fork;
no upstream issue or pull request has been filed. Maintainer agreement on scope is
needed before treating it as an acceptable upstream submission.
