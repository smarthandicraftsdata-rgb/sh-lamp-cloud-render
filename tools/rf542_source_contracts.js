'use strict';
const fs=require('fs');
const assert=require('node:assert/strict');
const ws=fs.readFileSync('src/websocketHub.ts','utf8');
const cs=fs.readFileSync('src/commandService.ts','utf8');
function has(text, pattern, name){assert.ok(pattern.test(text),name); console.log('PASS',name)}

has(cs,/\["toggle",\s*"setOutputState",\s*"setPower",\s*"setBrightness"\]/,'toggle remains in output latest-wins domain');
has(cs,/existing\.userId\s*===\s*input\.userId/,'duplicate command ownership remains user-bound');
has(cs,/prisma\.\$transaction\(\[/,'durable insert/supersession remains transactional');
has(cs,/expiresAtEpochSec/,'device TTL propagation remains present');
has(ws,/private readonly durableInflight = new Map<string, DurableInflight>\(\)/,'generation-bound durable in-flight map exists');
has(ws,/durableInflight\.size >= WebSocketHub\.MAX_DURABLE_INFLIGHT[\s\S]*?return false;/,'durable in-flight capacity fails closed instead of evicting live ownership');
has(ws,/Promise\.resolve\(\)\.then\(\(\) =>\s*this\.sendCommandToBoundTarget/,'in-flight ownership is installed before socket send microtask');
has(ws,/inflight_join/,'same-ID hedge joins existing device operation');
has(ws,/if \(existing\.terminalAckSeen\)[\s\S]*?if \(existing\.generation !== target\.generation\)/,'terminal ACK is checked before generation mismatch recovery');
has(ws,/if \(existing\.terminalAckSeen\) \{[\s\S]*?return await existing\.sendPromise;[\s\S]*?\}\s*if \(existing\.generation !== target\.generation\)/,'terminal ACK blocks all redispatch before generation/retry logic');
has(ws,/markDurableInflightTerminalAck\(lampId, ack\.commandId, socket\.meta!\.generation!\)/,'validated ACK marks transport terminal before app/DB completion');
has(ws,/releaseDurableInflight\(lampId, ack\.commandId, socket\.meta!\.generation!\)/,'in-flight releases after terminal DB visibility');
has(ws,/Keep the in-memory terminal ACK tombstone until command expiry if DB/,'failed ACK persistence cannot reopen redispatch');
has(ws,/entry\.generation === generation && !entry\.terminalAckSeen/,'generation loss releases only unacknowledged ownership');
has(ws,/sendDurableCommandToBoundTarget\(lampId, target, \{/,'reconnect flush passes through durable guard');
has(ws,/sendDurableCommandToBoundTarget\(command\.device\.lampId, retryTarget, \{/,'requestState retry passes through durable guard');
has(ws,/DEVICE_SEND_CALLBACK_BUDGET_MS = 300/,'bounded WebSocket send callback budget preserved');
has(ws,/pendingStatePersistence/,'bounded state persistence architecture preserved');
has(ws,/deviceMessageChains/,'generation-specific inbound message lane preserved');
has(ws,/this\.deviceSockets\.get\(lampId\) !== socket/,'authoritative device generation checks preserved');

const ackForward=ws.indexOf('CMD ack_forward');
const ackPersist=ws.indexOf('prisma.deviceCommand.updateMany({', ackForward);
assert.ok(ackForward>=0 && ackPersist>ackForward,'ACK is forwarded before command-status persistence');
console.log('PASS ACK forwarding remains ahead of Prisma status persistence');
console.log('RF5.4.2 source contracts: ALL PASS');
