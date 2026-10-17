import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdleSession,IDLE_LIMIT} from '../src/idle-session.js';
function fixture(storage=new Map()){
 let time=10000,expired=0,id=0;
 const timers=new Map(),window=new EventTarget();
 window.document=new EventTarget();window.document.hidden=false;
 window.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};
 window.atob=atob;window.setTimeout=(fn,ms)=>{timers.set(++id,{fn,at:time+ms});return id;};window.clearTimeout=id=>timers.delete(id);
 const idle=createIdleSession({window,now:()=>time,onExpire:()=>expired++});
 const session={user:{id:'user'},access_token:'x.'+btoa(JSON.stringify({session_id:'one'}))+'.x'};
 return {idle,window,session,storage,timers,get expired(){return expired;},advance(ms){time+=ms;},tick(){for(const [id,t] of [...timers])if(t.at<=time){timers.delete(id);t.fn();}}};
}
test('expires at one hour, and automatic checks never renew activity',()=>{
 const f=fixture();assert.equal(f.idle.start(f.session),true);
 f.advance(IDLE_LIMIT-1);f.idle.check();assert.equal(f.expired,0);
 f.advance(1);f.tick();assert.equal(f.expired,1);assert.equal(f.timers.size,0);
 f.idle.destroy();
});
test('user activity resets the hour; late activity after sleep cannot revive the session',()=>{
 const f=fixture();f.idle.start(f.session);f.advance(IDLE_LIMIT-1000);
 f.window.dispatchEvent(new Event('keydown'));f.advance(1001);f.tick();assert.equal(f.expired,0);
 f.advance(IDLE_LIMIT);f.window.dispatchEvent(new Event('pointerdown'));assert.equal(f.expired,1);
 f.idle.destroy();
});
test('reload preserves expiry, a fresh login starts a new session, and tabs share activity',()=>{
 const f=fixture();f.idle.start(f.session);f.advance(IDLE_LIMIT);f.idle.stop();
 assert.equal(f.idle.start(f.session),false);assert.equal(f.expired,1);
 f.session.access_token='x.'+btoa(JSON.stringify({session_id:'two'}))+'.x';assert.equal(f.idle.start(f.session),true);
 f.advance(IDLE_LIMIT-1);
 const key='kardex-idle:user:two';f.storage.set(key,String(10000+2*IDLE_LIMIT-1));
 f.advance(2);f.idle.check();assert.equal(f.expired,1);
 f.idle.destroy();
});
