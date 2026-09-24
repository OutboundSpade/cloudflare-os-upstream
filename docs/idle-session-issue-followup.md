I reproduced the idle billing behavior on upstream `bfe217f5` in an isolated deployment with no gatekeepers, active agents, or scheduled jobs.

The clearest control was an empty workspace: holding its returned capability accrued approximately **7.68 GB-s/min**. Disposing only that capability stopped the continuous duration, while the same WebSocket remained connected for another two minutes. There was a small teardown sample (0.0036 GB-s), then no further duration recorded during that window. This supports the issue's explanation that retaining the workspace capability keeps the RPC session billable.

Browser measurements also showed:

| State | Overseer duration |
| --- | ---: |
| Empty workspace, idle | ~7.68 GB-s/min |
| Bundled Docs open, idle | ~15.36 GB-s/min |
| Close gadget pane, keep workspace open | ~15.36 GB-s/min |

One detail matters for the proposed idle suspension: "Close gadget pane" leaves the iframe mounted, and Docs continues its presence heartbeat every four seconds. A policy waiting for five seconds of network silence would therefore never suspend that session. Suspension needs to account for gadget activity and preserve unsaved state, as well as ongoing agent work.

A separate cleanup problem is tracked in #561. After browser closure, unmodified Docs accumulated another 230.40 GB-s over fifteen samples with zero recorded CPU. A paired deployment with the subscription ownership fix stopped accumulating duration after teardown, but retained the same idle rates while connected. Fixing that cleanup problem alone does not resolve this issue.

[Reproduction scripts, measurements, and source references](https://github.com/OutboundSpade/cloudflare-os-upstream/blob/docs/idle-session-billing/docs/idle-session-billing.md). Would maintainers prefer guarded idle suspension as an initial mitigation, or a change to the long-lived capability design? These measurements support releasing idle capabilities; they do not establish a validated suspension implementation.
