Reproduced on clean `bfe217f5` with two isolated deployments: unchanged upstream, and the same code with only the subscription ownership fix for #561. No gatekeepers, active agents, or scheduled jobs were configured.

Overseer duration in the paired browser controls:

| State | Upstream | Subscription fix only |
| --- | ---: | ---: |
| Empty workspace, idle | ~7.68 GB-s/min | ~7.68 GB-s/min |
| Bundled Docs open, idle | ~15.36 GB-s/min | ~15.36 GB-s/min |
| Close gadget pane, keep workspace open | ~15.36 GB-s/min | ~15.36 GB-s/min |

After closing all browser contexts, the unmodified Docs workspace accumulated another **230.40 GB-s across fifteen full-duration samples, with zero recorded CPU**. The patched workspace's native `open` invocation ended at browser closure and its duration stopped. A second control—subscribe once from Node, then disconnect, with no iframe or heartbeat—reproduced the difference on fresh documents. These are bounded observations, not a claim of an infinite leak.

These results separate ordinary retained-session duration from failed cleanup after disconnect. Fixing #561 helped teardown, but did not remove the idle cost of a workspace that remains open.

An empty-workspace control additionally dropped from 7.68 GB-s/min to no further duration after releasing only the workspace capability, while keeping the same WebSocket connected for another two minutes.

There is also a frontend detail relevant to an idle mitigation: “Close gadget pane” leaves its iframe mounted, and Docs' presence heartbeat continues every four seconds. Waiting for five seconds of network silence would never suspend that session. Unmounting the iframe indiscriminately can lose local state; retaining it while disconnected can queue periodic calls. Gadget flush/pause/resubscribe behavior therefore needs to be part of the lifecycle design, alongside guards for agents, authorization, sends, uploads, and unsaved edits.

[Reproduction, source links, and measurement protocol](https://github.com/OutboundSpade/cloudflare-os-upstream/blob/docs/idle-session-billing/docs/idle-session-billing.md). Given the contribution guidelines, I suggest agreeing on that lifecycle boundary before proposing a broad frontend patch.
