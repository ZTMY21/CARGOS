import test from 'node:test';
import assert from 'node:assert/strict';
import { cargoExpiryGroups, formatCargoDuration } from '../src/cargo-expiry.js';

const now = new Date('2026-10-18T08:25:00Z');
const doc = (fechaOrigen, extra={}) => ({kardex:'SA-00001',cargos:['660A'],anioOrigen:2026,fechaOrigen,...extra});
test('only 2025/2026 cargos pending shipment enter the expiry groups, including historical dates', () => {
  const groups = cargoExpiryGroups([
    doc('2025-01-01',{anioOrigen:2025}),doc('2026-09-30'),
    doc('2024-01-01',{anioOrigen:2024}),doc('2026-01-01',{anioOrigen:2027}),
    doc('2026-01-01',{imConfirmado:true}),
    doc('2026-01-01',{fEnvio:'2026-10-01',sustento:'Guía'}),
    doc('2026-01-01',{fEnvio:'2026-10-01',tieneSustentoImagen:true}),
    doc('2026-01-01',{cargos:[]})
  ],now);
  assert.equal(groups.overdue.length,1);
  assert.equal(groups.upcoming.length,1);
  assert.equal(groups.overdue[0].expiry.year,'2025');
  assert.equal(groups.upcoming[0].cargos[0],'660A');
  assert.equal(groups.overdue[0].expiry.baseDate,'2025-01-01');
});
test('six-month anniversary is included in upcoming; one day later is overdue', () => {
  const groups=cargoExpiryGroups([doc('2026-04-17'),doc('2026-04-18'),doc('2026-04-19')],now);
  assert.equal(groups.overdue.length,1);
  assert.equal(groups.upcoming.length,2);
  assert.deepEqual(groups.overdue[0].expiry.time,{months:0,days:1});
  assert.deepEqual(groups.overdue[0].expiry.age,{months:6,days:1});
  assert.deepEqual(groups.upcoming[0].expiry.time,{months:0,days:0});
  assert.deepEqual(groups.upcoming[1].expiry.time,{months:0,days:1});
  assert.equal(formatCargoDuration(groups.overdue[0].expiry.time),'0 meses y 1 día');
});
test('calendar-month arithmetic clamps end-of-month dates and respects Lima midnight', () => {
  const august=doc('2025-08-31',{anioOrigen:2025});
  let groups=cargoExpiryGroups([august],new Date('2026-03-01T04:59:59Z'));
  assert.equal(groups.today,'2026-02-28');
  assert.equal(groups.upcoming[0].expiry.dueDate,'2026-02-28');
  groups=cargoExpiryGroups([august],new Date('2026-03-01T05:00:00Z'));
  assert.deepEqual(groups.overdue[0].expiry.time,{months:0,days:1});
  assert.equal(cargoExpiryGroups([doc('2026-03-31')],now).overdue[0].expiry.dueDate,'2026-09-30');
  const december=doc('2025-12-31',{anioOrigen:2025});
  assert.equal(cargoExpiryGroups([december],now).overdue[0].expiry.dueDate,'2026-06-30');
});
test('missing, impossible and future source dates are not replaced with import dates', () => {
  const groups=cargoExpiryGroups([
    doc('',{fechaRegistro:'2026-10-18'}),doc('2026-02-30'),doc('2026-13-01'),
    doc('not-a-date'),doc('2026-10-19'),doc('2026-01-01',{periodo:'invalid'})
  ],now);
  assert.equal(groups.unknown.length,5);
  assert.equal(groups.overdue.length,1);
  assert.equal(groups.upcoming.length,0);
});
test('an explicit accounting period takes precedence; the source year and full cargo codes are preserved', () => {
  const groups=cargoExpiryGroups([
    doc('2025-12-30',{periodo:'2026-09-01',cargos:['001','001A']}),
    doc('2025-12-30',{kardex:'SA-00002'})
  ],now);
  assert.equal(groups.overdue[0].expiry.year,'2026');
  assert.equal(groups.upcoming[0].expiry.baseDate,'2026-09-01');
  assert.deepEqual(groups.upcoming[0].cargos,['001','001A']);
  assert.deepEqual(groups.upcoming[0].expiry.time,{months:4,days:11});
  assert.equal(formatCargoDuration({months:1,days:2}),'1 mes y 2 días');
});

test('color thresholds include three calendar months, the fifth month, and exactly seven remaining days', () => {
  const cases=[
    ['2026-10-18','green',182], // Newly synchronized today.
    ['2026-07-18','green',92],  // Exactly three months old.
    ['2026-07-17','yellow',91], // Three months plus one day.
    ['2026-05-18','yellow',31], // Exactly five months old.
    ['2026-04-26','yellow',8],
    ['2026-04-25','red',7],
    ['2026-04-18','red',0],
    ['2026-04-17','red',-1]
  ];
  for (const [date,color,days] of cases) {
    const groups=cargoExpiryGroups([doc(date)],now);
    const row=[...groups.upcoming,...groups.overdue][0];
    assert.equal(row.expiry.color,color,date);
    assert.equal(row.expiry.daysRemaining,days,date);
    assert.equal(groups.overdue.length,days<0?1:0,date);
  }
});

test('green and red boundaries respect clamped month ends and Lima dates', () => {
  const cargo=doc('2026-07-31');
  let groups=cargoExpiryGroups([cargo],new Date('2026-11-01T04:59:59Z'));
  assert.equal(groups.upcoming[0].expiry.color,'green');
  groups=cargoExpiryGroups([cargo],new Date('2026-11-01T05:00:00Z'));
  assert.equal(groups.upcoming[0].expiry.color,'yellow');
  const august=doc('2025-08-31',{anioOrigen:2025});
  groups=cargoExpiryGroups([august],new Date('2026-02-21T05:00:00Z'));
  assert.equal(groups.upcoming[0].expiry.daysRemaining,7);
  assert.equal(groups.upcoming[0].expiry.color,'red');
});
