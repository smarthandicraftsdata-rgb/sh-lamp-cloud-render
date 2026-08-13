# RF5.4 Render backend — routing/socket hardening

This backend is the cloud component of the RF5.4 Hardware Acceptance Candidate.

Key changes from RF5.3:
- device WebSocket generation binding: a queued frame can never migrate to a replacement device socket;
- durable device sends are no longer placed behind a per-lamp promise chain waiting for prior send callbacks;
- only the short DB prepare/supersession section is serialized per device; socket dispatch happens outside it;
- exact same command ID REST + `/ws/app` hedges share one dispatch promise;
- one in-flight + one replaceable pending live slider frame per lamp;
- output supersession domain includes `toggle`;
- control TTL is sent to the ESP as `expiresAtEpochSec` so the device can reject a late unseen frame after it entered TCP;
- app authorization cache is revalidated every 10 seconds;
- stale device generations cannot apply state/ACK events;
- backend control retry no longer adds a hidden 5-second retry loop; only `requestState` is eligible for the long retry path;
- command trace logging records app receive, device send generation, and ESP semantic ACK latency.

No database migration is introduced by RF5.4.
