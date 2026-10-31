// Full PostgreSQL backup. No plaintext dump is written; never uploads to Drive.
import {spawn} from 'node:child_process';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,open,appendFile,rename,writeFile,stat} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const magic=Buffer.from('KDAR1');
export function keyFrom(env){const key=Buffer.from(env.KARDEX_BACKUP_KEY||'','base64');if(key.length!==32)throw new Error('Configure KARDEX_BACKUP_KEY con 32 bytes desde el gestor de secretos.');return key;}
export async function digestFile(path){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');}
export async function encryptStream(input,path,key){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),h=createHash('sha256');
 const out=createWriteStream(path,{flags:'wx',mode:0o600});out.write(Buffer.concat([magic,iv]));
 await pipeline(input,new Transform({transform(b,e,done){h.update(b);done(null,b);}}),cipher,out);
 await appendFile(path,cipher.getAuthTag());return {plaintextSha256:h.digest('hex'),ciphertextSha256:await digestFile(path)};
}
export async function decryptTo(path,output,key){
 const s=await stat(path);if(s.size<33)throw new Error('Respaldo incompleto.');
 const f=await open(path,'r');let header=Buffer.alloc(17),tag=Buffer.alloc(16);try{await f.read(header,0,17,0);await f.read(tag,0,16,s.size-16);}finally{await f.close();}
 if(!header.subarray(0,5).equals(magic))throw new Error('Formato de respaldo no reconocido.');
 const dec=createDecipheriv('aes-256-gcm',key,header.subarray(5));dec.setAuthTag(tag);
 const hash=createHash('sha256');await pipeline(createReadStream(path,{start:17,end:s.size-17}),dec,new Transform({transform(b,e,done){hash.update(b);done(null,b);}}),output);return hash.digest('hex');
}
export async function backup(destination,env=process.env){
 const key=keyFrom(env);if(!env.PGHOST&&!env.PGSERVICE)throw new Error('Falta una conexión PostgreSQL gestionada; no se usa una conexión por defecto.');
 const dir=resolve(destination);if(dir.includes('/.git/')||!dir.includes('private-archive'))throw new Error('Use un directorio privado llamado private-archive fuera del código publicado.');
 await mkdir(dir,{recursive:true,mode:0o700});const name='postgres-'+new Date().toISOString().replaceAll(':','-'),partial=join(dir,name+'.enc.partial');
 const child=spawn('pg_dump',['--format=custom','--no-owner','--no-acl','--no-password'],{env:{...env,PGCONNECT_TIMEOUT:'10'},stdio:['ignore','pipe','pipe']});
 const completion=new Promise((ok,bad)=>{child.once('error',bad);child.once('close',code=>code===0?ok():bad(new Error('pg_dump no terminó correctamente; el archivo parcial no es un respaldo validado.')));});
 child.stderr.resume();completion.catch(()=>{});
 const checks=await encryptStream(child.stdout,partial,key);await completion;
 const file=partial.replace(/\.partial$/,'');await rename(partial,file);
 const manifest={version:1,createdAt:new Date().toISOString(),format:'pg_dump-custom+A256GCM',file:name+'.enc',...checks,bytes:(await stat(file)).size,completeDump:true,restorationVerified:false,driveUploaded:false};
 await writeFile(join(dir,name+'.manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});return manifest;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){backup(process.argv[2]||'').then(r=>console.log(JSON.stringify(r,null,2))).catch(()=>{console.error('No se completó el respaldo. Revise la conexión gestionada, pg_dump y el destino privado. No se tocaron datos de origen.');process.exitCode=1;});}
