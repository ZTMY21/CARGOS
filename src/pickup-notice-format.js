const timeZone = 'America/Lima';
const calendar = new Intl.DateTimeFormat('es-PE', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
});
const localHour = new Intl.DateTimeFormat('es-PE', {
  timeZone, hour: 'numeric', hourCycle: 'h23'
});

export function pickupNoticeCopy(date) {
  const parts = Object.fromEntries(calendar.formatToParts(date).map(({type, value}) => [type, value]));
  const hour = Number(localHour.format(date));
  return {
    subject: `IM-${parts.year}${parts.month}${parts.day} II INGRESO DE CAJAS A IRON MOUNTAIN`,
    greeting: hour < 12 ? 'Buenos días, Jorge:' : hour < 19 ? 'Buenas tardes, Jorge:' : 'Buenas noches, Jorge:',
    introduction: 'Te pido tu apoyo con la siguiente solicitud para IM.',
    request: '',
    closing: ''
  };
}

export function pickupNoticeLine(type, count) {
  if (type === 'NUEVAS') return `${count} ${count === 1 ? 'caja' : 'cajas'} para almacenamiento en Iron Mountain.`;
  return `${count} ${count === 1 ? 'caja' : 'cajas'} de retorno para rearchivamiento en Iron Mountain.`;
}
