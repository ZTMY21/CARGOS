import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const app=await readFile(new URL('../src/app.js',import.meta.url),'utf8');

test('cargos antiguos: se retiran controles y consultas de sincronización de la app',()=>{
  for(const id of [
    'btnToggleGoogleSync','googleSyncBadge','googleSyncBadgeText',
    'googleSyncRegistered','googleSyncPending','googleSyncConflicts',
    'googleSyncStatus','googleSyncDetails','googleSyncLastReview',
    'btnOpenGoogleExcel'
  ])assert.doesNotMatch(html,new RegExp('id="'+id+'"'));
  assert.doesNotMatch(app,/refreshGoogleSync|kardex_google_sync|btnToggleGoogleSync|googleSyncEnabled/);
  assert.doesNotMatch(html,/Estado de sincronización|Pausar sincronización/);
  assert.doesNotMatch(html,/18TbKWiVUWKfkJOXvR0kGEMb5eVKTDCfoXAUtD5rCxts/);
  assert.match(html,/Actualizar datos/);
});

test('se conservan carga por Excel, indicadores, navegación e Iron Mountain',()=>{
  for(const id of [
    'googleSyncPanel','workspaceTabs','googleSyncContent',
    'monthlyCargosCreated','monthlyCargosShipped','monthlyBoxesConditioned',
    'btnMonthlyCreatedDetail','btnExportar','scanFile','scanValidate','scanSave',
    'btnOpenIronMountainHistorical','resumenHeaderShell'
  ])assert.match(html,new RegExp('id="'+id+'"'));
  // Cargos Enviados ya tiene su acceso en otro módulo y no se duplica en Resumen.
  assert.doesNotMatch(html,/id="btnOpenIronMountainExcel"/);
  assert.match(html,/id="resumenHeaderShell"/);
  assert.match(html,/id="btnOpenIronMountainHistorical"/);
  assert.match(app,/reloadPreparedImSummary/);
  assert.match(app,/reloadShippedBoxesSummary/);
  assert.match(app,/attachScanImport/);
  assert.match(app,/async function refreshData/);
});
