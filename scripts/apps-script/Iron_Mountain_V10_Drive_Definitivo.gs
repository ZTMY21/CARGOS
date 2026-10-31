/** Iron Mountain V10. Parser V6 conservado; acceso solo por Edge Function.
 * No necesita ni lee service_role. El secreto permanece en ScriptProperties.
 * Preparar e instalar en la copia definitiva antes de activar.
 */
const IM_V4 = Object.freeze({
  spreadsheetId: '1VWmKFmE8UcXV6ukG8k-wqKqCzuJbPGYOf9RFowojhSw',
  sheet: 'CARGOS ENVIADOS',
  info: 'INSTRUCCIONES',
  url: 'https://uhjwhamzjxhjqlrhgxho.supabase.co',
  timezone: 'America/Lima',
  maxRows: 1200,
  version: 'V10 — Drive definitivo / Clasificación F / Envío G',
});



/** Diagnóstico sin ejecutar altas ni bajas. Úsalo antes de probar. */
function diagnosticarIronMountain() {
  const props=PropertiesService.getScriptProperties(),data=leerFilasIronMountain_();
  return {version:IM_V4.version,filas:data.length,cargos:data.reduce((n,r)=>n+r.cargos.length,0),secretoConfigurado:Boolean(props.getProperty('IM_SYNC_SECRET')),fuenteActivada:props.getProperty('KARDEX_SOURCE_ACTIVATED')==='true',activadores:ScriptApp.getProjectTriggers().map(t=>({funcion:t.getHandlerFunction(),tipo:String(t.getEventType())}))};
}

/** Previsualiza el contenido exacto que se sincronizaría, sin enviarlo. */
function revisarDatosIronMountain() {
  const rows = leerFilasIronMountain_();
  const estado = {filas:rows.length,cargos:rows.reduce((n,r)=>n+r.cargos.length,0),
    porSolicitud:rows.filter(r=>/por\s+solicitud/i.test(r.clasificacion)).length,
    sinFechaEnvio:rows.filter(r=>!r.envio).length};
  console.log('REVISIÓN SIN GUARDAR: '+JSON.stringify(estado));
  escribirEstadoIronMountain_('REVISIÓN V6 — SIN CAMBIAR SUPABASE',JSON.stringify(estado));
  return estado;
}

/** Guarda el contenido actual de la hoja, incluyendo bajas por filas borradas. */
function sincronizarIronMountain(evento) {
  if(PropertiesService.getScriptProperties().getProperty('KARDEX_SOURCE_ACTIVATED')!=='true')return {estado:'FUENTE_PREPARADA_NO_ACTIVA',verificado:false};
  if(evento && evento.range && evento.range.getSheet().getName()!==IM_V4.sheet){return;}
  const lock = LockService.getScriptLock();
  if(!lock.tryLock(15000))return {estado:'EN ESPERA',detalle:'Hay otra sincronización en curso'};
  try {
    const filas = leerFilasIronMountain_();
    const cred = credencialesIronMountain_();
    const endpoint = IM_V4.url+'/functions/v1/im-envios-live';
    const headers = {'X-IM-Token':cred.secreto};
    const response=UrlFetchApp.fetch(endpoint,{
      method:'post',contentType:'application/json',headers,
      payload:JSON.stringify({sheet_id:IM_V4.spreadsheetId,rows:filas}),
      muteHttpExceptions:true,followRedirects:false
    });
    const status=response.getResponseCode();
    const cuerpo=response.getContentText();
    let result;
    try {result=JSON.parse(cuerpo);}catch(e){throw new Error('Respuesta no JSON: HTTP '+status+'. Revisa conexión y dirección del proyecto.');}
    if(status<200||status>=300){
      const msg=typeof result.message==='string'?result.message:(result.error_description||result.error||'Acceso denegado');
      const detail=result.details?(' — '+result.details):'';
      throw new Error('Supabase HTTP '+status+': '+msg+detail);
    }
    if(!result || result.verificado!==true){throw new Error('Supabase no confirmó el guardado; no se marcará CORRECTO.');}
    const detalle='Hoja: '+filas.length+' filas / '+filas.reduce((n,r)=>n+r.cargos.length,0)+' cargos · '+
      'Estado: '+result.estado+' · Enviados: '+result.enviados+' · Preparados: '+result.preparados+
      ' · Eliminados: '+(result.eliminados||0);
    escribirEstadoIronMountain_('CORRECTO V6 — '+result.estado,detalle);
    console.log('Sincronización confirmada por Supabase: '+JSON.stringify(result));
    return result;
  }catch(error){
    const msg=String(error&&error.message||error);
    escribirEstadoIronMountain_('ERROR V6 — SIN REGISTRAR',msg.substring(0,400));
    console.error('ERROR IM V6: '+msg);
    throw error;
  }finally{lock.releaseLock();}
}

