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
test('las barras mensuales siguen mostrando solo cajas enviadas',()=>{
  const chart=draw(['Oct','Nov'],[32,60],{accent:'#2da66b'});
  assert.equal(chart.querySelectorAll('[data-im-kind="verified"]').length,2);
  assert.equal(chart.querySelectorAll('[data-im-kind="historical"]').length,0);
  assert.equal(chart.textContent.includes('?'),false);
});
test('históricos aparecen como barras moradas con sus cantidades reales, sin interrogación',()=>{
  const chart=draw(['2020','2021','2024'],[0,0,443],{historicalValues:[23,604,83]});
  assert.equal(chart.querySelectorAll('[data-im-kind="verified"]').length,1);
  assert.equal(chart.querySelectorAll('[data-im-kind="historical"]').length,3);
  assert.equal(chart.textContent.includes('?'),false);
  assert.match(chart.querySelector('g[aria-label^="2024"]').getAttribute('aria-label'),/443 cajas enviadas; históricos 83 cargos/);
  assert.match(chart.querySelector('g[aria-label^="2021"]').getAttribute('aria-label'),/604 cargos/);
});
test('2024: históricos y cajas son barras independientes y no se suman',()=>{
  const chart=draw(['2024'],[443],{historicalValues:[83]});
  const green=chart.querySelector('[data-im-kind="verified"]');
  const purple=chart.querySelector('[data-im-kind="historical"]');
  assert.ok(green&&purple);
  assert.notEqual(green.getAttribute('x'),purple.getAttribute('x'));
  assert.ok(!chart.textContent.includes('526'));
});
test('sin datos la gráfica no inventa envíos',()=>{
  const chart=draw(['2021'],[0]);
  assert.equal(chart.querySelectorAll('[data-im-kind]').length,0);
});
