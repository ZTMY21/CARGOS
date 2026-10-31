import './drive-archive-ui.css';
import {createClient} from '@supabase/supabase-js';
const $=id=>document.getElementById(id);
let supabase;
async function token(){supabase||=createClient(__SUPABASE_URL__,__SUPABASE_ANON_KEY__);const {data}=await supabase.auth.getSession();if(!data.session)throw Error('Inicia sesión en Kardex para consultar archivos reales.');return data.session.access_token;}
async function request(action,{auth=false,id,offset,kardex,documentId,body,binary=false}={}){
 const q=new URLSearchParams({action});for(const [k,v]of Object.entries({id,offset,kardex,documentId}))if(v!==undefined)q.set(k,String(v));
 const headers={};if(auth)headers.Authorization='Bearer '+await token();if(body!==undefined)headers['Content-Type']=binary?'application/octet-stream':'application/json';
 const r=await fetch('/api/drive-archive?'+q,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:binary?body:JSON.stringify(body)});
 if(!r.ok){const d=await r.json().catch(()=>({}));throw Error(d.error||'No se pudo completar la operación.');}return r;
}
const labels={NOT_ENABLED:'Transferencia real desactivada.',INSTITUTIONAL_AUTHORIZATION_PENDING:'Falta autorización institucional documentada.',ISOLATED_DATABASE_REQUIRED:'Falta una base de prueba aislada.',BACKEND_CONFIGURATION_PENDING:'Falta configurar la conexión segura del backend.',PRODUCTION_RELEASE_NOT_APPROVED:'Producción requiere aprobación expresa.'};
try{const s=await(await request('status')).json();$('archiveMode').textContent=s.enabled?'Conexión de archivo habilitada':'Transferencia real bloqueada';$('archiveStatusText').textContent=s.enabled?'Cada copia debe superar la lectura de recuperación y la comprobación SHA-256.':'Puedes ejecutar la prueba ficticia; no se han trasladado documentos reales.';
 for(const reason of s.reasons){const li=document.createElement('li');li.textContent=labels[reason]||'Configuración pendiente de revisión.';$('archiveRequirements').append(li);}
 if(s.enabled){await token();const {data,error}=await supabase.rpc('kardex_access');if(error||!data?.is_admin)throw Error('La carga de archivos requiere una cuenta administradora.');$('archiveFields').disabled=false;$('archiveLiveMessage').textContent='El archivo se copia por bloques y solo queda disponible después de verificar su recuperación.';}
}catch(error){$('archiveLiveMessage').textContent=error.message;}
$('archiveRunDemo').addEventListener('click',async()=>{
 const button=$('archiveRunDemo');button.disabled=true;$('archiveDemoResult').textContent='Ejecutando prueba ficticia…';
 try{const d=await(await request('demo',{body:{}})).json();const checks=[['Recuperación con SHA-256 coincidente',d.restoredChecksumMatches],['Reintento sin duplicar archivos',d.idempotent],['Relaciones documentales independientes',d.distinctRelationsPreserved],['Duplicados legítimos conservados',d.duplicateRowsPreserved],['Un fallo no se marca como completado',d.failedTransferNotCompleted],['Recuperación después del fallo',d.retryRecovered]];
 $('archiveDemoResult').replaceChildren();for(const [text,ok]of checks){const p=document.createElement('div');p.className='check';p.textContent=(ok?'✓ ':'✗ ')+text;$('archiveDemoResult').append(p);}const p=document.createElement('p');p.textContent=`${d.syntheticFilesVerified} archivos ficticios verificados · ${d.realFilesTransferred} archivos reales trasladados.`;$('archiveDemoResult').append(p);$('archiveDemoDownload').hidden=false;
 }catch(e){$('archiveDemoResult').textContent='No se completó la prueba: '+e.message;}finally{button.disabled=false;}
});
async function resolveDocument(){return(await request('resolve',{auth:true,kardex:$('archiveKardex').value.trim().toUpperCase()})).json();}
async function list(){const doc=await resolveDocument(),d=await(await request('list',{auth:true,documentId:doc.id})).json();$('archiveFiles').replaceChildren();for(const job of d.files){const row=document.createElement('div');row.className='file-row';const name=document.createElement('strong');name.textContent=job.name;row.append(name);const state=document.createElement('small');state.textContent=job.status==='verified'&&!job.errorCode?'Copia verificada':'Pendiente de verificación o conciliación';row.append(state);if(job.status==='verified'&&!job.errorCode){const b=document.createElement('button');b.textContent='Descargar';b.onclick=async()=>{try{const r=await request('download',{auth:true,id:job.id});const u=URL.createObjectURL(await r.blob());const a=document.createElement('a');a.href=u;a.download=job.name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}catch(e){$('archiveProgress').textContent=e.message;}};row.append(b);}$('archiveFiles').append(row);}}
$('archiveList').addEventListener('click',()=>list().catch(e=>$('archiveProgress').textContent=e.message));
$('archiveForm').addEventListener('submit',async e=>{e.preventDefault();$('archiveUpload').disabled=true;
 try{const f=$('archiveFile').files[0];if(!f||f.size>100*1024**2)throw Error('Selecciona un archivo de hasta 100 MiB.');const doc=await resolveDocument();$('archiveProgress').textContent='Calculando integridad del archivo…';const bytes=await f.arrayBuffer(),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
 let job=await(await request('start',{auth:true,body:{documentId:doc.id,sourceKey:'manual:'+f.name,sourceVersion:new Date(f.lastModified).toISOString(),modifiedAt:new Date(f.lastModified).toISOString(),name:f.name,mime:f.type||'application/octet-stream',category:$('archiveCategory').value,size:f.size,sha256:digest}})).json();
 while(job.status!=='verified'&&job.offset<f.size){$('archiveProgress').textContent=`Copiando ${Math.round(job.offset/f.size*100)} % · el original se conserva`;try{job=await(await request('chunk',{auth:true,id:job.id,offset:job.offset,body:new Uint8Array(bytes.slice(job.offset,Math.min(f.size,job.offset+1024**2))),binary:true})).json();}catch(error){if(error.message!=='OFFSET_CONFLICT')throw error;job=await(await request('reconcile',{auth:true,id:job.id,body:{}})).json();}}
 if(job.status!=='verified'){ $('archiveProgress').textContent='Verificando lectura de recuperación…';job=await(await request('finish',{auth:true,id:job.id,body:{}})).json();}
 $('archiveProgress').textContent='Copia verificada. El archivo original permanece intacto.';await list();
 }catch(error){$('archiveProgress').textContent='No se completó la transferencia. Conserva el original y vuelve a intentarlo. '+error.message;}finally{$('archiveUpload').disabled=false;}
});
