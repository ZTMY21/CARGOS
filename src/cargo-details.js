import { normalizeSearch } from './search.js';

export function cargoYear(doc) {
  return String(doc.anioOrigen || doc.periodo?.slice(0,4) || doc.fechaOrigen?.slice(0,4) || 'Sin dato');
}

// Original Excel rows may be objects or compressed arrays with a column dictionary.
export async function sourceRecords(origin = {}) {
  let rows = origin.registros || [];
  if (origin.registros_gzip_base64) {
    const bytes = Uint8Array.from(atob(origin.registros_gzip_base64), c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    rows = JSON.parse(await new Response(stream).text());
  }
  return rows.map(row => Array.isArray(row)
    ? Object.fromEntries((origin.columnas || []).map((key,i) => [key,row[i] ?? ''])) : row);
}

const field = (row, name) => Object.entries(row).find(([key]) => normalizeSearch(key) === name)?.[1];
const cleanCode = value => String(value ?? '').trim().replace(/^[,;\s]+|[,;\s]+$/g,'');
export function sortedGroups(values) {
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))]
    .sort((a,b) => a.localeCompare(b, 'es', {numeric:true}));
}
export function locationLabel(groups) {
  return groups?.length ? groups.map(group => `Grupo ${group}`).join(', ') : 'Sin grupo registrado';
}
export async function cargoLocations(origin = {}) {
  const byCode = new Map();
  for (const row of await sourceRecords(origin)) {
    const code = normalizeSearch(cleanCode(field(row,'codigo')));
    if (!code) continue;
    byCode.set(code, sortedGroups([...(byCode.get(code)||[]),field(row,'grupo')]));
  }
  // Current Google groups take precedence over historical source rows.
  for (const [code,groups] of Object.entries(origin.grupos_por_codigo || {})) {
    byCode.set(normalizeSearch(code), sortedGroups(Array.isArray(groups) ? groups : [groups]));
  }
  return Object.fromEntries(byCode);
}

export function groupsForCodes(locations, codes) {
  return sortedGroups(codes.flatMap(code => locations[normalizeSearch(code)] || []));
}

export function invoiceLocation(doc, code) {
  if (!doc.ubicacionesCodigo) return doc.errorUbicacion || 'Consultando grupo…';
  return locationLabel(groupsForCodes(doc.ubicacionesCodigo,[code]));
}
