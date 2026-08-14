'use strict';
const assert=require('node:assert/strict');

// Deterministic xorshift32 so a failure is reproducible.
let seed=0x5a42c0de;
function rnd(){ seed^=seed<<13; seed^=seed>>>17; seed^=seed<<5; return (seed>>>0)/0x100000000; }

class Model {
  constructor(){this.gen=1;this.e=null;this.sends=0;this.now=1000000;}
  send(id='X', allow=false){
    if(this.e && this.e.exp<=this.now) this.e=null;
    if(this.e){
      if(this.e.ack) return true;
      if(this.e.gen!==this.gen) this.e=null;
      else if(!allow) return true;
    }
    if(this.e===null){this.e={id,gen:this.gen,exp:this.now+2000,ack:false};}
    this.sends++;
    return true;
  }
  ack(){if(this.e && this.e.gen===this.gen)this.e.ack=true;}
  reconnect(){const old=this.gen;if(this.e&&this.e.gen===old&&!this.e.ack)this.e=null;this.gen++;}
}

const rounds=100000;
for(let r=0;r<rounds;r++){
  const m=new Model();
  // Initial concurrent/hedged logical command must physically dispatch once.
  const initial=2+Math.floor(rnd()*20);
  for(let i=0;i<initial;i++)m.send();
  assert.equal(m.sends,1);

  const mode=Math.floor(rnd()*4);
  if(mode===0){
    // ACK then same-gen hedge storm.
    m.ack(); for(let i=0;i<20;i++)m.send(); assert.equal(m.sends,1);
  } else if(mode===1){
    // ACK then reconnect while DB visibility is pending: never resend.
    m.ack(); m.reconnect(); for(let i=0;i<20;i++)m.send(); assert.equal(m.sends,1);
  } else if(mode===2){
    // Genuine generation loss before ACK permits exactly one recovery send.
    m.reconnect(); for(let i=0;i<20;i++)m.send(); assert.equal(m.sends,2);
  } else {
    // Explicit requestState retry is allowed before ACK; ACK stops further retries.
    m.send('X',true); assert.equal(m.sends,2); m.ack();
    m.send('X',true); assert.equal(m.sends,2);
  }
}
console.log(`RF5.4.2 deterministic randomized stress: PASS rounds=${rounds} seed=0x5a42c0de`);
