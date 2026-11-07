import {createHash} from 'node:crypto';
import {authorize} from '../server/archive/repository.js';
import {ArchiveError,isReceptionPreviewBranch} from '../server/archive/security.js';
import {appendReceivedBoxes} from '../server/reception-workbook.js';
import {appendPreparedBoxToMaster} from '../server/im-master-write.js';

const previewProject = 'https://qpbzfzcobkkfnoioqytb.supabase.co';
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
      if (env.VERCEL_ENV!=='preview' || !isReceptionPreviewBranch(env) ||
          env.SUPABASE_URL!==previewProject || !/^[a-f0-9]{64}$/.test(env.KARDEX_RECEPCION_PRUEBA_SECRET||''))
        throw new ArchiveError('RECEPCION_PRUEBA_NO_DISPONIBLE',403);
      if (req.method!=='POST') throw new ArchiveError('Método inválido',405);
      if (req.headers.origin && new URL(req.headers.origin).host!==req.headers.host)
        throw new ArchiveError('Origen no autorizado',403);
      const body = typeof req.body==='string' ? JSON.parse(req.body) : req.body;
      if (JSON.stringify(body??{}).length>300 || !['parcial','completa','acondicionar','descargar'].includes(body?.action) ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body?.id||''))
        throw new ArchiveError('Recepción inválida',400);
      await authorize(req,env,{admin:true,fetcher});
      const rpc = async (method,payload) => {
        const response = await fetcher(previewProject+'/rest/v1/rpc/'+method,{
          method:'POST',
          headers:{apikey:env.SUPABASE_ANON_KEY,Authorization:req.headers.authorization,'Content-Type':'application/json'},
          body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(12000)
        });
        const result = await response.json();
        if (!response.ok) {
          const message = result.code==='40001' ? 'Otra sesión actualizó el Excel. Reintenta el guardado.' :
            result.code==='42501' ? 'Esta operación requiere la cuenta administradora de la solicitud.' :
              'El Excel de prueba no pudo confirmar la operación.';
          throw new ArchiveError(message,result.code==='42501'?403:409);
        }
        return result;
      };
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
        error:error instanceof ArchiveError ? error.code : 'No se pudo verificar el Excel de prueba. El avance de escaneo sigue registrado.'
      });
    }
  };
}
export default createBoxReceptionHandler();
