import {createHash,timingSafeEqual} from 'node:crypto';
import {authorize} from '../server/archive/repository.js';
import {ArchiveError,configuration,isReceptionPreviewBranch} from '../server/archive/security.js';
import {appendReceivedBoxes} from '../server/reception-workbook.js';
import {appendPreparedBoxToMaster} from '../server/im-master-write.js';
import {DriveClient} from '../server/archive/drive-client.js';
import {readMasterDrive,writeMasterDrive,withMasterDriveLock,probeMasterDrive} from '../server/im-master-drive.js';

export const config={maxDuration:60};

const previewProject = 'https://qpbzfzcobkkfnoioqytb.supabase.co';
const liveProject = 'https://uhjwhamzjxhjqlrhgxho.supabase.co';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const limaDate = date => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima'}).format(new Date(date));

export function createBoxReceptionHandler({env=process.env,fetcher=fetch}={}) {
  return async (req,res) => {
    const json = (status,body) => {
      res.statusCode=status;
      res.setHeader('Content-Type','application/json; charset=utf-8');
      res.end(JSON.stringify(body));
    };
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    try {
      const live=env.VERCEL_ENV==='production' && env.SUPABASE_URL===liveProject &&
        /^[a-f0-9]{64}$/.test(env.KARDEX_RECEPCION_PROD_SECRET||'');
      const preview=env.VERCEL_ENV==='preview' && isReceptionPreviewBranch(env) &&
        env.SUPABASE_URL===previewProject && /^[a-f0-9]{64}$/.test(env.KARDEX_RECEPCION_PRUEBA_SECRET||'');
      if (!live&&!preview) throw new ArchiveError('RECEPCION_PRUEBA_NO_DISPONIBLE',403);
      if (req.method!=='POST') throw new ArchiveError('Método inválido',405);
      if (req.headers.origin && new URL(req.headers.origin).host!==req.headers.host)
        throw new ArchiveError('Origen no autorizado',403);
      const body = typeof req.body==='string' ? JSON.parse(req.body) : req.body;
      if (live && body?.action==='verificar') {
        const expires=Number(env.KARDEX_RECEPCION_PROBE_UNTIL);
        const proof=req.headers['x-kardex-probe'];
        if (!(expires>Date.now() && expires-Date.now()<=2*60*60*1000) ||
          typeof proof!=='string' || !/^[a-f0-9]{64}$/.test(proof) ||
          !timingSafeEqual(Buffer.from(proof),Buffer.from(env.KARDEX_RECEPCION_PROD_SECRET)))
          throw new ArchiveError('Operación no autorizada.',403);
        if (!configuration(env).enabled) throw new ArchiveError('La conexión a Drive aún no está habilitada.',503);
        const client=new DriveClient(env,{fetcher});
        await client.checkRoot();
        return json(200,await probeMasterDrive(client));
      }

      if (JSON.stringify(body??{}).length>300 || !['parcial','completa','acondicionar','descargar'].includes(body?.action) ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body?.id||''))
        throw new ArchiveError('Recepción inválida',400);
      await authorize(req,env,{admin:true,fetcher});
      const rpc = async (method,payload) => {
        const response = await fetcher(env.SUPABASE_URL+'/rest/v1/rpc/'+method,{
          method:'POST',
          headers:{apikey:env.SUPABASE_ANON_KEY,Authorization:req.headers.authorization,'Content-Type':'application/json'},
          body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(12000)
        });
        const result = await response.json();
        if (!response.ok) {
          const message = result.code==='40001' ? 'Otra sesión actualizó el Excel. Reintenta el guardado.' :
            result.code==='42501' ? 'Esta operación requiere la cuenta administradora de la solicitud.' :
              'El Excel no pudo confirmar la operación.';
          throw new ArchiveError(message,result.code==='42501'?403:409);
        }
        return result;
      };
      if (live) {
        if (!configuration(env).enabled) throw new ArchiveError('La conexión a Drive aún no está habilitada.',503);
        if (body.action==='acondicionar') throw new ArchiveError('Usa el módulo de acondicionamiento.',400);
        const client=new DriveClient(env,{fetcher});
        await client.checkRoot();
        const state=()=>rpc('kardex_recepcion_operacion',{p_accion:'estado',p_id:body.id,p_codigo:null});
        if (body.action==='descargar') {
          await state();
          const source=await readMasterDrive(client);
          res.statusCode=200;
          res.setHeader('Content-Type',source.file.mimeType);
          res.setHeader('Content-Disposition','attachment; filename="'+source.file.name+'"');
          return res.end(source.bytes);
        }
        const saved=await withMasterDriveLock(rpc,async token=>{
          const save=(action,revision=null,rows=null)=>rpc('kardex_recepcion_produccion_excel',{
            p_accion:action,p_id:body.id,p_secreto:env.KARDEX_RECEPCION_PROD_SECRET,
            p_token:token,p_revision:revision,p_filas:rows
          });
          const current=await save('estado');
          if (current.confirmada) return current;
          if (body.action==='completa' && current.lecturas.length!==current.cantidad)
            throw new ArchiveError('Escanea todas las cajas antes de confirmar la recepción.',409);
          if (!current.lecturas.length) throw new ArchiveError('Primero escanea al menos una caja.',409);
          const source=await readMasterDrive(client);
          const existing=new Map(source.rows.map(row=>[row.caja.replace(/[^0-9]/g,''),row]));
          const recovered={};
          const readings=current.lecturas.map(row=>{
            if(row.guardado) return row;
            const recorded=existing.get(row.clave);
            if(!recorded) return row;
            if(!recorded.receivedOnly || recorded.caja!==row.codigo)
              throw new ArchiveError('Una caja ya existe con otros datos en el Maestro. Revisa el código antes de guardar.',409);
            recovered[row.clave]=Number(recorded.numero);
            return {...row,guardado:true,correlativo:recovered[row.clave]};
          });
          const next=await appendReceivedBoxes(source.bytes,readings);
          const proof=Object.keys(next.added).length ? await writeMasterDrive(client,source,next.bytes) : source;
          return save(body.action,proof.file.headRevisionId,{...recovered,...next.added});
        });
        return json(200,saved);
      }
      const excel = (action,other={}) => rpc('kardex_recepcion_prueba_excel',{
        p_accion:action,p_id:body.id,p_secreto:env.KARDEX_RECEPCION_PRUEBA_SECRET,...other
      });
      const current = await excel('cargar');
      const bytes = Buffer.from(current.archivo,'base64');
      if (body.action==='descargar') {
        res.statusCode=200;
        res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition','attachment; filename="Maestro_Recepcion_Prueba.xlsx"');
        return res.end(bytes);
      }
      if (body.action==='acondicionar') {
        const received = current.lecturas.find(item=>item.clave===body.code && item.guardado);
        if (!received || !current.confirmada) throw new ArchiveError('Confirma primero la recepción de la solicitud.',409);
        const record = (await rpc('kardex_box_conditioning_list',{})).find(box=>box.code===received.clave);
        if (record?.status!=='LISTA' || record.classification!=='Cajas Nuevas')
          throw new ArchiveError('La caja debe estar lista y clasificada como Cajas Nuevas.',409);
        const updated = await appendPreparedBoxToMaster(bytes,record,{
          preparacion:limaDate(record.started_at),responsable:current.solicitante,minimumBoxes:1
        });
        if (updated.changed) await excel('acondicionar',{
          p_revision:current.revision,p_archivo:updated.bytes.toString('base64'),p_filas:{[received.clave]:received.correlativo}
        });
        return json(200,{verified:true,sourceSynced:true});
      }
      if (body.action==='completa' && current.lecturas.length!==current.cantidad)
        throw new ArchiveError('Escanea todas las cajas antes de confirmar la recepción.',409);
      if (!current.lecturas.length) throw new ArchiveError('Primero escanea al menos una caja.',409);
      const next = await appendReceivedBoxes(bytes,current.lecturas,{minimumBoxes:1});
      const added = Object.keys(next.added).length;
      const state = await excel(body.action,{
        p_revision:current.revision,p_filas:next.added,p_archivo:added?next.bytes.toString('base64'):null
      });
      const proof = await excel('cargar');
      const reread = Buffer.from(proof.archivo,'base64');
      if (proof.revision===current.revision+(added?1:0) && hash(reread)!==hash(next.bytes))
        throw new ArchiveError('El archivo guardado no coincide con la revisión verificada.',503);
      await appendReceivedBoxes(reread,state.lecturas.filter(item=>item.guardado),{minimumBoxes:1});
      return json(200,state);
    } catch (error) {
      return json(error instanceof ArchiveError?error.status:503,{
        error:error instanceof ArchiveError ? error.code : 'No se pudo verificar el Excel. El avance de escaneo sigue registrado.'
      });
    }
  };
}
export default createBoxReceptionHandler();
