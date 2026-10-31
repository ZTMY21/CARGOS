import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
const kinds=[{kind:'cargos',slug:'cargos-nuevos-onedit',old:'18TbKWiVUWKfkJOXvR0kGEMb5eVKTDCfoXAUtD5rCxts',next:'14GzTxs9-hk3_vPTI7AYLc3jiqLAaAC5q7y910wo8Jh0',header:'X-Cargos-Token',method:'kardex_live_ingest'},{kind:'im',slug:'im-envios-live',old:'1aWqIoj5UXAeyKhNN1paoYnTa4jdfN8LhDEcdH_lQ4mk',next:'1VWmKFmE8UcXV6ukG8k-wqKqCzuJbPGYOf9RFowojhSw',header:'X-IM-Token',method:'im_sync_new_shipments'}];
for(const k of kinds)test(k.slug+': existing requests retain their contract; new-source probes cannot write data',async()=>{
 let handler;const sent=[],service='test-platform-service-key';
 const source=(await readFile(new URL('../supabase/functions/'+k.slug+'/index.ts',import.meta.url),'utf8')).replace(/^import .*edge-runtime\.d\.ts.*;\n/m,'');
 const fetcher=async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});assert.equal(options.headers.apikey,service);return Response.json({verificado:true});};
 vm.runInNewContext(stripTypeScriptTypes(source),{Deno:{env:{get:n=>({SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:service})[n]},serve:fn=>handler=fn},fetch:fetcher,Response,Request,AbortSignal,console});
 const call=(sheet,mode='ingest',token='test-only-secret-of-more-than-forty-characters')=>handler(new Request('https://edge.test',{method:'POST',headers:{'Content-Type':'application/json',[k.header]:token},body:JSON.stringify(mode==='probe'?{sheet_id:sheet,mode}:{sheet_id:sheet,mode,rows:[{row:2,test:true}]})}));
 assert.equal((await call(k.old)).status,200);assert.equal(sent[0].body.p_sheet_id,k.old);assert.ok(sent[0].url.endsWith('/'+k.method));
 assert.equal((await call(k.next,'probe')).status,200);assert.ok(sent[1].url.endsWith('/kardex_live_source_probe'));assert.equal(sent[1].body.p_sheet_id,k.next);assert.equal(sent[1].body.p_kind,k.kind);assert.equal(sent[1].body.p_rows,undefined);
 assert.equal((await call('unapproved-source')).status,400);assert.equal((await call(k.next,'probe','short')).status,401);assert.equal(sent.length,2);
});
