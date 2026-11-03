import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {computeDocEstado} from '../src/rules.js';
import {cargoExpiryGroups} from '../src/cargo-expiry.js';
import {summarizeCreatedCargos} from '../src/monthly-created-summary.js';

const sql=readFileSync(new URL('../supabase/migrations/20261103053000_fix_excel_dual_finalization_receipts.sql',import.meta.url),'utf8');
const api=readFileSync(new URL('../api/cargo-excel.js',import.meta.url),'utf8');

test('el índice no intenta INSERT en columnas GENERATED ALWAYS del Kárdex',()=>{
 const insert=sql.match(/insert into public\.documentos\s*\(([\s\S]*?)\)\s*values\s*\(/i);
 assert.ok(insert,'SQL de inserción no encontrado');
 assert.doesNotMatch(insert[1],/\b(busqueda_facturas|busqueda_meta|cantidad_facturas)\b/i);
 assert.match(insert[1],/\bperiodo\b/i);
 assert.match(insert[1],/\bfacturas\b/i);
 assert.match(sql,/returning \* into v_new/i);
});
test('solo se finaliza cuando ambos recibos con firma y metadatos han sido validados',()=>{
 assert.match(api,/kardex_excel_guardar_recibo/);
 assert.match(api,/kardex_excel_consultar_recibos/);
 assert.match(api,/timingSafeEqual/);
 assert.match(api,/kardex_excel_finalizar/);
 assert.match(api,/meta\('original'\),meta\('depurado'\)/);
 assert.doesNotMatch(api,/Promise\.all\(\[read\('original'\),read\('depurado'\)\]\)/);
});
test('cargo importado sin fecha IM figura como pendiente y por vencer desde su fecha de origen',()=>{
 const now=new Date('2026-11-04T13:00:00Z');
 const previous={anioOrigen:2026,claveOrigen:'google-live|cargos',cargos:['941'],
   fechaOrigen:'2026-10-30',periodo:'2026-10-30',fechaRegistro:'2026-10-30'};
 const imported={anioOrigen:2026,claveOrigen:'excel-drive|2026|942',cargos:['942'],
   fechaOrigen:'2026-10-31',periodo:'2026-10-31',fechaRegistro:'2026-11-03'};
 assert.equal(computeDocEstado(imported,now).estado,'Pendiente de Envío');
 const exp=cargoExpiryGroups([previous,imported],now);
 assert.equal(exp.upcoming.length,2);
 assert.equal(exp.upcoming.find(x=>x.cargos.includes('942')).expiry.baseDate,'2026-10-31');
 const stats=summarizeCreatedCargos([previous,imported],now);
 assert.equal(stats.currentCount,1);
 assert.equal(stats.annual.at(-1).count,2);
});
