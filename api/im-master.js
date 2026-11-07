import {DriveClient} from '../server/archive/drive-client.js';
import {ArchiveError, configuration} from '../server/archive/security.js';
import {syncIronMountainHistory} from '../server/im-history-sync.js';
import {authorize} from '../server/archive/repository.js';
import {
  readMasterRows, IM_MASTER_FILE_ID, IM_MASTER_PARENT_ID
} from '../server/im-master-workbook.js';

export const config = {maxDuration: 60};
const DRIVE = 'https://www.googleapis.com/drive/v3/files/';
const LIMIT = 10 * 1024 * 1024;
const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
};
const metadata = async client => {
  const fields = 'id,name,mimeType,size,parents,trashed,md5Checksum,modifiedTime';
  const response = await client.request(
    DRIVE + IM_MASTER_FILE_ID + '?fields=' + encodeURIComponent(fields) + '&supportsAllDrives=true');
  const file = await response.json();
  if (file.id !== IM_MASTER_FILE_ID || file.trashed ||
      !file.parents?.includes(IM_MASTER_PARENT_ID) ||
      !/^CARGOS_ENVIADOS_IRON_MOUNTAIN_MAESTRO\.(?:xlsm|xlsx)$/i.test(file.name) ||
      !['application/vnd.ms-excel.sheet.macroenabled.12',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(file.mimeType) ||
      Number(file.size) < 500 || Number(file.size) > LIMIT) {
    throw new ArchiveError('IM_MASTER_SOURCE_NOT_APPROVED', 409);
  }
  return file;
};
export function createImMasterHandler({env=process.env, fetcher=fetch}={}) {
  return async (req, res) => {
    try {
      if (req.method !== 'POST') throw new ArchiveError('METHOD_NOT_ALLOWED', 405);
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
        throw new ArchiveError('ORIGIN_DENIED', 403);
      if (req.body && JSON.stringify(req.body).length > 256)
        throw new ArchiveError('INVALID_REQUEST', 400);
      if (req.body?.action && req.body.action !== 'refresh')
        throw new ArchiveError('INVALID_ACTION', 400);
      await authorize(req, env, {admin:true, fetcher});
      if (!configuration(env).enabled) throw new ArchiveError('DRIVE_NOT_READY',503);
      const client = new DriveClient(env,{fetcher});
      await client.checkRoot();
      const before = await metadata(client);
      const media = await client.request(
        DRIVE + IM_MASTER_FILE_ID + '?alt=media&supportsAllDrives=true');
      const buffer = Buffer.from(await media.arrayBuffer());
      if (buffer.length !== Number(before.size)) throw new ArchiveError('IM_MASTER_SIZE_CHANGED',409);
      const rows = await readMasterRows(buffer);
      const after = await metadata(client);
      if (before.modifiedTime !== after.modifiedTime || before.md5Checksum !== after.md5Checksum ||
          before.size !== after.size) throw new ArchiveError('IM_MASTER_EDIT_IN_PROGRESS',409);

      // La preview consulta el Maestro pero nunca concilia ni modifica bases o Excel reales.
      if (env.VERCEL_ENV !== 'production') {
        return json(res,200,{
          ok:true,preview:true,source:'Excel Maestro de Iron Mountain',
          boxes:rows.length,
          sent:rows.filter(row=>row.envio).length,
          pending:rows.filter(row=>!row.envio).length,
          revision:after.modifiedTime,
          history:{status:'PREVIEW_SIN_ESCRITURA',verified:false,pending:false},
          message:'Preview en solo lectura: sin cambios en Maestro, Supabase ni Histórico IM.'
        });
      }

      const response = await fetcher(env.SUPABASE_URL+'/rest/v1/rpc/kardex_im_master_sync',{
        method:'POST',
        headers:{
          apikey:env.SUPABASE_ANON_KEY,
          Authorization:req.headers.authorization,
          'Content-Type':'application/json',
          Prefer:'return=representation',
        },
        body:JSON.stringify({p_file_id:IM_MASTER_FILE_ID,p_rows:rows}),
        signal:AbortSignal.timeout(20000),redirect:'error'
      });
      const result = await response.json().catch(()=>null);
      if (!response.ok) throw new ArchiveError('IM_MASTER_DB_SYNC_REJECTED',409);
      if (!result?.verificado) throw new ArchiveError('IM_MASTER_NOT_VERIFIED',503);
      let history;
      try {
        history=await syncIronMountainHistory({
          env,fetcher,client,bearer:req.headers.authorization,masterRows:rows
        });
      } catch {
        history={status:'PENDIENTE',pending:true,
          message:'El Maestro está sincronizado, pero el histórico no se pudo verificar. Se reintentará.'};
      }
      return json(res,200,{
        ok:true,source:'Excel Maestro de Iron Mountain',
        boxes:rows.length,
        sent:rows.filter(row=>row.envio).length,
        pending:rows.filter(row=>!row.envio).length,
        requestedPending:rows.filter(row=>!row.envio&&/por\s+solicitud/i.test(row.clasificacion)).length,
        revision:after.modifiedTime,
        history,
        result
      });
    } catch (error) {
      const known=error instanceof ArchiveError;
      const code=known?error.code:/^IM_MASTER_/.test(error?.message||'')?error.message:'IM_MASTER_UNAVAILABLE';
      return json(res,known?error.status:503,{
        ok:false,error:code,message:'No se pudo verificar el Excel Maestro. Se conservan los registros anteriores.'
      });
    }
  };
}
export default createImMasterHandler();