/** Reinstala SOLO los activadores de este proyecto.
 * IMPORTANTE: el proyecto debe ser el mismo que usaba el control V2;
 * los activadores de OTROS proyectos no pueden eliminarse desde aquí.
 */
function instalarTiempoReal() {
  prepararFuenteIMV10();
  credencialesIronMountain_();
  leerFilasIronMountain_();
  const libro=SpreadsheetApp.openById(IM_V4.spreadsheetId);
  const anteriores=ScriptApp.getProjectTriggers();
  const funcionesAnteriores=anteriores.map(t=>t.getHandlerFunction());
  // Se eliminan únicamente activadores de envío IM identificables.
  // Otros procesos del mismo proyecto (por ejemplo, CARGOS ACTUALES)
  // deben mantenerse intactos.
  const esIM = function(name){
    return ['sincronizarIronMountain','imSincronizarEdicion',
      'imSincronizarEstructura','imVerificarPendientes'].includes(name) ||
      /(?:iron.?mountain|envios.?im|im.?envios|sync.?im|sincronizar.?im)/i.test(name);
  };
  const pendientes = anteriores.filter(t=>!esIM(t.getHandlerFunction()));
  anteriores.filter(t=>esIM(t.getHandlerFunction())).forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sincronizarIronMountain').forSpreadsheet(libro).onEdit().create();
  ScriptApp.newTrigger('sincronizarIronMountain').forSpreadsheet(libro).onChange().create();
  ScriptApp.newTrigger('sincronizarIronMountain').timeBased().everyMinutes(1).create();
  escribirEstadoIronMountain_('V6 INSTALADO — PENDIENTE DE PRUEBA',
    'Activadores anteriores detectados: '+funcionesAnteriores.join(', ')+
    '. No se tocaron procesos ajenos a IM. Pendientes de revisión: '+pendientes.map(t=>t.getHandlerFunction()).join(', ')+
    '. Ejecuta sincronizarIronMountain y revisa los cargos.');
  console.log('Instalación V6 completada. Activadores conservados: '+pendientes.map(t=>t.getHandlerFunction()).join(', ')+'. Los de OTROS proyectos deben revisarse manualmente.');
  return 'INSTALADO V6. Ejecuta sincronizarIronMountain una vez y verifica CORRECTO V6.';
}

/** Deshabilita únicamente los activadores de este sincronizador V4. */
function detenerTiempoReal() {
  ScriptApp.getProjectTriggers().forEach(t=>{
    if(t.getHandlerFunction()==='sincronizarIronMountain')ScriptApp.deleteTrigger(t);
  });
  return 'Detenido V6';
}

