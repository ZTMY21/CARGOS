/**
 * KARDEX DIGITAL SANTA ANITA - CARGOS NUEVOS / V10 — CONFIRMACIÓN REAL Y RESPALDO SEGURO
 * Sincronizacion por lotes, sin limite de 1200 filas por cargo.
 * Instalar solo en la COPIA definitiva del Drive jaguliquidacion; conserva identidades históricas.
 * NO borrar la propiedad secreta CARGOS_WEBHOOK_TOKEN.
 *
 * SEGURIDAD: no elimina una factura repetida en otro cargo. Los grupos se conservan.
 * Archivo: limpieza todos los dias desde las 20:00 (America/Lima),
 * un cargo completo cada 5 minutos. Espera 20 min tras ultima edicion.
 * Se retiran filas SOLO si el CSV y el Kardex estan verificados;
 * CSV en Google Drive -> comprobacion exacta en Supabase -> retiro de filas de Sheets.
 * Si falla cualquiera de esos pasos, el cargo permanece en Google Sheets.
 * Los documentos en la base de datos JAMAS se borran al archivar.
 *
 * Requiere receptor Supabase cargos-nuevos-onedit v4 y RPC kardex_live_archive.
 * InstalarTiempoReal deshabilita también el antiguo disparador KL20 para
 * evitar dos rutinas de borrado simultáneas. No elimina el código anterior.
 * La revisión de bajas no elimina datos, incluso cuando falta un cargo entero.
 * La baja de filas no elimina facturas de la base: genera alerta de revisión.
 * El archivado guarda también las 14 columnas originales antes de borrar Sheets.
 */
const CARGOS_CONFIG = Object.freeze({
  SHEET_ID: '14GzTxs9-hk3_vPTI7AYLc3jiqLAaAC5q7y910wo8Jh0',
  TAB: 'CARGOS NUEVOS',
  ENDPOINT: 'https://uhjwhamzjxhjqlrhgxho.supabase.co/functions/v1/cargos-nuevos-onedit',
  BATCH: 10,
  MAX_ROWS_PER_RUN: 160,
  WINDOW: 1200,
  MAX_RUNTIME_MS: 145000,
  ARCHIVE_START_HOUR: 20,
  ARCHIVE_END_HOUR: 24,
  ARCHIVE_QUIET_MINUTES: 20,
  MAX_ARCHIVE_ROWS: 15000,
  ARCHIVE_FOLDER_ID: '18RofV-0-GjZJxuCAYJhC6IVjeMHiRgyN',
  ARCHIVE_FOLDER: 'KARDEX - RESPALDO CSV CARGOS NUEVOS'
});
function libroCargos_() {
  const libro = SpreadsheetApp.openById(CARGOS_CONFIG.SHEET_ID);
  const hoja = libro.getSheetByName(CARGOS_CONFIG.TAB);
  if (!hoja) throw new Error('No se encuentra la pestaña CARGOS NUEVOS.');
  return { libro, hoja };
}
function tokenCargos_() {
  const key = PropertiesService.getScriptProperties().getProperty('CARGOS_WEBHOOK_TOKEN');
  if (!key || key.length < 30) throw new Error('No se encontro CARGOS_WEBHOOK_TOKEN del proyecto original.');
  return key;
}
function fechaCargos_(v) {
  if (v instanceof Date && !isNaN(v.getTime()))
    return Utilities.formatDate(v, 'America/Lima', 'yyyy-MM-dd');
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/);
  return m ? m[3] + '-' + m[2] + '-' + m[1] : (/^20\d\d-\d\d-\d\d$/.test(s) ? s : '');
}
function horaLima_() {
  return Utilities.formatDate(new Date(), 'America/Lima', 'dd/MM/yyyy HH:mm:ss');
}
function registrarEstado_(libro, status, info) {
  try {
    const h = libro.getSheetByName('INSTRUCCIONES');
    if (!h) return;
    h.getRange('D1:E2').setValues([
      ['ULTIMA SINCRONIZACION', 'HORA (LIMA)'],
      [status, horaLima_()]
    ]);
    h.getRange('D3').setValue(String(info || '').slice(0, 480));
  } catch (_) { /* no bloquear cargas por diagnosticador */ }
}
/** Panel fijo en INSTRUCCIONES. No crece con los cargos. */
function prepararPanelLimpieza_(libro) {
  const panel = libro.getSheetByName('INSTRUCCIONES');
  if (!panel) return;
  panel.getRange('D6:E6').setValues([['ULTIMA LIMPIEZA DE CARGOS', 'FECHA Y HORA (LIMA)']]);
  if (!String(panel.getRange('D7').getDisplayValue() || '').trim()) {
    panel.getRange('D7:E7').setValues([[
      'Pendiente: limpieza diaria desde las 20:00. Cargos sin verificar se conservan.',
      'SIN EJECUTAR'
    ]]);
  }
}
/** No declarar como archivado antes de retirar las filas. */
function registrarLimpiezaConfirmada_(libro, anio, cargo, filas, codigos) {
  const panel = libro.getSheetByName('INSTRUCCIONES');
  if (!panel) return;
  panel.getRange('D7:E7').setValues([[
    'Guardado hasta el cargo ' + cargo + ' (' + anio + ') en la base de datos. ' +
      'CSV respaldado; ' + filas + ' filas retiradas y ' + codigos + ' codigos verificados.',
    horaLima_()
  ]]);
}
/** Trigger de 5 min: desde 20:00 hasta fin del dia, hora de Lima. */
function dentroHorarioLimpieza_() {
  const h = Number(Utilities.formatDate(new Date(), 'America/Lima', 'HH'));
  return h >= CARGOS_CONFIG.ARCHIVE_START_HOUR && h < CARGOS_CONFIG.ARCHIVE_END_HOUR;
}
/** Protege una carga activa por al menos 20 min desde la ultima edicion. */
function cargaEnCurso_() {
  const ms = Number(PropertiesService.getScriptProperties()
    .getProperty('CARGOS_ULTIMA_EDICION_V8') || 0);
  return ms > 0 && Date.now() - ms < CARGOS_CONFIG.ARCHIVE_QUIET_MINUTES * 60000;
}

