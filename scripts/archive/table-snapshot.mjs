// Read-only table exports arrive as canonical PostgreSQL JSON lines. This is
// a recoverable table snapshot, never a replacement for a complete pg_dump.
import {createReadStream} from 'node:fs';
import {readFile,readdir,link,unlink,writeFile,stat} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {Readable,PassThrough} from 'node:stream';
import {createGzip,createGunzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {encryptStream,decryptTo,digestFile,keyFrom} from './backup.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const types=new Set(['uuid','text','date','int4','_text','timestamptz','jsonb']);
const ident=n=>{if(!/^[a-z_][a-z0-9_]*$/.test(n))throw Error('Invalid column identifier');return '"'+n+'"';};
async function parts(dir){return (await readdir(dir)).filter(n=>/^\d{5}\.jsonl$/.test(n)).sort().map(n=>join(dir,n));}
export async function fingerprint(files){
 const leaves=[],ids=new Set();let bytes=0,previous='';
 for(const file of files)for await(const line of createInterface({input:createReadStream(file),crlfDelay:Infinity})){
  const row=JSON.parse(line);if(!/^[a-f0-9-]{36}$/.test(row.id)||ids.has(row.id)||row.id<=previous)throw Error('Missing, duplicate or unordered export ID');
  ids.add(row.id);previous=row.id;bytes+=Buffer.byteLength(line);leaves.push(row.id+':'+hash(line));
 }
 return {rows:leaves.length,rowsetSha256:hash(leaves.join('\n')),jsonBytes:bytes};
}
export async function pack(dir,metadata,destination,key){
 if(!resolve(destination).includes('/private-archive/'))throw Error('Use a private-archive destination');
 try{await stat(destination);throw Error('Snapshot already exists; reuse its manifest');}catch(e){if(e.code!=='ENOENT')throw e;}
 const files=await parts(dir),measured=await fingerprint(files);
 for(const name of ['rows','rowsetSha256','jsonBytes'])if(metadata[name]!==measured[name])throw Error('Incomplete or changed source export: '+name);
 for(const c of metadata.columns){ident(c.name);if(!types.has(c.type))throw Error('Unsupported column type');}
 const header={format:'kardex-table-jsonl-v1',...metadata,completeDatabaseBackup:false};
 async function* content(){yield Buffer.from(JSON.stringify(header)+'\n');for(const file of files)for await(const chunk of createReadStream(file))yield chunk;}
 const source=Readable.from(content()),compressed=createGzip({level:9});source.on('error',e=>compressed.destroy(e));source.pipe(compressed);
 const partial=destination+'.partial',checks=await encryptStream(compressed,partial,key);await link(partial,destination);await unlink(partial);
 const manifest={...header,encoding:'gzip+A256GCM-KDAR1',...checks,bytes:(await stat(destination)).size,restorationVerified:false};
 await writeFile(destination+'.manifest.json',JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});return manifest;
}
export async function restoreCheck(file,manifest,key){
 if(await digestFile(file)!==manifest.ciphertextSha256)throw Error('Ciphertext checksum mismatch');
 // This target is always an embedded, temporary PostgreSQL database. No remote
 // connection, existing tables, source writes, DROP or TRUNCATE are possible.
 const db=new PGlite(),plain=new PassThrough(),gunzip=createGunzip();plain.on('error',e=>gunzip.destroy(e));plain.pipe(gunzip);
 const decrypted=decryptTo(file,plain,key);decrypted.catch(e=>gunzip.destroy(e));
 let header,batch=[],received=0;
 try{
  const insert=async()=>{if(!batch.length)return;await db.query('insert into recovery.source select * from jsonb_populate_recordset(null::recovery.source,$1::jsonb)',['['+batch.join(',')+']']);received+=batch.length;batch=[];};
  for await(const line of createInterface({input:gunzip,crlfDelay:Infinity})){
   if(!header){header=JSON.parse(line);if(header.format!=='kardex-table-jsonl-v1'||header.rowsetSha256!==manifest.rowsetSha256)throw Error('Invalid snapshot header');
    const cols=header.columns.map(c=>{if(!types.has(c.type))throw Error('Unsupported type');return ident(c.name)+' '+(c.type==='_text'?'text[]':c.type);});
    await db.exec('set timezone=\'UTC\';create schema recovery;create table recovery.source('+cols.join(',')+');');continue;
   }
   batch.push(line);if(batch.length===20)await insert();
  }
  const plaintextSha256=await decrypted;if(plaintextSha256!==manifest.plaintextSha256)throw Error('Plaintext checksum mismatch');await insert();
  const result=(await db.query("select count(*)::int as rows,encode(sha256(convert_to(string_agg(id::text||':'||encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'),E'\\n' order by id::text),'UTF8')),'hex') as sha256 from recovery.source t")).rows[0];
  if(received!==manifest.rows||result.rows!==manifest.rows||result.sha256!==manifest.rowsetSha256)throw Error('Restored rows differ from the source');
  return {rows:result.rows,rowsetSha256:result.sha256,plaintextSha256,ciphertextSha256:manifest.ciphertextSha256,restorationVerified:true,target:'isolated-embedded-postgresql',completeDatabaseBackup:false};
 }finally{plain.destroy();gunzip.destroy();await db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [action,a,b,c]=process.argv.slice(2),key=keyFrom(process.env);
 const work=action==='pack'?pack(a,JSON.parse(await readFile(b,'utf8')),c,key):action==='verify'?restoreCheck(a,JSON.parse(await readFile(b,'utf8')),key):Promise.reject(Error('Use pack or verify'));
 work.then(r=>console.log(JSON.stringify(r,null,2))).catch(()=>{console.error('Snapshot not verified; preserve the source.');process.exitCode=1;});
}
