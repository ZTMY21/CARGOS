import { computeDocEstado, limaDate } from './rules.js';
import { cargoYear } from './cargo-details.js';

const DAY = 86400000;
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value ? value : null;
}
function addMonths(iso, months) {
  const [year, month, day] = iso.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))).toISOString().slice(0,10);
}
function duration(start, end) {
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  let months = (ey - sy) * 12 + em - sm;
  if (addMonths(start, months) > end) months--;
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${addMonths(start, months)}T00:00:00Z`)) / DAY);
  return { months, days };
}

export function formatCargoDuration({ months, days }) {
  return `${months} ${months === 1 ? 'mes' : 'meses'}${days ? ` y ${days} ${days === 1 ? 'día' : 'días'}` : ''}`;
}

// Both cards and their detail lists use the same full, synchronized snapshot.
// Import dates are deliberately not a fallback: they would make old cargos look new.
export function cargoExpiryGroups(docs, now = new Date()) {
  const today = limaDate(now);
  const groups = { today, overdue: [], upcoming: [], unknown: [] };
  for (const doc of docs) {
    const year = cargoYear(doc);
    if (!['2025', '2026'].includes(year) || !doc.cargos?.length) continue;
    const { estado } = computeDocEstado(doc, now);
    if (estado === 'Enviado a Iron Mountain') continue;
    const baseDate = validDate(doc.periodo) || validDate(doc.fechaOrigen);
    if (!baseDate || baseDate > today) {
      groups.unknown.push(doc);
      continue;
    }
    const dueDate = addMonths(baseDate, 6);
    // Exactly six calendar months is still current; the following day is overdue.
    const status = today > dueDate ? 'overdue' : 'upcoming';
    groups[status].push({ ...doc, estado, expiry: {
      year, baseDate, dueDate, status,
      age: duration(baseDate, today),
      time: status === 'overdue' ? duration(dueDate, today) : duration(today, dueDate)
    } });
  }
  for (const status of ['overdue', 'upcoming']) {
    groups[status].sort((a,b) => a.expiry.dueDate.localeCompare(b.expiry.dueDate)
      || String(a.kardex || '').localeCompare(String(b.kardex || ''), 'es', {numeric:true}));
  }
  return groups;
}
