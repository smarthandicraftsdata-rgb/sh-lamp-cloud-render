// Uses a disposable PostgreSQL database. Never point TEST_DATABASE_URL at production.
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
if (!process.env.TEST_DATABASE_URL) throw Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ACCESS_TOKEN_SECRET = 'test-only-signing-secret-with-32-characters';
process.env.ADMIN_SETUP_KEY = 'test-only-admin-key-with-24-characters';
process.env.NODE_ENV = 'test';
const {prisma} = require('../dist/db');
if(process.env.SESSION_TEST_MODEL === '1') require('./session-model.cjs')(prisma);
const {issueSession, refreshSession, logoutSession, revokeUserSessions, lockSessionUser} = require('../dist/sessionService');
const {hashSecret, createOpaqueToken, createAccessToken} = require('../dist/security');
const {WebSocketHub} = require('../dist/websocketHub');
const {WebSocket} = require('ws');
const ids = [];
async function user() {
 const u = await prisma.user.create({data:{email:`session-test-${crypto.randomUUID()}@example.invalid`, displayName:'Session test',passwordHash:'test-password-hash'}});
 ids.push(u.id); return u;
}
const rejected = p => assert.rejects(p,e=>e.status === 401);
after(async()=>{await prisma.user.deleteMany({where:{id:{in:ids}}});await prisma.$disconnect();});
test('lost response retry returns same successor without extending deadline',async()=>{
 const u=await user(), s=await issueSession(u), a=await refreshSession(s.refreshToken);
 const parent=await prisma.refreshToken.findUnique({where:{tokenHash:hashSecret(s.refreshToken)}});
 const b=await refreshSession(s.refreshToken);
 assert.equal(a.refreshToken,b.refreshToken);assert.equal(a.refreshTokenExpiresAt,b.refreshTokenExpiresAt);
 const again=await prisma.refreshToken.findUnique({where:{id:parent.id}});
 assert.equal(+parent.retryUntil,+again.retryUntil);
 assert.ok(parent.retryCiphertext);assert.ok(!parent.retryCiphertext.includes(a.refreshToken));
});
test('parallel refresh creates exactly one successor',async()=>{
 const u=await user(),s=await issueSession(u);
 const replies=await Promise.all(Array.from({length:12},()=>refreshSession(s.refreshToken)));
 assert.equal(new Set(replies.map(x=>x.refreshToken)).size,1);
 assert.equal(await prisma.refreshToken.count({where:{userId:u.id}}),2);
});
test('expired retry, expired token and unknown token are rejected',async()=>{
 const u=await user(),s=await issueSession(u);await refreshSession(s.refreshToken);
 await prisma.refreshToken.update({where:{tokenHash:hashSecret(s.refreshToken)},data:{retryUntil:new Date(0)}});
 await rejected(refreshSession(s.refreshToken));await rejected(refreshSession(createOpaqueToken()));
 const t=await issueSession(u);await prisma.refreshToken.update({where:{tokenHash:hashSecret(t.refreshToken)},data:{expiresAt:new Date(0)}});
 await rejected(refreshSession(t.refreshToken));
});
test('logout with spent parent revokes successor but preserves another device session',async()=>{
 const u=await user(),s=await issueSession(u),other=await issueSession(u),a=await refreshSession(s.refreshToken);
 await logoutSession(s.refreshToken);await logoutSession(s.refreshToken);
 await rejected(refreshSession(a.refreshToken));await rejected(refreshSession(s.refreshToken));
 await refreshSession(other.refreshToken);
});
test('logout races refresh without allowing an active successor',async()=>{
 const u=await user(),s=await issueSession(u);
 await Promise.allSettled([refreshSession(s.refreshToken),logoutSession(s.refreshToken)]);
 assert.equal(await prisma.authSession.count({where:{userId:u.id,revokedAt:null}}),0);
 assert.equal(await prisma.refreshToken.count({where:{userId:u.id,revokedAt:null}}),0);
});
test('password reset revokes all sessions and prevents stale login issuance',async()=>{
 const u=await user(),s=await issueSession(u),a=await refreshSession(s.refreshToken);
 await prisma.$transaction(async tx=>{await lockSessionUser(tx,u.id);await tx.user.update({where:{id:u.id},data:{passwordHash:'changed'}});await revokeUserSessions(tx,u.id,new Date());});
 await rejected(refreshSession(s.refreshToken));await rejected(refreshSession(a.refreshToken));await rejected(issueSession(u));
});
test('valid legacy tokens migrate lazily; revoked legacy tokens remain rejected',async()=>{
 const u=await user(),token=createOpaqueToken();
 await prisma.refreshToken.create({data:{userId:u.id,tokenHash:hashSecret(token),expiresAt:new Date(Date.now()+60000)}});
 await refreshSession(token);
 const p=await prisma.refreshToken.findUnique({where:{tokenHash:hashSecret(token)}});assert.ok(p.sessionId);
 const bad=createOpaqueToken();await prisma.refreshToken.create({data:{userId:u.id,tokenHash:hashSecret(bad),expiresAt:new Date(Date.now()+60000),revokedAt:new Date()}});
 await rejected(refreshSession(bad));
});
test('corrupt recovery data produces retryable 503, never authentication rejection',async()=>{
 const u=await user(),s=await issueSession(u);await refreshSession(s.refreshToken);
 await prisma.refreshToken.update({where:{tokenHash:hashSecret(s.refreshToken)},data:{retryCiphertext:'v1.corrupt'}});
 await assert.rejects(refreshSession(s.refreshToken),e=>e.status===503);
});
test('a consumed successor cannot be resurrected by its parent',async()=>{
 const u=await user(),s=await issueSession(u),a=await refreshSession(s.refreshToken);await refreshSession(a.refreshToken);
 await rejected(refreshSession(s.refreshToken));
});
test('WebSocket auth separates database failures from rejected credentials',async()=>{
 const hub=new WebSocketHub(), original=prisma.device.findMany;
 const socket=()=>({readyState:WebSocket.OPEN,meta:{kind:'app',authenticated:false,authTimer:setTimeout(()=>{},10000)},close(code){this.code=code;clearTimeout(this.meta.authTimer);}});
 try {
  prisma.device.findMany=async()=>{throw Error('simulated database outage');};
  const temporary=socket();await hub.authenticate(temporary,{type:'auth',token:createAccessToken({id:crypto.randomUUID(),email:'test@example.invalid'})});assert.equal(temporary.code,1011);assert.equal(temporary.meta.authenticated,false);
  const invalid=socket();await hub.authenticate(invalid,{type:'auth',token:'invalid-token-with-enough-characters'});assert.equal(invalid.code,4003);
 } finally {prisma.device.findMany=original;}
});
test('HTTP refresh handler preserves its JSON contract and transient errors return 500',async()=>{
 const express=require('express');const {authRouter}=require('../dist/routes/authRoutes');const {errorHandler}=require('../dist/errors');
 const app=express();app.use(express.json());app.use(authRouter);app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url=`http://127.0.0.1:${server.address().port}/api/auth/refresh`;
 const post=token=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({refreshToken:token})});
 try{
  const u=await user(),s=await issueSession(u);const first=await post(s.refreshToken),a=await first.json();assert.equal(first.status,200);assert.equal(a.ok,true);
  const retry=await post(s.refreshToken),b=await retry.json();assert.equal(retry.status,200);assert.equal(a.session.refreshToken,b.session.refreshToken);
  const original=prisma.refreshToken.findUnique;try{prisma.refreshToken.findUnique=async()=>{throw Error('simulated database outage');};const failed=await post(s.refreshToken);assert.equal(failed.status,500);}finally{prisma.refreshToken.findUnique=original;}
 }finally{await new Promise(r=>server.close(r));}
});
