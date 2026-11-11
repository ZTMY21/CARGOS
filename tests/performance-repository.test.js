import test from 'node:test';
import assert from 'node:assert/strict';
import {KardexRepository} from '../src/repository.js';

function fakeClient(reply=ids=>Object.fromEntries(ids.map(id=>[id,[]]))) {
  const calls=[];let active=0,maxActive=0;
  return {calls,get maxActive(){return maxActive;},rpc(name,args){
    const ids=args.p_documento_ids;calls.push({name,ids});
    let signal;
    return {abortSignal(next){signal=next;return this;},async then(resolve,reject){
      active++;maxActive=Math.max(maxActive,active);
      try {
        await new Promise(done=>setTimeout(done,1));
        if(signal?.aborted)throw signal.reason;
        resolve({data:reply(ids,calls.length),error:null});
      } catch(error){reject(error);}
      finally{active--;}
    }};
  }};
}

test('performance: previous cargos return every ID, serializing batches across overlapping pages',async()=>{
  const client=fakeClient(),repo=new KardexRepository(client);
  const ids=Array.from({length:250},(_,i)=>'doc-'+i),batches=[];
  const [first,second]=await Promise.all([
    repo.previousCargos([...ids,ids[0]],{onBatch:batch=>batches.push(batch)}),
    repo.previousCargos(['next-page'])
  ]);
  assert.deepEqual(Object.keys(first).sort(),ids.sort());
  assert.deepEqual(second,{'next-page':[]});
  assert.equal(client.maxActive,1);
  assert.ok(client.calls.every(call=>call.ids.length<=100));
  assert.equal(batches.length,3);
  assert.deepEqual(await repo.previousCargos([]),{});
  assert.equal(client.calls.length,4);
});

test('performance: cancellation prevents queued batches from reading more documents',async()=>{
  const client=fakeClient(),repo=new KardexRepository(client),controller=new AbortController();
  await assert.rejects(repo.previousCargos(Array.from({length:250},(_,i)=>'doc-'+i),{
    signal:controller.signal,onBatch:()=>controller.abort()
  }),error=>error.name==='AbortError');
  assert.equal(client.calls.length,1);
  assert.deepEqual(await repo.previousCargos(['valid']),{valid:[]},'cancellation does not poison the queue');
});

test('performance: incomplete history is an error and never becomes an empty successful relationship',async()=>{
  const client=fakeClient(()=>({})),repo=new KardexRepository(client);
  await assert.rejects(repo.previousCargos(['missing']),/Respuesta incompleta/);
});
