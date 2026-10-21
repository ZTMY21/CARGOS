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
  if (d.fEnvio || d.imFechaEnvio) estado = 'Enviado a Iron Mountain';
  const today = new Date(`${limaDate(now)}T00:00:00`);
  const antiguedad = d.periodo && estado !== 'Enviado a Iron Mountain'
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