function leerFilasIronMountain_() {
  const hoja=SpreadsheetApp.openById(IM_V4.spreadsheetId).getSheetByName(IM_V4.sheet);
  if(!hoja)throw new Error('No encuentro la pestaña «'+IM_V4.sheet+'».');
  const hs=hoja.getRange('D1:G1').getDisplayValues()[0].map(s=>String(s).normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').toUpperCase());
  if(!hs[0].includes('CODIGO DE BARRAS')||!hs[1].includes('CARGOS')||
    !hs[2].includes('CLASIFICACION DE')||!hs[3].includes('FECHA DE ENVIO')){
      throw new Error('Cabeceras incorrectas. D=caja, E=cargos, F=clasificación, G=fecha de envío.');
  }
  const end=hoja.getLastRow();
  if(end<2)return [];
  const raw=hoja.getRange(2,1,end-1,10).getValues();
  const text=hoja.getRange(2,1,end-1,10).getDisplayValues();
  const rows=[];
  for(let i=0;i<raw.length;i++){
    const display=text[i],r=raw[i],sheetRow=i+2;
    const caja=String(display[3]||'').trim();
    const cargoCell=String(display[4]||'').trim();
    // El número correlativo (A) y otros datos pueden quedar sin limpiar.
    // Si D y E están vacíos, esa caja ya fue retirada y debe darse de baja.
    if(!caja&&!cargoCell)continue;
    if(!caja||!cargoCell)throw new Error('Fila '+sheetRow+': faltan D (caja) o E (cargos). No se sincronizó ninguna fila.');
    if(caja.length>100||cargoCell.length>450)throw new Error('Fila '+sheetRow+': caja o lista de cargos demasiado larga.');
    const cargos=separarCargosIronMountain_(cargoCell,sheetRow);
    rows.push({
      row:sheetRow,
      numero:String(display[0]||'').trim(),
      preparacion:convertirFechaIronMountain_(r[1],display[1],sheetRow,'B'),
      responsable:String(display[2]||'').trim(),
      caja,
      celda:cargoCell,
      cargos,
      clasificacion:String(display[5]||'').trim(),
      envio:convertirFechaIronMountain_(r[6],display[6],sheetRow,'G'),
      entrega:String(display[7]||'').trim(),
      recibe:String(display[8]||'').trim(),
      placa:String(display[9]||'').trim()
    });
    if(rows.length>IM_V4.maxRows)throw new Error('Más de '+IM_V4.maxRows+' cajas. No se envió nada.');
  }
  return rows;
}

function separarCargosIronMountain_(input,row) {
  let source=String(input||'').toUpperCase().replace(/[\u00A0]/g,' ').trim();
  const grupoA=/\(\s*A\s*\)$/.test(source)&&/[\-\u2010-\u2015,;\/\n]/.test(source);
  if(grupoA)source=source.replace(/\s*\(\s*A\s*\)$/,'');
  const tokens=source.split(/\s*[-\u2010-\u2015,;\/\n]\s*/);
  if(tokens.some(t=>!t.trim()))throw new Error('Fila '+row+': hay un separador de cargos sin número.');
  const result=[];
  tokens.forEach(t=>{
    const part=t.trim();
    const match=part.match(/^(\d{1,7})\s*(?:\(?A\)?)?$/);
    if(!match)throw new Error('Fila '+row+': cargo inválido «'+part.slice(0,30)+'».');
    const suffix=grupoA||/A\s*\)?$/.test(part);
    const val=String(Number(match[1]))+(suffix?'A':'');
    if(!result.includes(val))result.push(val);
  });
  if(result.length<1||result.length>60)throw new Error('Fila '+row+': se permiten de 1 a 60 cargos por caja.');
  return result;
}