function llamarSupabase_(body) {
  const res = UrlFetchApp.fetch(CARGOS_CONFIG.ENDPOINT, {
    method: 'post', contentType: 'application/json',
    headers: { 'X-Cargos-Token': tokenCargos_() },
    payload: JSON.stringify(Object.assign({sheet_id: CARGOS_CONFIG.SHEET_ID}, body)),
    muteHttpExceptions: true
  });
  let json = {};
  const raw = res.getContentText();
  try { json = JSON.parse(raw); } catch (_) {}
  if (res.getResponseCode() !== 200) {
    const err = new Error('Supabase ' + res.getResponseCode() + ': ' +
      String(json.detalle || json.error || raw).slice(0, 280));
    err.retryable = [422, 429, 500, 502, 503, 504].includes(res.getResponseCode());
    throw err;
  }
  return json;
}
function enviarConReduccion_(entries, deadline) {
  try { return [{ entries, response: llamarSupabase_({mode: 'ingest', rows: entries}) }]; }
  catch (e) {
    if (!e.retryable || entries.length < 2 || Date.now() > deadline - 26000) throw e;
    const mid = Math.ceil(entries.length / 2);
    return enviarConReduccion_(entries.slice(0, mid), deadline)
      .concat(enviarConReduccion_(entries.slice(mid), deadline));
  }
}
function cursor_(last) {
  const raw = Number(PropertiesService.getScriptProperties().getProperty('CARGOS_CURSOR_V6') || 2);
  return raw >= 2 && raw <= last ? raw : 2;
}
function guardarCursor_(row) {
  PropertiesService.getScriptProperties().setProperty('CARGOS_CURSOR_V6', String(Math.max(2, row)));
}
/** Lee SOLO una ventana de 1.200 filas, no todo el historico cada minuto. */
function registrosPendientes_(hoja) {
  if (hoja.getRange('A1:D1').getDisplayValues()[0].join('|') !== 'Fecha|Cargo|Grupo|Codigo')
    throw new Error('Los encabezados A:D cambiaron; sincronizacion protegida.');
  const last = hoja.getLastRow();
  if (last < 2) return {pending: [], incomplete: [], next: 2, last};
  const start = cursor_(last);
  const end = Math.min(last, start + CARGOS_CONFIG.WINDOW - 1);
  const n = end - start + 1;
  const raw = hoja.getRange(start, 1, n, 4).getValues();
  const shown = hoja.getRange(start, 1, n, 4).getDisplayValues();
  const status = hoja.getRange(start, 12, n, 1).getDisplayValues();
  const pending = [], incomplete = [];
  for (let i = 0; i < n; i++) {
    const estado = String(status[i][0] || '').trim().toUpperCase();
    // CAMBIO PENDIENTE sí debe viajar al servidor, que lo concilia sin sobrescribir otra factura.
    if (['REGISTRADO','YA REGISTRADO','REVISAR'].includes(estado)) continue;
    const vals = shown[i];
    if (vals.every(v => !String(v || '').trim())) continue;
    const fecha = fechaCargos_(raw[i][0]);
    const cargo = String(vals[1] || '').trim().replace(/\.0$/, '');
    const grupo = String(vals[2] || '').trim().replace(/\.0$/, '');
    const codigo = String(vals[3] || '').trim();
    if (!fecha || !cargo || !codigo) { incomplete.push(start + i); continue; }
    pending.push({row: start + i, fecha, cargo, grupo, codigo});
    if (pending.length === CARGOS_CONFIG.MAX_ROWS_PER_RUN) break;
  }
  const next = pending.length >= CARGOS_CONFIG.MAX_ROWS_PER_RUN ?
    pending[pending.length - 1].row + 1 : (end + 1 > last ? 2 : end + 1);
  return {pending, incomplete, next, last};
}
function guardarResultados_(hoja, entries, response) {
  const indexed = new Map((response.resultados || []).map(x => [Number(x.row), x]));
  const now = horaLima_();
  let committed = 0;
  let group = [], begin = 0, previous = -1;
  const flush = () => {
    if (!group.length) return;
    hoja.getRange(begin, 12, group.length, 3).setValues(group);
    group = [];
  };
  for (const entry of entries) {
    const r = indexed.get(entry.row);
    if (!r) { flush(); previous = -1; continue; }
    if (previous + 1 !== entry.row) flush();
    if (!group.length) begin = entry.row;
    group.push([String(r.estado || 'REVISAR'), String(r.detalle || ''), now]);
    previous = entry.row;
    committed++;
  }
  flush();
  return committed;
}
function sincronizarCargosPeriodico() {
  if (PropertiesService.getScriptProperties().getProperty('KARDEX_SOURCE_ACTIVATED') !== 'true') return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  let libro;
  try {
    const deadline = Date.now() + CARGOS_CONFIG.MAX_RUNTIME_MS;
    const info = libroCargos_(); libro = info.libro;
    tokenCargos_();
    const {pending, incomplete, next, last} = registrosPendientes_(info.hoja);
    if (!pending.length) {
      guardarCursor_(next);
      if (incomplete.length)
        registrarEstado_(libro, 'FILAS INCOMPLETAS', 'Completar filas: ' + incomplete.slice(0, 10).join(', '));
      else registrarEstado_(libro, 'SIN PENDIENTES EN LA VENTANA',
        'Se sigue revisando por ventanas. Ultima fila examinada: ' + (next === 2 ? last : next - 1));
      return;
    }
    let sent = 0, ok = 0, review = 0;
    let lastSent = 0;
    for (let i = 0; i < pending.length; i += CARGOS_CONFIG.BATCH) {
      if (Date.now() > deadline - 22000) break;
      const batch = pending.slice(i, i + CARGOS_CONFIG.BATCH);
      for (const result of enviarConReduccion_(batch, deadline)) {
        guardarResultados_(info.hoja, result.entries, result.response);
        sent += result.entries.length;
        lastSent = result.entries[result.entries.length - 1].row;
        ok += Number(result.response.nuevos || 0) + Number(result.response.actualizados || 0) + Number(result.response.duplicados || 0);
        review += Number(result.response.pendientes || 0);
      }
      guardarCursor_(lastSent + 1);
    }
    if (sent === pending.length) guardarCursor_(next);
    registrarEstado_(libro, review ? 'REVISAR REGISTROS' : 'ALTAS RECIBIDAS EN KARDEX',
      'Enviados: ' + sent + ', aceptados: ' + ok + ', pendientes de revisar: ' + review +
      '. Se continuara leyendo las filas siguientes en la proxima ejecucion.');
  } catch (e) {
    if (libro) registrarEstado_(libro, 'ERROR DE SINCRONIZACION', String(e.message || e));
    throw e;
  } finally { lock.releaseLock(); }
}
function alEditarCargos(e) {
  if (PropertiesService.getScriptProperties().getProperty('KARDEX_SOURCE_ACTIVATED') !== 'true') return;
  if (!e || !e.range || e.range.getSheet().getName() !== CARGOS_CONFIG.TAB) return;
  if (e.range.getLastRow() < 2 || e.range.getColumn() > 4) return;
  PropertiesService.getScriptProperties().setProperty('CARGOS_ULTIMA_EDICION_V8', String(Date.now()));
  const hoja = e.range.getSheet();
  const begin = Math.max(2, e.range.getRow());
  const last = e.range.getLastRow();
  const stat = hoja.getRange(begin, 12, last - begin + 1, 1).getDisplayValues();
  const now = horaLima_();
  for (let i = 0; i < stat.length; i++) {
    const previous = String(stat[i][0] || '').trim().toUpperCase();
    if (['REGISTRADO','YA REGISTRADO'].includes(previous))
      hoja.getRange(begin + i, 12, 1, 3).setValues([[
        'CAMBIO PENDIENTE', 'Edición pendiente: Supabase verificará el cargo y código.', now
      ]]);
    else if (previous === 'REVISAR')
      hoja.getRange(begin + i, 12, 1, 3).setValues([[
        '', 'Fila corregida: reintentar sincronización con Supabase.', now
      ]]);
  }
  const prop = PropertiesService.getScriptProperties();
  const cursor = Number(prop.getProperty('CARGOS_CURSOR_V6') || 2);
  prop.setProperty('CARGOS_CURSOR_V6', String(Math.min(begin, Math.max(2, cursor))));
  sincronizarCargosPeriodico();
}
function alEliminarFilas(e) {
  if (PropertiesService.getScriptProperties().getProperty('KARDEX_SOURCE_ACTIVATED') !== 'true') return;
  if (!e || !['REMOVE_ROW','INSERT_ROW'].includes(e.changeType)) return;
  PropertiesService.getScriptProperties().setProperty('CARGOS_ULTIMA_EDICION_V8', String(Date.now()));
  guardarCursor_(2);
  // NUNCA se borran documentos de Supabase al eliminar filas de Google Sheets.
}
function reenviarFilaSeleccionada() {
  const {hoja} = libroCargos_();
  const selected = hoja.getActiveRange();
  if (!selected || selected.getRow() < 2) throw new Error('Selecciona una fila de datos.');
  const row = selected.getRow();
  const status = String(hoja.getRange(row, 12).getDisplayValue() || '').toUpperCase();
  if (['REGISTRADO','YA REGISTRADO','CAMBIO PENDIENTE'].includes(status))
    throw new Error('Fila ya registrada/modificada. Evita duplicarla: requiere conciliacion administrativa.');
  hoja.getRange(row, 12, 1, 3).clearContent();
  guardarCursor_(row);
  sincronizarCargosPeriodico();
}
function horaParseada_(s) {
  try { return Utilities.parseDate(String(s || ''), 'America/Lima', 'dd/MM/yyyy HH:mm:ss').getTime(); }
  catch (_) { return NaN; }
}
function csvCampo_(value) {
  let s = String(value == null ? '' : value);
  if (/^[=+@\-\t\r]/.test(s)) s = "'" + s; // previene CSV injection en Excel
  return '"' + s.replace(/"/g, '""') + '"';
}
function carpetaArchivo_() {
  return DriveApp.getFolderById(CARGOS_CONFIG.ARCHIVE_FOLDER_ID);
}
/**
 * Desde las 20:00, archiva UN cargo completo empezando por las primeras filas.
 * Los siguientes cargos se atienden en turnos de 5 minutos.
 * CSV en Drive primero. El servidor compara TODOS los codigos con el Kardex.
 * Solo despues de esa validacion elimina las filas del Google Sheets transitorio.
 * Mantiene intactos documentos, facturas, boletas y guias de Supabase.
 */
function archivarCargosDiarios() {
  if (PropertiesService.getScriptProperties().getProperty('KARDEX_SOURCE_ACTIVATED') !== 'true') return;
  if (!dentroHorarioLimpieza_() || cargaEnCurso_()) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  let libro;
  try {
    const info = libroCargos_(); libro = info.libro;
    const hoja = info.hoja;
    const last = hoja.getLastRow();
    if (last < 2) return;
    const head = hoja.getRange(2, 1, 1, 14).getDisplayValues()[0];
    const fecha = fechaCargos_(head[0]);
    const cargo = String(head[1] || '').trim();
    if (!fecha || !/^\d{1,7}A?$/.test(cargo)) return;
    const year = Number(fecha.slice(0, 4));
    const hoyLima = Utilities.formatDate(new Date(), 'America/Lima', 'yyyy-MM-dd');
    if (fecha > hoyLima) return; // jamas archivar cargos con fecha futura
    const cutoffConfirmacion = Date.now() - CARGOS_CONFIG.ARCHIVE_QUIET_MINUTES * 60000;
    // Recoger el mismo cargo aunque las filas de un grupo estén intercaladas.
    // El respaldo guarda el número original de fila y no mezcla otros cargos.
    if (last - 1 > 50000) {
      registrarEstado_(libro, 'ARCHIVO PENDIENTE: HOJA EXTENSA',
        'Más de 50.000 filas: revisar antes de intentar la limpieza segura.');
      return;
    }
    const sheetRows = hoja.getRange(2, 1, last - 1, 14).getDisplayValues();
    const selectedIndices = [];
    const all = [];
    for (let i = 0; i < sheetRows.length; i++) {
      const r = sheetRows[i];
      const rowYear = Number(fechaCargos_(r[0]).slice(0, 4));
      if (rowYear === year && String(r[1] || '').trim() === cargo) {
        selectedIndices.push(i + 2);
        all.push(r);
      }
    }
    const n = all.length;
    if (!n || n > CARGOS_CONFIG.MAX_ARCHIVE_ROWS) {
      registrarEstado_(libro, 'ARCHIVO PENDIENTE: CARGO EXTENSO',
        'Cargo ' + cargo + ': supera límite seguro o carece de filas.');
      return;
    }
    // No borrar un cargo parcialmente si quedan filas con fecha inválida.
    if (sheetRows.some(r => String(r[1] || '').trim() === cargo &&
        !fechaCargos_(r[0]))) {
      registrarEstado_(libro, 'ARCHIVO POSPUESTO: FECHA INVÁLIDA',
        'Cargo ' + cargo + ': hay filas sin fecha legible que deben revisarse.');
      return;
    }
    const codeMap = new Set();
    for (const r of all) {
      if (!['REGISTRADO','YA REGISTRADO'].includes(String(r[11] || '').trim().toUpperCase())) return;
      const confirmed = horaParseada_(r[13]);
      if (!Number.isFinite(confirmed) || confirmed >= cutoffConfirmacion) return;
      if (fechaCargos_(r[0]) !== fecha || String(r[1]).trim() !== cargo || !r[3]) return;
      codeMap.add(String(r[3]).trim());
    }
    if (codeMap.size === 0) return;
    const headers = hoja.getRange(1, 1, 1, 14).getDisplayValues()[0];
    const content = '\uFEFF' + [headers].concat(all).map(r => r.map(csvCampo_).join(',')).join('\r\n');
    const fileName = 'CARGO_' + year + '_' + cargo + '_' + fecha + '_' +
      Utilities.formatDate(new Date(),'America/Lima','yyyyMMdd_HHmmss') + '_RESPALDO.csv';
    const folder = carpetaArchivo_();
    const file = folder.createFile(Utilities.newBlob(content, 'text/csv', fileName));
    if (file.getSize() === 0) throw new Error('No fue posible confirmar el CSV en Google Drive.');
    if (file.getSize() < Utilities.newBlob(content, 'text/csv').getSize())
      throw new Error('El CSV creado es incompleto. No se retiran filas.');
    // Resguardo adicional permanente en Supabase: TODOS los valores A:N,
    // incluidos Archivo_Principal, PDF, Total_Paginas y Estado_Regularizado.
    // Cada lote se confirma por separado. Una falla bloquea toda la limpieza.
    const archiveDeadline = Date.now() + 125000;
    for (let start = 0; start < all.length; start += 50) {
      if (Date.now() > archiveDeadline - 20000)
        throw new Error('Respaldo de origen pendiente: tiempo insuficiente; no se borran filas.');
      const rows = all.slice(start, start + 50).map((valores, i) => ({
        fila: selectedIndices[start + i], valores
      }));
      const reply = llamarSupabase_({ mode:'archive_rows', anio:year, cargo, rows });
      if (Number(reply.filas_resguardadas) !== rows.length)
        throw new Error('Supabase no verificó todas las filas originales; se conserva Google Sheets.');
    }
    // Validar de nuevo la primera fila antes de destruir filas por cambios concurrentes.
    const current = hoja.getRange(2, 1, 1, 4).getDisplayValues()[0];
    if (String(current[1]).trim() !== cargo || String(current[3]) !== String(head[3]))
      throw new Error('La hoja cambio durante el respaldo. No se retiraron filas.');
    const reply = llamarSupabase_({mode:'archive',anio:year,cargo,
      codes:Array.from(codeMap),backup_id:file.getId(),row_count:n});
    if (reply.archivado !== true || Number(reply.codigos_verificados) !== codeMap.size ||
        Number(reply.filas_respaldo)!==n)
      throw new Error('Supabase no confirmo integridad de datos. Se conserva la hoja.');
    // Comprobar las 14 columnas de TODAS las filas justo antes de borrarlas,
    // ya que una edicion manual o una carga externa no respeta ScriptLock.
    const currentRows = hoja.getRange(2, 1, last - 1, 14).getDisplayValues();
    const actual = selectedIndices.map(row => currentRows[row - 2]);
    const digest = v => Utilities.base64Encode(Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, JSON.stringify(v)));
    if (hoja.getLastRow() !== last || digest(actual) !== digest(all))
      throw new Error('La hoja cambio durante el archivado. NO se borraron filas.');
    // Borrar solamente los números de fila verificados, de abajo arriba.
    const descending = selectedIndices.slice().sort((a,b) => b-a);
    let high = descending[0], low = high;
    for (let j = 1; j <= descending.length; j++) {
      const index = descending[j];
      if (index === low - 1) { low = index; continue; }
      hoja.deleteRows(low, high - low + 1);
      high = low = index;
    }
    guardarCursor_(2);
    registrarLimpiezaConfirmada_(libro, year, cargo, n, codeMap.size);
    registrarEstado_(libro, 'CARGO ' + cargo + ' ARCHIVADO EN CSV',
      'Respaldo seguro: ' + n + ' filas, ' + codeMap.size +
      ' codigos. Google Drive archivo ' + file.getId() + '. Kardex se conserva.');
  } catch (e) {
    if (libro) registrarEstado_(libro, 'ARCHIVO DETENIDO SIN BORRAR KARDEX', String(e.message || e));
    throw e;
  } finally { lock.releaseLock(); }
}
/**
 * Comparación NO DESTRUCTIVA: si faltan filas en el Google Sheet, se registra
 * una propuesta de corrección, nunca se borra una factura desde aquí.
 * El envío requiere TODA la hoja, por eso una hoja >1200 filas se omite.
 * El sistema sigue guardando ALTAS por ventanas sin ese límite.
 */
