# Idle workspace duration: controlled reproduction

This experiment separates ordinary retained-session duration ([#338](https://github.com/cloudflare/cloudflare-os/issues/338)) from the gadget subscription disconnect bug ([#561](https://github.com/cloudflare/cloudflare-os/issues/561)). It does not estimate an individual deployment's bill.

## Setup

- Upstream application: `bfe217f5e5ef93748a67bc4f44fa56d8add34de6`, with its frozen lockfile.
- Control A: unchanged application code.
- Control B: the same application plus only [the explicit subscription ownership change](https://github.com/OutboundSpade/cloudflare-os-upstream/commit/12f3b253). No session-expiry or idle-suspension changes.
- Separate Workers, Durable Object namespaces, KV namespaces, R2 buckets, application accounts, and browser contexts. Both deployments used generic test data. No gatekeeper bindings, model credentials, running agents, or scheduled jobs.
- A test-only router access gate protected both instances. It did not modify the application's RPC path. Signups were disabled after bootstrap.
- One visible Chromium page per deployment, driven through the same five states. Each state lasted four minutes. No application polling was used to collect billing data.
- Platform metrics were read through `durableObjectsPeriodicGroups`, filtered by the individual Overseer namespace, minute, object, and colo. Introspection describes `duration` as GB-s and `cpuTime`/`activeTime` as microseconds. `sampleInterval` was 1 for the reported samples.

The two browser runs were simultaneous, but their namespaces were independent. The metrics feed arrived late and early responses were incomplete; recent missing rows were not treated as evidence of zero duration. Transition minutes must be excluded. Some empty-workspace sockets were closed by the platform (`loadShed`) and the unchanged frontend reconnected; those events are retained in the evidence rather than hidden.

## Results

The settled metrics and exact phase boundaries are supplied in the [evidence JSON](idle-session-billing-evidence.json). Rounded steady-state rates are:

| State | Unchanged upstream | Subscription ownership fix only |
| --- | ---: | ---: |
| Empty workspace, no agent | about 7.68 GB-s/min | about 7.68 GB-s/min |
| Bundled Docs open, no editing | about 15.36 GB-s/min | about 15.36 GB-s/min |
| Click “Close gadget pane”; leave workspace open | about 15.36 GB-s/min | about 15.36 GB-s/min |
| All browser contexts closed | ~15.36 GB-s/min in 15 subsequent full-duration samples | No further duration after teardown |

The empty-workspace run included full 7.68 GB-s samples with zero recorded CPU. Docs used approximately 8–9 ms of recorded CPU per steady minute while accumulating 15.36 GB-s of duration. Duration is wall-clock residency under the billing rules, not CPU execution time.

The post-disconnect contrast matters: the subscription fix did not remove ordinary open-session duration, but it did change teardown. In the patched control, the Docs workspace's native `open` invocation ended at browser closure (`wallTime: 480986 ms`, `outcome: canceled`). The unmodified control accumulated another **230.40 GB-s with zero recorded CPU** in the fifteen samples labelled 04:48–05:02 UTC, after browser closure at 04:47:19 UTC. The patched Docs fixture had no duration rows in that same interval. This is a bounded observation, not proof of an infinite leak; the test Workers were deleted afterward to stop the experiment.

Cloudflare's [pricing documentation](https://developers.cloudflare.com/durable-objects/platform/pricing/) specifies a 128 MB allocation for duration billing. One continuously billable allocation therefore contributes `0.128 × 60 = 7.68 GB-s/min`. The Docs measurements are consistent with two such allocations. These are allocation equivalents, not counts of browser tabs, RPC calls, or independently addressable workspace IDs. The Docs samples share one parent object ID; the application hosts its gadget through [a Durable Object facet](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/).

## Root cause, with a control that changes one thing

The relevant upstream path is:

1. [`AuthenticatedApiImpl.#openGadgetInternal()`](https://github.com/cloudflare/cloudflare-os/blob/bfe217f5e5ef93748a67bc4f44fa56d8add34de6/packages/workshop-backend/src/server.ts#L242) awaits `overseer.open(...)` and returns the capability to the browser.
2. [`OverseerDurableObject.open()`](https://github.com/cloudflare/cloudflare-os/blob/bfe217f5e5ef93748a67bc4f44fa56d8add34de6/packages/workshop-backend/src/overseer.ts#L9930) returns an `OverseerClientInterface`, which extends `RpcTarget`.
3. [`useWorkspaceOpen()`](https://github.com/cloudflare/cloudflare-os/blob/bfe217f5e5ef93748a67bc4f44fa56d8add34de6/packages/workshop-frontend/src/useWorkspaceOpen.ts#L119) retains that capability and its metadata subscription for the mounted workspace. This is intentional ownership, rather than evidence of an undisposed abandoned stub.

Cloudflare documents that calls through a returned `RpcTarget` remain part of the originating [RPC session](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/). An in-flight RPC prevents the object from becoming eligible for hibernation under the [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

The accompanying [minimal client](../scripts/experiments/idle-rpc-session.mjs) removes the UI and gadget entirely:

```js
const workspace = await auth.openGadget(workspaceId);
await workspace.getMetadata();
// Hold the returned capability, without sending further workspace calls.
await measurementWindow();
workspace[Symbol.dispose]();
// Keep PublicApi, authentication, and the WebSocket open for another window.
await measurementWindow();
```

This distinguishes the retained workspace capability from the mere existence of a browser WebSocket. Run it only against a disposable workspace with no other clients. After `pnpm install --frozen-lockfile`, set `API_URL`, `AUTH_TOKEN`, and `WORKSPACE_ID` through environment variables, then run `node scripts/experiments/idle-rpc-session.mjs`. Do not put tokens in screenshots, issue text, or command arguments. The script aborts its conclusions if the platform closes the transport during either measurement window. An initial run without a keepalive was invalidated by platform connection shedding; the reproducible version calls [the Worker-only `PublicApi.ping()` no-op](https://github.com/cloudflare/cloudflare-os/blob/bfe217f5e5ef93748a67bc4f44fa56d8add34de6/packages/workshop-backend/src/server.ts#L677) every ten seconds in **both** windows. It makes no additional Overseer calls during either hold.

The independent [subscription-only client](../scripts/experiments/subscription-disconnect.mjs) creates a fresh bundled Docs workspace, subscribes once, holds for sixty seconds, and closes the WebSocket. It does not load an iframe or send presence heartbeats. Run it against each variant and correlate the new workspace using the optional private `TEST_FIXTURE_FILE`. This control tests disconnected subscription cleanup without relying on browser page teardown.

The live repeat used a fresh document in each deployment. Both clients subscribed successfully and held the connection for sixty seconds. After they closed, the unmodified document continued reporting approximately 15.36 GB-s/min with zero recorded CPU; the ownership-fixed document stopped. The patched backend was unchanged between the browser and subscription-only runs. A later frontend-only experiment has no role in this Node client control.

Specifically, the repeat closed its transports at 04:58:58 UTC. The unmodified fixture accumulated **61.44 GB-s with zero recorded CPU** across the four samples labelled 04:59–05:02; the patched fixture had no further duration rows. There were no presence heartbeats in this repeat.

In this Node repeat, the native `open` invocation ended in **both** variants (about 60.3 seconds). The unmodified fixture nevertheless continued accumulating duration. An `open` completion log alone therefore does not establish that the rest of the capability/subscription graph has been released; the platform duration samples are the billing evidence.

The capability-release control also succeeded: it held an empty workspace from 04:58:50 to 05:00:50 UTC, released the workspace, then kept the same WebSocket connected until 05:02:50. While held, it reported 7.68 GB-s per full sample; after the release there was only a 0.00359 GB-s teardown sample and no subsequent duration for that fixture during the remaining connected window. This is direct evidence that retaining the workspace capability, rather than a WebSocket by itself, sustains that Overseer's duration.

Use [the metrics collector](../scripts/experiments/collect-do-duration.py) from a separate process. It never calls the application and emits object aliases instead of identifiers. Wait for ingestion and record state boundaries; an empty recent query is not a settled zero.

## Why closing the pane does not help

[`closeWorkspacePane()`](https://github.com/cloudflare/cloudflare-os/blob/bfe217f5e5ef93748a67bc4f44fa56d8add34de6/packages/workshop-frontend/src/GadgetEditor.tsx#L968) changes the workspace view. The [`GadgetUI` render condition](https://github.com/cloudflare/cloudflare-os/blob/bfe217f5e5ef93748a67bc4f44fa56d8add34de6/packages/workshop-frontend/src/GadgetEditor.tsx#L1924) still depends on the selected gadget and preview mode, rather than whether the pane is closed. Both browser controls retained their iframe after clicking Close.

The bundled Docs client starts a [`PresenceReporter` heartbeat](https://github.com/cloudflare/cloudflare-os/blob/bfe217f5e5ef93748a67bc4f44fa56d8add34de6/packages/bundled-blueprints/libraries/sync/src/presence.ts#L16) every four seconds. Traffic continued while the pane was closed. That is separate from retaining the workspace capability: even the empty workspace accrues duration without a gadget heartbeat.

## Recommended fix direction

Treat idle-session ownership and gadget subscription cleanup as separate fixes. The subscription ownership patch repairs a demonstrated disposal bug, but did not reduce the ordinary idle plateaus in this comparison.

For post-disconnect retention, the explicit subscription owner is the concrete fix tested here: return an owned disposable subscription, release the callback in its destructor, and let the client release that owner. Both the live comparison and the fifteen local subscription lifecycle checks support that change. This conclusion is scoped to these bundled gadget paths, not all possible reasons an object might stay active.

A bounded idle-session policy is a practical mitigation to discuss with maintainers. It must release the whole relevant capability graph, including child stubs and subscriptions, and must not immediately reconnect on its own intentional close. On resume it must reauthenticate, reopen the existing workspace through the normal authorization path, and rebuild subscriptions.

Do not use background presence traffic as proof of user activity. In particular, a requirement for five seconds of socket silence can never be satisfied by a four-second heartbeat. Conversely, a quiet socket does not establish that an awaited mutation has finished.

Before suspending, guard active agents in every chat, observer authorization, sends, attachment preparation/uploads, and unsaved code or gadget edits. Preserve composer drafts and the identity of provisional workspaces that own staged attachments. Gadget suspension needs a cooperative flush/pause/resubscribe contract: simply unmounting an arbitrary iframe may lose local state, while retaining a live iframe can queue periodic calls during an outage. A chat-only suspension experiment cannot establish safety for arbitrary gadgets.

If maintainers want idle connected workspaces to remain live without periodic disconnection, a hibernatable DO-hosted channel or a different short-lived capability boundary requires an architectural change. Replacing a WebSocket acceptance call alone does not remove the native RPC capabilities or make their in-memory state hibernation-safe.

The repository's [contribution guidelines](https://github.com/cloudflare/cloudflare-os/blob/bfe217f5e5ef93748a67bc4f44fa56d8add34de6/CONTRIBUTING.md) favor very small, trivially verified external fixes. The appropriate next step is the controlled evidence on #338 and agreement on the ownership/lifecycle boundary, before submitting a broad frontend change.

## Experiment excluded from the fix recommendation

A separate chat-only suspension prototype passed twenty focused lifecycle/guard checks and a production frontend build. However, it did not enter the expected suspended state in the deployed browser within the test timeout. It is not offered here as a validated fix. Its browser visibility signal was simulated while timers and backend activity used real elapsed time; no successful production idle-suspension claim is based on that experiment. The minimal capability-release control and the two subscription comparisons are independent of it.
