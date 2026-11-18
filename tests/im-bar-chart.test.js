import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {renderImBarChart} from '../src/im-bar-chart.js';
function draw(labels,values,options={}){
  const dom=new JSDOM('<div id="chart"></div>');
  const previous=globalThis.document;
  globalThis.document=dom.window.document;
  try{
    const container=dom.window.document.querySelector('#chart');
    renderImBarChart(container,labels,values,options);
    return container;
  }finally{globalThis.document=previous;}
}
test('barras mensuales solo incluyen cajas con fecha registrada',()=>{
  const chart=draw(['Oct','Nov'],[32,60],{accent:'#2da66b'});
  assert.equal(chart.querySelectorAll('[data-im-kind="verified"]').length,2);
  assert.equal(chart.querySelectorAll('[data-im-kind="unknown"]').length,0);
});
test('históricos sin cajas físicas muestran ? y no fabrican cifras',()=>{
  const chart=draw(['2020','2024'],[0,443],{historicalUnknown:[23,83]});
  assert.equal(chart.querySelectorAll('[data-im-kind="verified"]').length,1);
  assert.equal(chart.querySelectorAll('[data-im-kind="unknown"]').length,2);
  assert.equal(chart.querySelectorAll('[data-im-kind="historical"]').length,0);
  assert.match(chart.querySelector('g[aria-label^="2024"]').getAttribute('aria-label'),/443 cajas contabilizadas/);
  assert.match(chart.querySelector('g[aria-label^="2024"]').getAttribute('aria-label'),/83 cargos históricos/);
});
test('cajas históricas cuantificadas permiten barra morada apilada',()=>{
  const chart=draw(['2024'],[400],{historicalValues:[43]});
  assert.equal(chart.querySelectorAll('[data-im-kind="verified"]').length,1);
  assert.equal(chart.querySelectorAll('[data-im-kind="historical"]').length,1);
  assert.match(chart.querySelector('g[aria-label^="2024"]').getAttribute('aria-label'),/443 cajas contabilizadas/);
});
test('sin datos no inventa barras',()=>{
  const chart=draw(['2021'],[0]);
  assert.equal(chart.querySelectorAll('[data-im-kind]').length,0);
});
