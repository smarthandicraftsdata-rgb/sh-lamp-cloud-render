'use strict';

const assert = require('node:assert/strict');

class InflightModel {
  constructor() {
    this.generation = 1;
    this.entries = new Map();
    this.sends = 0;
    this.failNext = false;
    this.now = 1_000_000;
    this.maxInflight = 4096;
  }
  key(lamp, id) { return `${lamp}#${id}`; }
  prune() {
    for (const [k,e] of this.entries) if (e.expiresAt <= this.now) this.entries.delete(k);
  }
  async send(lamp,id,expiresAt=this.now+2000,allowResend=false) {
    this.prune();
    const key=this.key(lamp,id);
    const existing=this.entries.get(key);
    if (existing) {
      if (existing.terminalAckSeen) return existing.promise;
      if (existing.generation !== this.generation) this.entries.delete(key);
      else if (!allowResend) return existing.promise;
    }
    if (expiresAt <= this.now) return false;
    if (this.entries.size >= this.maxInflight) return false;
    let resolve;
    const promise=new Promise(r=>resolve=r);
    const entry={lamp,id,generation:this.generation,expiresAt,terminalAckSeen:false,promise};
    this.entries.set(key,entry); // BEFORE bytes are sent
    queueMicrotask(()=>{
      this.sends++;
      const ok=!this.failNext;
      this.failNext=false;
      resolve(ok);
      if (!ok && this.entries.get(key)===entry) this.entries.delete(key);
    });
    return promise;
  }
  ack(lamp,id) {
    const e=this.entries.get(this.key(lamp,id));
    if (e && e.generation===this.generation) e.terminalAckSeen=true;
  }
  ackPersisted(lamp,id) { this.entries.delete(this.key(lamp,id)); }
  replaceGeneration() {
    const old=this.generation;
    for (const [k,e] of this.entries) {
      if (e.generation===old && !e.terminalAckSeen) this.entries.delete(k);
    }
    this.generation++;
  }
}

async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}`); throw e; }
}

(async()=>{
  await test('concurrent WS + REST same ID => one device send', async()=>{
    const m=new InflightModel();
    const results=await Promise.all(Array.from({length:1000},()=>m.send('L','C1')));
    assert.ok(results.every(Boolean)); assert.equal(m.sends,1);
  });

  await test('hedge after send callback but before ACK => no redispatch', async()=>{
    const m=new InflightModel();
    assert.equal(await m.send('L','C2'),true);
    assert.equal(m.sends,1);
    assert.equal(await m.send('L','C2'),true);
    assert.equal(m.sends,1);
  });

  await test('ACK-before-DB tombstone closes async persistence race', async()=>{
    const m=new InflightModel();
    await m.send('L','C3'); m.ack('L','C3');
    for(let i=0;i<100;i++) assert.equal(await m.send('L','C3'),true);
    assert.equal(m.sends,1);
  });

  await test('ACK tombstone survives device generation replacement before DB persistence', async()=>{
    const m=new InflightModel();
    await m.send('L','C3B'); m.ack('L','C3B');
    assert.equal(m.sends,1);
    m.replaceGeneration();
    for(let i=0;i<100;i++) assert.equal(await m.send('L','C3B'),true);
    assert.equal(m.sends,1);
    m.ackPersisted('L','C3B');
    assert.equal(m.entries.size,0);
  });

  await test('failed socket send releases ownership for retry', async()=>{
    const m=new InflightModel(); m.failNext=true;
    assert.equal(await m.send('L','C4'),false); assert.equal(m.sends,1);
    assert.equal(await m.send('L','C4'),true); assert.equal(m.sends,2);
  });

  await test('device generation loss deliberately permits recovery send', async()=>{
    const m=new InflightModel();
    await m.send('L','C5'); assert.equal(m.sends,1);
    m.replaceGeneration();
    await m.send('L','C5'); assert.equal(m.sends,2);
  });

  await test('requestState same-generation retry allowed before ACK only', async()=>{
    const m=new InflightModel();
    await m.send('L','R1',m.now+10000); assert.equal(m.sends,1);
    await m.send('L','R1',m.now+10000,true); assert.equal(m.sends,2);
    m.ack('L','R1');
    await m.send('L','R1',m.now+10000,true); assert.equal(m.sends,2);
  });

  await test('expiry prunes ownership', async()=>{
    const m=new InflightModel();
    await m.send('L','C6',m.now+50); assert.equal(m.sends,1);
    m.now+=60; m.prune(); assert.equal(m.entries.size,0);
    assert.equal(await m.send('L','C6',m.now-1),false); assert.equal(m.sends,1);
  });

  await test('capacity fails closed without evicting live ownership', async()=>{
    const m=new InflightModel();
    await Promise.all(Array.from({length:m.maxInflight},(_,i)=>m.send('L',`CAP${i}`,m.now+10000)));
    assert.equal(m.sends,m.maxInflight);
    assert.equal(await m.send('L','CAP-NEW',m.now+10000),false);
    assert.equal(m.sends,m.maxInflight);
    // Existing ownership must still join and must not be evicted by capacity.
    assert.equal(await m.send('L','CAP0',m.now+10000),true);
    assert.equal(m.sends,m.maxInflight);
  });

  await test('different command IDs are never collapsed', async()=>{
    const m=new InflightModel();
    await Promise.all(Array.from({length:500},(_,i)=>m.send('L',`D${i}`)));
    assert.equal(m.sends,500);
  });

  await test('randomized same-ID hedge storm preserves one send per generation', async()=>{
    for(let round=0;round<2000;round++) {
      const m=new InflightModel();
      const calls=2+Math.floor(Math.random()*20);
      await Promise.all(Array.from({length:calls},()=>m.send('L','X')));
      assert.equal(m.sends,1);
      const branch=Math.random();
      if (branch<0.34) {
        m.ack('L','X');
        await Promise.all(Array.from({length:10},()=>m.send('L','X')));
        assert.equal(m.sends,1);
      } else if (branch<0.67) {
        m.ack('L','X');
        m.replaceGeneration();
        await Promise.all(Array.from({length:10},()=>m.send('L','X')));
        assert.equal(m.sends,1);
      } else {
        m.replaceGeneration();
        await Promise.all(Array.from({length:10},()=>m.send('L','X')));
        assert.equal(m.sends,2);
      }
    }
  });

  console.log('RF5.4.2 backend in-flight acceptance: ALL PASS');
})().catch(()=>process.exit(1));
