# RF5.4.1 Render Compile Fix 1

Render TypeScript build exposed one type-contract mismatch in `src/websocketHub.ts`.

`deviceAckSchema.state` intentionally omits the nested `type: "state"` discriminator,
while `queueLatestDeviceState()` accepts the complete `deviceStateSchema`.

Fix:
```ts
this.queueLatestDeviceState(
  deviceId,
  lampId,
  socket.meta!.generation!,
  { type: "state", ...ack.state }
);
```

This restores the schema discriminator only for the internal persistence path.
It does not alter the ESP/iOS protocol, command ordering, ACK semantics, routing,
database schema, or runtime state values.