function conciliarCargosSeguros_() {
  if (PropertiesService.getScriptProperties().getProperty('KARDEX_SOURCE_ACTIVATED') !== 'true') return;
  if (cargaEnCurso_()) return;
  const lock=LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  let libro;
  try {
    const info=libroCargos_();libro=info.libro;
    const hoja=info.hoja;
    if (hoja.getRange('A1:D1').getDisplayValues()[0].join('|') !== 'Fecha|Cargo|Grupo|Codigo')
      throw new Error('Los encabezados fueron modificados: conciliación suspendida.');
    const count=Math.max(0,hoja.getLastRow()-1);
    if (count>1200) {
      escribirConciliacion_(libro,'REVISIÓN DIFERIDA',
        'Más de 1200 filas: las altas siguen activas; bajas protegidas, sin borrar nada.');
      return;
    }
    const raw=count?hoja.getRange(2,1,count,4).getValues():[];
    const shown=count?hoja.getRange(2,1,count,4).getDisplayValues():[];
    const rows=[];
    for(let i=0;i<count;i++){
      const vals=shown[i];
      if(vals.every(x=>!String(x||'').trim()))continue;
      const fecha=fechaCargos_(raw[i][0]);
      const cargo=String(vals[1]||'').trim().replace(/\.0$/,'');
      const grupo=String(vals[2]||'').trim().replace(/\.0$/,'');
      const codigo=String(vals[3]||'').trim();
      if(!fecha||!cargo||!codigo){
        escribirConciliacion_(libro,'REVISIÓN EN ESPERA',
          'Hay filas incompletas: no se considera que fueron eliminadas.');
        return;
      }
      rows.push({row:i+2,fecha,cargo,grupo,codigo});
    }
    const resultado=llamarSupabase_({mode:'reconcile',rows});
    if(resultado.modo!=='conciliacion_segura'||Number(resultado.eliminadas)!==0)
      throw new Error('Conciliación no destructiva no confirmada: no se aplica cambio.');
    const faltantes=Number(resultado.bajas_pendientes)||0;
    escribirConciliacion_(libro,faltantes?'BAJAS PENDIENTES DE REVISIÓN':'CONCILIACIÓN SEGURA',
      'Bajas detectadas: '+faltantes+'. Facturas eliminadas de Supabase: 0. '+
      'Cualquier corrección debe validarse en el aplicativo administrativo.');
  }catch(e){
    if(libro)escribirConciliacion_(libro,'REVISIÓN EN ERROR',String(e.message||e).slice(0,350));
    throw e;
  }finally{lock.releaseLock();}
}
function escribirConciliacion_(libro,estado,detalle){
  const panel=libro.getSheetByName('INSTRUCCIONES');
  if(panel)panel.getRange('D5:E5').setValues([[estado,detalle]]);
}

