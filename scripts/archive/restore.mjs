// Restores ONLY to an explicitly named, empty, local test database. No clean/drop.
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {keyFrom,digestFile,decryptTo} from './backup.mjs';
function command(bin,args,env){return new Promise((ok,bad)=>{const p=spawn(bin,args,{env,stdio:['ignore','pipe','pipe']});let text='';p.stdout.on('data',b=>text+=b);p.stderr.resume();p.once('error',bad);p.once('close',c=>c===0?ok(text):bad(new Error('Falló la herramienta de restauración.')));});}
try{
 const env=process.env;if(!['127.0.0.1','localhost','::1'].includes(env.PGHOST)||!/^kardex_restore_[a-z0-9_]+$/.test(env.PGDATABASE||'')||env.PGSERVICE)throw new Error('La restauración exige una base local kardex_restore_* explícita, sin PGSERVICE.');
 const manifestPath=resolve(process.argv[2]),m=JSON.parse(await readFile(manifestPath,'utf8'));
 if(!/^postgres-[\w.T-]+\.enc$/.test(m.file))throw new Error('Nombre de respaldo inválido.');
 const file=join(dirname(manifestPath),m.file);if(await digestFile(file)!==m.ciphertextSha256)throw new Error('SHA-256 del respaldo no coincide.');
 const tables=await command('psql',['--no-password','-Atc',"select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')"],env);
 if(Number(tables.trim())!==0)throw new Error('La base de prueba debe estar vacía.');
 const child=spawn('pg_restore',['--exit-on-error','--single-transaction','--no-owner','--no-acl','--no-password','--dbname',env.PGDATABASE],{env,stdio:['pipe','ignore','pipe']});
 child.stderr.resume();const completed=new Promise((ok,bad)=>{child.once('error',bad);child.once('close',c=>c===0?ok():bad(new Error('Restauración no completada.')));});completed.catch(()=>{});
 const sha=await decryptTo(file,child.stdin,keyFrom(env));await completed;if(sha!==m.plaintextSha256)throw new Error('SHA-256 de contenido no coincide.');
 console.log(JSON.stringify({restored:true,localOnly:true,sha256:sha,productionModified:false}));
}catch{console.error('No se verificó la restauración. Compruebe manifiesto, clave y base local vacía con los roles de Supabase preparados.');process.exitCode=1;}