function convertirFechaIronMountain_(value,visible,row,column) {
  if((value===''||value===null||value===undefined)&&!String(visible||'').trim())return '';
  if(value instanceof Date && !isNaN(value.getTime()))return Utilities.formatDate(value,IM_V4.timezone,'yyyy-MM-dd');
  const str=String(visible||value||'').trim();
  if(!str)return '';
  if(/^20\d{2}-\d{2}-\d{2}$/.test(str))return comprobarFecha_(str,row,column);
  const m=str.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})$/);
  if(!m)throw new Error('Fila '+row+': la fecha de '+column+' no es válida: '+str);
  return comprobarFecha_(m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0'),row,column);
}
function comprobarFecha_(iso,row,col){
  const [y,m,d]=iso.split('-').map(Number);
  const z=new Date(Date.UTC(y,m-1,d));
  if(z.toISOString().slice(0,10)!==iso)throw new Error('Fila '+row+': fecha imposible en '+col+'.');
  return iso;
}
function credencialesIronMountain_(){
  const secret=PropertiesService.getScriptProperties().getProperty('IM_SYNC_SECRET');
  if(!secret||secret.length<40)throw new Error('Preparar la fuente V10 antes de sincronizar.');
  return {secreto:secret};
}
function escribirEstadoIronMountain_(status,detalle){
  try{
    const s=SpreadsheetApp.openById(IM_V4.spreadsheetId).getSheetByName(IM_V4.info);
    if(!s)return;
    s.getRange('A2:D2').setValues([[
      status,Utilities.formatDate(new Date(),IM_V4.timezone,'dd/MM/yyyy HH:mm:ss'),
      String(detalle||'').slice(0,1500),IM_V4.version
    ]]);
  }catch(e){console.error('No se pudo escribir el panel de estado: '+String(e));}
}
/** Registra únicamente una fuente INACTIVA, sin exponer su secreto. */
function prepararFuenteIMV10() {
  const expected='1VWmKFmE8UcXV6ukG8k-wqKqCzuJbPGYOf9RFowojhSw',owner='jaguliquidacion@gmail.com';
  const active=SpreadsheetApp.getActiveSpreadsheet();
  if(!active||active.getId()!==expected)throw new Error('Proyecto o hoja de preparación incorrectos.');
  if(Session.getEffectiveUser().getEmail().toLowerCase()!==owner)throw new Error('Preparar desde la cuenta propietaria del Drive definitivo.');
  const props=PropertiesService.getScriptProperties();
  let secret=props.getProperty('IM_SYNC_SECRET');
  if(!secret||secret.length<40){secret=(Utilities.getUuid()+Utilities.getUuid()).replace(/-/g,'');props.setProperty('IM_SYNC_SECRET',secret);}
  const hex=value=>Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value,Utilities.Charset.UTF_8).map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join('');
  const sheet=active.getSheetByName('CARGOS ENVIADOS');if(!sheet)throw new Error('Pestaña operativa no encontrada.');
  const rows=sheet.getRange(1,1,Math.max(1,sheet.getLastRow()),10).getDisplayValues();
  while(rows.length&&rows[rows.length-1].every(v=>v===''))rows.pop();
  const input={kind:'im',sheet_id:expected,token_sha256:hex(secret),build_id:'IM_V10_20261031',display_rows:rows.length,display_sha256:hex(JSON.stringify(rows))};
  const response=UrlFetchApp.fetch('https://uhjwhamzjxhjqlrhgxho.supabase.co/functions/v1/kardex-source-enroll',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},payload:JSON.stringify(input),muteHttpExceptions:true,followRedirects:false});
  let result;try{result=JSON.parse(response.getContentText());}catch(_){throw new Error('No se confirmó la preparación de la fuente.');}
  if(response.getResponseCode()!==200||result.enrolled!==true)throw new Error('Preparación rechazada. No activar ni limpiar filas.');
  if(!result.active)props.setProperty('KARDEX_SOURCE_ACTIVATED','false');
  return {prepared:true,active:result.active,build:input.build_id,rows:rows.length,sha256:input.display_sha256};
}
function activarIronMountainVerificado() {
  const response=UrlFetchApp.fetch(IM_V4.url+'/functions/v1/im-envios-live',{method:'post',contentType:'application/json',headers:{'X-IM-Token':credencialesIronMountain_().secreto},payload:JSON.stringify({sheet_id:IM_V4.spreadsheetId,mode:'probe'}),muteHttpExceptions:true,followRedirects:false});if(response.getResponseCode()!==200)throw new Error('No se pudo verificar la fuente IM.');const reply=JSON.parse(response.getContentText());
  if(reply.activa!==true||reply.sheet_id!=='1VWmKFmE8UcXV6ukG8k-wqKqCzuJbPGYOf9RFowojhSw')throw new Error('La fuente aún no está activa en Supabase. No se modificaron filas.');
  PropertiesService.getScriptProperties().setProperty('KARDEX_SOURCE_ACTIVATED','true');
  return sincronizarIronMountain();
}
