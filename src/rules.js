import { cargoYear } from './cargo-year.js';

export const HISTORICAL_IM_NOTE = 'Envío histórico a Iron Mountain cuya relación original se extravió. La fecha aproximada es una referencia calculada y no acredita la fecha real del traslado.';

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

export function addMonths(iso, months) {
  const [year, month, day] = iso.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month + months, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

export function documentedImShipment(doc) {
  return !!(doc.imLiveFechaEnvio || doc.imConfirmado ||
    (doc.fEnvio && (doc.sustento || doc.sustentoImagen || doc.tieneSustentoImagen)));
}

export function usesHistoricalImDecision(doc) {
  const year = Number(cargoYear(doc));
  return !!doc.imHistoricalDecision && year >= 2020 && year <= 2024;
}

export function isSentIm(estado) {
  return estado === 'Enviado a Iron Mountain' || estado === 'Histórico';
}

export function historicalShipmentDetails(doc) {
  const cargoDate = validDate(doc.fechaOrigen);
  return {
    cargoDate,
    approximateDate: cargoDate ? addMonths(cargoDate, 6) : null,
    realDate: doc.imLiveFechaEnvio || doc.imFechaEnvio || doc.fEnvio,
    box: (doc.imLiveFechaEnvio && doc.imLiveCodigoCaja) || doc.imCodigoCaja,
    responsible: (doc.imLiveFechaEnvio && doc.imLiveResponsableEntrega) || doc.imResponsable
  };
}

export const REQ_TYPES = [
  'Cajas nuevas para acondicionar',
  'Préstamo de Cajas (búsqueda de documentos)',
  'Solicitud de Recojo nuevos ingresos',
  'Solicitud de Recojo por devolución de cajas',
  'Otros'
];
export const DOC_TYPES = ['Facturas-Guia', 'Boletas de Venta', 'Guías de Remisión', 'Fact / GR / BV'];
export const LOCATIONS = ['Santa Anita', 'Iron Mountain', 'CD Arequipa', 'Otros'];

export function limaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const value = type => parts.find(p => p.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
export function monthsBetween(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth()
    + (b.getDate() >= a.getDate() ? 0 : -1);
}
export function computeReqEstado(r, docs = []) {
  if (r.estadoV4) return r.estadoV4;
  if (r.tipo === REQ_TYPES[0]) {
    if (!r.fechaRecepcion) return 'Solicitado';
    const usadas = docs.filter(d => d.cajaAsignada === r.id).length;
    return usadas >= (Number(r.cantidadCajas) || 0) ? 'Completado' : 'Recibido';
  }
  if (r.tipo === REQ_TYPES[1]) {
    if (!r.fechaRecepcion) return 'Solicitado';
    return r.fechaDevolucion ? 'Devuelto' : 'Prestado';
  }
  return r.fechaRecepcion ? 'Completado' : 'Solicitado';
}
export function computeDocEstado(d, now = new Date()) {
  let estado = 'Pendiente de Envío';
  if (d.cajaAsignada) estado = 'En Proceso de Acondicionamiento';
  if (d.imConfirmado || (d.fEnvio && (d.sustento || d.sustentoImagen || d.tieneSustentoImagen))) estado = 'Enviado a Iron Mountain';
  // La hoja activa prevalece sobre el histórico de una caja reutilizada.
  // Fecha de envío = enviado. Por solicitud sin fecha = celeste y pendiente.
  if (d.imLiveCodigoCaja) {
    if (d.imLiveFechaEnvio) estado = 'Enviado a Iron Mountain';
    else if (/por\s+solicitud/i.test(String(d.imLiveClasificacion||''))) estado = 'Caja solicitada';
    else estado = 'Caja preparada para envío';
  }
  if (usesHistoricalImDecision(d)) {
    if (documentedImShipment(d)) estado = 'Enviado a Iron Mountain';
    else if (d.imHistoricalDecision === 'historico') estado = 'Histórico';
  }
  const today = new Date(`${limaDate(now)}T00:00:00`);
  const antiguedad = d.periodo && !isSentIm(estado)
    ? monthsBetween(new Date(`${d.periodo}T00:00:00`), today) : '-';
  return { estado, antiguedad };
}
export function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
export function fmtDate(iso) {
  if (!iso) return '';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('es-PE', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });
}
export function safeImage(value) {
  return /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value || '') ? value : '';
}