function instalarTiempoReal() {
  prepararFuenteCargosV10();
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active || active.getId() !== CARGOS_CONFIG.SHEET_ID)
    throw new Error('Abrir este proyecto desde el Google Sheets CARGOS NUEVOS original.');
  tokenCargos_();
  const handlers = ['alEditarCargos','alEliminarFilas','sincronizarCargosPeriodico','archivarCargosVencidos','archivarCargosDiarios','conciliarCargosSeguros_','ejecutarLimpiezaKardex20h'];
  ScriptApp.getProjectTriggers().filter(t => handlers.includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('alEditarCargos').forSpreadsheet(active).onEdit().create();
  ScriptApp.newTrigger('alEliminarFilas').forSpreadsheet(active).onChange().create();
  ScriptApp.newTrigger('sincronizarCargosPeriodico').timeBased().everyMinutes(1).create();
  // Revisa cada 5 min; la propia funcion impide ejecutar antes de las 20:00 Lima.
  ScriptApp.newTrigger('archivarCargosDiarios').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('conciliarCargosSeguros_').timeBased().everyMinutes(5).create();
  prepararPanelLimpieza_(active);
  guardarCursor_(2);
  registrarEstado_(active, 'V10 PREPARADO SIN CAMBIAR LA FUENTE ACTIVA', 'Activar solo después de la verificación del backend y de las dos hojas.');
  SpreadsheetApp.getUi().alert('V10 preparado. No procesa ni limpia filas hasta activarTiempoRealVerificado().');
}
/** Registra únicamente una fuente INACTIVA, sin exponer su secreto. */
function prepararFuenteCargosV10() {
  const expected='14GzTxs9-hk3_vPTI7AYLc3jiqLAaAC5q7y910wo8Jh0',owner='jaguliquidacion@gmail.com';
  const active=SpreadsheetApp.getActiveSpreadsheet();
  if(!active||active.getId()!==expected)throw new Error('Proyecto o hoja de preparación incorrectos.');
  if(Session.getEffectiveUser().getEmail().toLowerCase()!==owner)throw new Error('Preparar desde la cuenta propietaria del Drive definitivo.');
  const props=PropertiesService.getScriptProperties();
  let secret=props.getProperty('CARGOS_WEBHOOK_TOKEN');
  if(!secret||secret.length<40){secret=(Utilities.getUuid()+Utilities.getUuid()).replace(/-/g,'');props.setProperty('CARGOS_WEBHOOK_TOKEN',secret);}
  const hex=value=>Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value,Utilities.Charset.UTF_8).map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join('');
  const sheet=active.getSheetByName('CARGOS NUEVOS');if(!sheet)throw new Error('Pestaña operativa no encontrada.');
  const rows=sheet.getRange(1,1,Math.max(1,sheet.getLastRow()),14).getDisplayValues();
  while(rows.length&&rows[rows.length-1].every(v=>v===''))rows.pop();
  const input={kind:'cargos',sheet_id:expected,token_sha256:hex(secret),build_id:'CARGOS_V10_20261031',display_rows:rows.length,display_sha256:hex(JSON.stringify(rows))};
  const response=UrlFetchApp.fetch('https://uhjwhamzjxhjqlrhgxho.supabase.co/functions/v1/kardex-source-enroll',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},payload:JSON.stringify(input),muteHttpExceptions:true,followRedirects:false});
  let result;try{result=JSON.parse(response.getContentText());}catch(_){throw new Error('No se confirmó la preparación de la fuente.');}
  if(response.getResponseCode()!==200||result.enrolled!==true)throw new Error('Preparación rechazada. No activar ni limpiar filas.');
  if(!result.active)props.setProperty('KARDEX_SOURCE_ACTIVATED','false');
  return {prepared:true,active:result.active,build:input.build_id,rows:rows.length,sha256:input.display_sha256};
}
function activarTiempoRealVerificado() {
  const reply=llamarSupabase_({mode:'probe'});
  if(reply.activa!==true||reply.sheet_id!=='14GzTxs9-hk3_vPTI7AYLc3jiqLAaAC5q7y910wo8Jh0')throw new Error('La fuente aún no está activa en Supabase. No se modificaron filas.');
  PropertiesService.getScriptProperties().setProperty('KARDEX_SOURCE_ACTIVATED','true');
  return sincronizarCargosPeriodico();
}
