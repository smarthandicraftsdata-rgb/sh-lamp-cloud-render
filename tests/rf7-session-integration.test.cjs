const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
process.env.NODE_ENV='test';
process.env.DATABASE_URL='postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET='test-only-signing-secret-with-32-characters';
process.env.ADMIN_SETUP_KEY='test-only-admin-key-with-24-characters';
process.env.SHADOW_AUTH_ENABLED='false';
const {buildShAuthV1Message,computeShAuthV1Proof,verifyShAuthV1Proof,SH_AUTH_CHALLENGE_TTL_MS}=require('../dist/shadowAuth');
const {encryptDeviceSecret,decryptDeviceSecret}=require('../dist/credentialEnvelope');
const {ShadowChallengeStore}=require('../dist/shadowChallengeStore');
const {ShadowAuthService}=require('../dist/shadowAuthService');
const {WebSocketHub}=require('../dist/websocketHub');
const {prisma}=require('../dist/db');
const {createAccessToken}=require('../dist/security');
const {WebSocket}=require('ws');
const deviceId='719a68b7-1366-4c5c-9702-cba7c1c6085a';
const legacyId='00000000-0000-4000-8000-000000000001';
const hello={type:'authV2Hello',protocol:'SH-AUTH-V1',deviceId,keyVersion:1};
function appSocket(){return {readyState:WebSocket.OPEN,meta:{kind:'app',authenticated:false,authTimer:setTimeout(()=>{},10000)},close(code){this.code=code;clearTimeout(this.meta.authTimer);}};}
test('compiled RF7 code retains the canonical 75-byte proof vector',()=>{
 const message=buildShAuthV1Message(deviceId,Buffer.from(Array.from({length:16},(_,i)=>i)),Buffer.from(Array.from({length:32},(_,i)=>i+0x20)));
 const proof=computeShAuthV1Proof(Buffer.from(Array.from({length:32},(_,i)=>i)),message);
 assert.equal(message.length,75);assert.equal(proof.toString('hex'),'3b50437746a3b4f808a07fd08a081c584d5cbcfdcb815a3904e78e10c586554c');
 assert.equal(verifyShAuthV1Proof(proof,proof.toString('hex')),true);assert.equal(verifyShAuthV1Proof(proof,'00'.repeat(32)),false);
});
test('compiled credential envelope rejects ciphertext and device-context tampering',()=>{
 const master=crypto.randomBytes(32),secret=crypto.randomBytes(32);
 const envelope=encryptDeviceSecret(master,legacyId,deviceId,'SH-AUTH-V1',1,1,secret);
 assert.deepEqual(decryptDeviceSecret(master,legacyId,deviceId,'SH-AUTH-V1',1,1,envelope),secret);
 assert.throws(()=>decryptDeviceSecret(master,legacyId,crypto.randomUUID(),'SH-AUTH-V1',1,1,envelope));
 const changed={...envelope,ciphertext:Buffer.from(envelope.ciphertext)};changed.ciphertext[0]^=1;
 assert.throws(()=>decryptDeviceSecret(master,legacyId,deviceId,'SH-AUTH-V1',1,1,changed));
});
test('challenge expiry, replay rejection and generation-specific cleanup remain intact',()=>{
 const store=new ShadowChallengeStore();
 const a=store.create(deviceId,legacyId,1,1,1000);assert.equal(store.take(a.challengeId,1001).kind,'ok');assert.equal(store.take(a.challengeId,1002).kind,'used');
 const b=store.create(deviceId,legacyId,1,1,2000);assert.equal(store.take(b.challengeId,2001+SH_AUTH_CHALLENGE_TTL_MS).kind,'expired');
 const c=store.create(deviceId,legacyId,1,1,40000),d=store.create(deviceId,legacyId,1,2,40000);
 store.deleteForSocket(1,legacyId,40001);assert.equal(store.take(c.challengeId,40002).kind,'used');assert.equal(store.take(d.challengeId,40002).kind,'ok');
});
test('disabled shadow authentication remains non-authoritative',async()=>{
 const service=new ShadowAuthService();const r=await service.handleHello(hello,{socketGeneration:1,legacyDeviceDbId:legacyId,lampId:'SH-ABC123'});
 assert.equal(r.code,'DISABLED');assert.equal(r.shadowOnly,true);assert.equal(r.ok,false);
});
test('slow shadow authentication does not block device ACKs or revoke legacy authority',async()=>{
 const hub=new WebSocketHub(),lampId='SH-ABC123';const socket={readyState:WebSocket.OPEN,meta:{kind:'device',authenticated:true,lampId,deviceId:legacyId,generation:1},close(){throw Error('shadow traffic must not close lamp');}};
 hub.deviceSockets.set(lampId,socket);const frames=[];hub.send=(_s,frame)=>frames.push(frame);
 let release;hub.shadowAuth.handleHello=()=>new Promise(r=>{release=r;});let acked=false;hub.handleDeviceMessage=async()=>{acked=true;};
 const shadow=hub.onMessage(socket,JSON.stringify(hello));await new Promise(r=>setImmediate(r));assert.ok(release);
 await hub.onMessage(socket,JSON.stringify({type:'ack',commandId:'cmd-123456',success:true}));assert.equal(acked,true);
 release({type:'authV2ShadowResult',protocol:'SH-AUTH-V1',deviceId,keyVersion:1,ok:false,code:'INVALID_PROOF',shadowOnly:true});await shadow;
 assert.equal(socket.meta.authenticated,true);assert.equal(hub.deviceSockets.get(lampId),socket);assert.equal(frames[0].shadowOnly,true);
});
test('concurrent app authentication cannot switch socket accounts',async()=>{
 const original=prisma.device.findMany,hub=new WebSocketHub(),socket=appSocket();let release,count=0;
 hub.send=()=>{};prisma.device.findMany=()=>{count++;return new Promise(r=>{release=r;});};
 const a={id:crypto.randomUUID(),email:'a@example.invalid'},b={id:crypto.randomUUID(),email:'b@example.invalid'};
 try{const pending=hub.authenticate(socket,{type:'auth',token:createAccessToken(a)});await hub.authenticate(socket,{type:'auth',token:createAccessToken(b)});assert.equal(count,1);release([]);await pending;assert.equal(socket.meta.userId,a.id);assert.equal(hub.appSockets.has(b.id),false);}
 finally{prisma.device.findMany=original;clearTimeout(socket.meta.authTimer);}
});
test('a closed handshake cannot publish authenticated access later',async()=>{
 const original=prisma.device.findMany,hub=new WebSocketHub(),socket=appSocket();let release;
 prisma.device.findMany=()=>new Promise(r=>{release=r;});
 try{const pending=hub.authenticate(socket,{type:'auth',token:createAccessToken({id:crypto.randomUUID(),email:'a@example.invalid'})});socket.readyState=WebSocket.CLOSED;release([]);await pending;assert.equal(socket.meta.authenticated,false);assert.equal(hub.appSockets.size,0);}
 finally{prisma.device.findMany=original;clearTimeout(socket.meta.authTimer);}
});
