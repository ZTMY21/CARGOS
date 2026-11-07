import { escapeHtml as html, fmtDate, limaDate, REQ_TYPES } from './rules.js';
import {receptionStatus as receiptStatus,receptionTime} from './box-reception-ui.js';

const kinds = {nuevas: 'Cajas nuevas', prestamo: 'Solicitudes a IM'};
const steps = {nuevas: ['Cantidad', 'Solicitar'], prestamo: ['Buscar', 'Seleccionar', 'Solicitar']};
const supplyBlockedMessage = 'No se pueden solicitar más cajas a Iron Mountain';

function supplyAvailability(rows, tracking) {
  const supplies = rows.filter(row => row.tipo === REQ_TYPES[0]);
  const confirmed = tracking?.suministro;
  const known = new Set(confirmed?.solicitudes?.map(row => row.id));
  const missing = supplies.filter(row => !known.has(row.id)).reduce((total,row) => total + Number(row.cantidadCajas),0);
  const pending = Number(confirmed?.pendientes || 0) + missing;
  return {pending, blocked: !tracking || pending > 0, verified: !!tracking};
}

function receptionStatus(row) {
  if (row.fechaRecepcion && row.tipo === REQ_TYPES[0]) return `Recibido — ${fmtDate(row.fechaRecepcion)}`;
  if (row.estadoV4 === 'Recibido parcialmente') return 'Recepción parcial';
  return row.tipo === REQ_TYPES[0] ? 'Pendiente de recepción' : row.estadoV4;
}

function detailsList(rows, tracking, supply) {
  return rows.map(row => {
    const shipped = tracking?.suministro?.solicitudes?.find(item => item.id === row.id);
    const complete = supply ? shipped?.pendientes === 0 : row.estadoV4 === 'Devuelto' || !!row.fechaDevolucion;
    const state = supply && complete ? 'Enviado a IM' : receptionStatus(row);
    const tone = complete ? 'is-complete' : supply || row.estadoV4 === 'Solicitado' ? 'is-pending' : 'is-active';
    return `<article class="req4-request-row" role="listitem">
      <strong>${html(row.numero)}</strong>
      <span class="req4-request-date">Solicitado el ${fmtDate(row.fechaSolicitud)}</span>
      <span class="req4-request-badge ${tone}">${html(state)}</span>
      <span class="req4-request-quantity"><strong>${Number(row.cantidadCajas)}</strong> ${Number(row.cantidadCajas) === 1 ? 'caja' : 'cajas'}</span>
      <button class="secondary" type="button" data-req-open="${html(row.id)}" aria-label="Ver solicitud ${html(row.numero)}">Ver solicitud</button>
    </article>`;
  }).join('');
}

function procedure(kind, current = 0) {
  return `<ol class="req4-steps" aria-label="Etapas del procedimiento">${steps[kind].map((label,index) =>
    `<li${index === current ? ' aria-current="step"' : ''} class="${index < current ? 'is-complete' : ''}"><span>${index + 1}</span>${label}</li>`
  ).join('')}</ol>`;
}

export function requestCards(rows, tracking) {
  const supplyPending = supplyAvailability(rows,tracking).pending;
  const loanPending = new Set(tracking?.cajas.filter(box => !box.devolucion).map(box => box.clave)).size;
  return [['nuevas','Cajas para acondicionar',tracking ? supplyPending : '—'],
          ['prestamo',kinds.prestamo,tracking ? loanPending : '—']]
      .map(([kind,title,total]) => `<section class="kpi kpi-color">
          <div class="expiry-card-heading">
            <div class="l">${title}</div>
            <button type="button" class="expiry-detail-button" data-req-card="${kind}" aria-label="Ver detalle de ${title}" aria-haspopup="dialog" aria-controls="req4Dialog">Ver detalle</button>
          </div>
          <div class="n">${total}</div>
        </section>`).join('');
}

export function setupRequirements(root, {repository, context, refresh, onKindChange = () => {}, isPreview = false, receptionEnabled = false}) {
  const selected = new Map();
  let rows = [], tracking = null, viewer = null, busy = false, searchEpoch = 0;
  let pending = null;
  let supplyRejected = false;
  let cardView = null;
  root.innerHTML = `
    <p class="req4-intro">Solicita cajas y consulta su seguimiento.</p>
    <div class="req4-tabs" role="tablist" aria-label="Tipo de requerimiento">
      <button id="req4TabNuevas" type="button" role="tab" aria-selected="true" aria-controls="req4Supply" data-req-kind="nuevas">${kinds.nuevas}</button>
      <button id="req4TabPrestamo" type="button" role="tab" aria-selected="false" aria-controls="req4Loan" tabindex="-1" data-req-kind="prestamo">${kinds.prestamo}</button>
    </div>
    <div id="req4Steps">${procedure('nuevas')}</div>
    <form id="req4Form" class="req4-form">
      <input id="req4Kind" type="hidden" value="nuevas">
      <h3 id="req4FormTitle">Solicitar cajas nuevas</h3>
      <p id="req4FormHelp" class="req4-help">Para acondicionar nuevos cargos.</p>
      <div class="grid req4-meta">
        <label class="field">Fecha de solicitud<input id="req4Date" type="date" readonly></label>
        <label class="field">Solicitante<input id="req4User" readonly></label>
      </div>
      <section id="req4Supply" role="tabpanel" aria-labelledby="req4TabNuevas">
        <div id="req4SupplyLock" class="req4-supply-lock" role="alert" hidden></div>
        <label class="field" id="req4QtyWrap">Cantidad de cajas<input id="req4Qty" type="number" min="1" max="100" step="1" aria-describedby="req4QtyHelp" required></label>
        <p id="req4QtyHelp" class="req4-help">Máximo 100 cajas por solicitud.</p>
        <p id="req4ReceiptWrap" class="req4-note">La confirmación y recepción corresponden a Control de cajas.</p>
      </section>
      <section id="req4Loan" role="tabpanel" aria-labelledby="req4TabPrestamo" hidden>
        <div class="req4-search">
          <label class="field">Cargo, factura, guía, boleta o código de caja<input id="req4Query" type="search" maxlength="120" placeholder="Escribe el documento o código de caja" aria-describedby="req4LoanHelp"></label>
          <button id="req4Search" type="button">Buscar</button>
        </div>
        <p id="req4LoanHelp" class="req4-note">Solicitud a Iron Mountain. Selecciona cajas con envío confirmado y sin una solicitud activa.</p>
        <div id="req4Results" aria-live="polite"></div>
        <h4>Cajas seleccionadas</h4><div id="req4Selected" aria-live="polite"></div>
      </section>
      <div class="req4-form-footer">
        <span id="req4SelectionCount" class="req4-help" hidden></span>
        <button id="req4Submit" type="submit">Solicitar</button>
      </div>
      <p id="req4Status" class="req4-status" role="status"></p>
    </form>
    <dialog class="expiry-sheet req4-dialog" id="req4Dialog" aria-labelledby="req4DialogTitle">
      <div class="req4-dialog-head"><div class="req4-dialog-heading"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7h18M4 3h16l2 4v3H2V7l2-4Z"/><path d="M4 10v11h16V10M9 14h6"/></svg><div><h2 id="req4DialogTitle"></h2><p id="req4DialogIntro" class="req4-help"></p></div></div><button class="secondary" data-req-close type="button">Cerrar</button></div>
      <div id="req4DialogBody"></div><p id="req4DialogStatus" role="status"></p>
    </dialog>`;
  const find = id => root.ownerDocument.getElementById(`req4${id}`);
  const allowed = () => context().allowed;
  const form = find('Form'), kind = find('Kind'), qty = find('Qty'), dialog = find('Dialog');
  root.ownerDocument.body.append(dialog);
  let results = [];
  const canRequest = box => !!box?.clave && box.solicitable === true && !box.prestamo;

  function renderAvailability() {
    const supply = kind.value === 'nuevas';
    const availability = supplyAvailability(rows,tracking);
    const blocked = supply && (availability.blocked || supplyRejected);
    const notice = find('SupplyLock');
    notice.hidden = !blocked;
    notice.innerHTML = availability.verified || supplyRejected
      ? `<strong>${supplyBlockedMessage}</strong><p>${receptionEnabled ? 'Completa el acondicionamiento de la solicitud anterior.' : 'Completa el envío a IM de las cajas pendientes para solicitar más.'}${availability.pending ? ` Quedan ${availability.pending} cajas pendientes.` : ''}</p>`
      : `<strong>Verificando ${receptionEnabled ? 'el acondicionamiento' : 'el envío'} de las cajas.</strong><p>Actualiza los datos si no se completa la consulta.</p>`;
    qty.disabled = !supply || blocked || busy;
    find('Submit').disabled = !allowed() || busy || blocked;
  }

  function renderSelection() {
    find('Selected').innerHTML = selected.size ? `<ul class="req4-box-list">${[...selected.values()].map(box => `<li>
      <div><strong>${html(box.codigo)}</strong><span class="req4-box-meta">Cargos ${html(box.cargos.join(', '))}</span>
      ${!canRequest(box) ? '<span class="req4-unavailable">No disponible para solicitud a IM</span>' : ''}</div>
      <button class="link" data-req-remove="${html(box.clave)}" type="button" aria-label="Retirar caja ${html(box.codigo)}">Retirar</button>
    </li>`).join('')}</ul>` : '<p class="req4-empty">Agrega las cajas que deseas solicitar.</p>';
    find('SelectionCount').textContent = `${selected.size} ${selected.size === 1 ? 'caja seleccionada' : 'cajas seleccionadas'}`;
    if (kind.value === 'prestamo') find('Steps').innerHTML = procedure('prestamo',selected.size ? 1 : 0);
  }
  function changeKind() {
    const loan = kind.value === 'prestamo';
    find('Loan').hidden = !loan;
    find('Supply').hidden = loan;
    find('QtyWrap').hidden = find('ReceiptWrap').hidden = loan;
    find('SelectionCount').hidden = !loan;
    find('FormTitle').textContent = loan ? 'Solicitar cajas a IM' : 'Solicitar cajas nuevas';
    find('FormHelp').textContent = loan ? 'Busca el documento que necesitas consultar en Iron Mountain.' : 'Para acondicionar nuevos cargos.';
    find('Steps').innerHTML = procedure(kind.value,loan ? selected.size ? 1 : 0 : qty.value ? 1 : 0);
    for (const tab of root.querySelectorAll('[data-req-kind]')) {
      const active = tab.dataset.reqKind === kind.value;
      tab.setAttribute('aria-selected',String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    qty.disabled = loan;
    qty.required = !loan;
    renderAvailability();
  }
  function selectKind(value, focus = false) {
    if (busy) return;
    kind.value = value;
    find('Status').textContent = '';
    changeKind();
    onKindChange(value);
    if (focus) root.querySelector(`[data-req-kind="${value}"]`).focus();
  }
  kind.addEventListener('change',() => selectKind(kind.value));
  qty.addEventListener('input',() => {
    if (kind.value === 'nuevas') find('Steps').innerHTML = procedure('nuevas',qty.value ? 1 : 0);
  });
  root.querySelector('[role="tablist"]').addEventListener('keydown',event => {
    if (!event.target.matches('[data-req-kind]')) return;
    let next;
    if (event.key === 'Home') next = 'nuevas';
    else if (event.key === 'End') next = 'prestamo';
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = kind.value === 'nuevas' ? 'prestamo' : 'nuevas';
    if (next) { event.preventDefault(); selectKind(next,true); }
  });
  changeKind();
  renderSelection();

  async function search() {
    if (!allowed() || busy) return;
    const value = find('Query').value.trim();
    const epoch = ++searchEpoch;
    const container = find('Results');
    if (!value) { container.textContent = 'Escribe un cargo, factura, guía, boleta o código de caja.'; return; }
    results = [];
    container.textContent = 'Buscando documentos y cajas…';
    try {
      const found = await repository.requestBoxes(value);
      if (epoch !== searchEpoch || !allowed()) return;
      results = found;
      for (const box of found) {
        if (selected.has(box.clave)) selected.set(box.clave,box);
      }
      renderSelection();
      container.innerHTML = found.length ? `<ul class="req4-box-list">${found.map((box,index) => `<li>
        <div><strong>${html(box.codigo || (box.tipo === 'documento' ? 'Documento encontrado sin caja física registrada' : 'Cargo encontrado sin caja física registrada'))}</strong>
          <span class="req4-box-meta">Cargos ${html((box.cargos || []).join(', '))}${box.ubicacion ? ` · ${html(box.ubicacion)}` : ''}</span>
          <span class="req4-box-state ${canRequest(box) ? 'is-available' : ''}">${html(box.estado === 'Caja solicitada' ? 'Por solicitud en la hoja de envíos' : box.estado)}</span>
          ${box.prestamo ? `<span class="req4-unavailable">Solicitud a IM activa ${html(box.prestamo)}</span>`
            : box.estado === 'Caja solicitada' ? '<span class="req4-unavailable">Sin préstamo activo · Pendiente de reenvío a Iron Mountain</span>'
              : box.clave && !canRequest(box) ? '<span class="req4-unavailable">Solicitud disponible cuando se confirme el envío a Iron Mountain</span>' : ''}
        </div>
        ${canRequest(box) ? `<button type="button" class="link" data-req-select="${index}"${selected.has(box.clave) ? ' disabled' : ''}>${selected.has(box.clave) ? 'Agregada' : 'Agregar'}</button>` : ''}
      </li>`).join('')}</ul>` : `<p>${isPreview
        ? 'No hubo coincidencias en los datos disponibles de la Preview. Prueba con el código completo.'
        : 'No se encontró ese cargo, documento o código de caja.'}</p>`;
    } catch (error) {
      if (epoch === searchEpoch) container.textContent = error.message;
    }
  }
  find('Search').addEventListener('click', search);
  find('Query').addEventListener('keydown',event => {
    if (event.key === 'Enter') { event.preventDefault(); void search(); }
  });

  async function write(data,status) {
    if (!allowed() || busy) return null;
    busy = true;
    form.setAttribute('aria-busy','true');
    find('Submit').disabled = true;
    root.querySelectorAll('[data-req-kind]').forEach(tab => { tab.disabled = true; });
    const actor = context().id;
    status.textContent = 'Guardando…';
    const signature = JSON.stringify(data);
    if (pending?.signature !== signature) pending = {signature,id:crypto.randomUUID()};
    try {
      const saved = await repository.requestAction(pending.id, 'crear', data);
      if (actor !== context().id) return null;
      pending = null;
      status.textContent = receptionEnabled && data.tipo==='nuevas' ? `${saved.numero} registrada. Continúa en Control de cajas cuando llegue el suministro.` : `${saved.numero} guardado en el aplicativo. Consolidación en Excel pendiente.`;
      rows = [...rows.filter(row=>row.id!==saved.id),saved];
      renderAvailability();
      await refresh().catch(() => { status.textContent += ' Actualiza para consultar el registro.'; });
      if (actor !== context().id) return null;
      return saved;
    } catch(error) {
      if (actor !== context().id) return null;
      if (error.hint === 'req4_suministro_pendiente') {
        supplyRejected = true;
        renderAvailability();
        await refresh().catch(() => {});
      }
      if (error.hint === 'req4_envio_pendiente' && selected.has(error.details)) {
        const box = selected.get(error.details);
        selected.set(box.clave,{...box,solicitable:false});
        const index = results.findIndex(result=>result.clave===box.clave);
        find('Results').querySelector(`[data-req-select="${index}"]`)?.remove();
        results = results.map(result=>result.clave===box.clave ? {...result,solicitable:false} : result);
        renderSelection();
      }
      status.textContent = error.message;
      return null;
    } finally {
      busy = false;
      form.removeAttribute('aria-busy');
      renderAvailability();
      root.querySelectorAll('[data-req-kind]').forEach(tab => { tab.disabled = !allowed(); });
    }
  }
  form.addEventListener('submit',async event => {
    event.preventDefault();
    if (busy || !allowed()) return;
    const loan = kind.value === 'prestamo';
    const status = find('Status');
    const count = Number(qty.value);
    if (!loan && (supplyAvailability(rows,tracking).blocked || supplyRejected)) {
      status.textContent = supplyBlockedMessage;
      renderAvailability();
      return;
    }
    if (loan && selected.size === 0) { status.textContent = 'Agrega al menos una caja.'; return; }
    if (loan && [...selected.values()].some(box=>!canRequest(box))) {
      status.textContent = 'Retira las cajas no disponibles o vuelve a buscarlas para actualizar su estado.';
      return;
    }
    if (!loan && (!Number.isInteger(count) || count < 1 || count > 100)) {
      status.textContent = 'Ingresa entre 1 y 100 cajas enteras.'; return;
    }
    const data = loan ? {tipo:'prestamo',cajas:[...selected.values()].map(box=>box.codigo)}
      : {tipo:'nuevas',cantidad:count};
    if (await write(data,status)) {
      if (loan) {
        searchEpoch++;
        selected.clear();
        results = [];
        find('Results').textContent = '';
        find('Query').value = '';
        renderSelection();
      } else qty.value = '';
      find('Steps').innerHTML = procedure(kind.value,steps[kind.value].length - 1);
    }
  });

  function receiptHistory(row,receipt) {
    const total=Number(row.cantidadCajas), read=Number(receipt?.leidas||0), status=receiptStatus(receipt||{});
    const movements=(tracking?.movimientos||[]).filter(item=>item.requerimiento===row.id &&
      ['recepcion_parcial','recepcion_completa'].includes(item.tipo));
    const labels={
      'recepcion_parcial':['Guardado parcial de recepción','Parcial'],
      'recepcion_completa':['Recepción completa','Completa']
    };
    const events=[{title:'Solicitud de cajas nuevas',description:total+' cajas solicitadas',stamp:row.createdAt||receipt?.creada,tone:'request',label:'Solicitud'},
      ...movements.map(event=>({
        title:labels[event.tipo][0],description:event.datos.cantidad+' de '+total+' cajas verificadas',
        stamp:event.registrado,tone:event.tipo==='recepcion_completa'?'complete':'pending',label:labels[event.tipo][1]
      }))];
    const lastPartial=movements.filter(event=>event.tipo==='recepcion_parcial').at(-1);
    const tone=receipt?.confirmada?'complete':'pending';
    return `<article class="req-reception-detail">
      <div class="req-reception-info" data-state="${tone}">
        <div><strong>${html(status)}: ${read ? read+'/'+total+' cajas recepcionadas' : total+' cajas'}</strong>
          <span>${html(row.numero)} · ${html(row.usuario)} · Solicitada el ${html(receptionTime(row.createdAt||receipt?.creada))}</span></div>
        <div><span>Acondicionadas: ${Number(receipt?.acondicionadas||0)}/${total}</span>
          ${lastPartial?`<span>Último guardado parcial: ${html(receptionTime(lastPartial.registrado))}</span>`:''}</div>
      </div>
      <progress class="req-reception-progress" data-state="${read===total?'complete':'pending'}" value="${read}" max="${total}" aria-label="Progreso de recepción de ${html(row.numero)}"></progress>
      <h3 class="req4-history-heading">Historial de movimientos</h3>
      <ol class="req-reception-timeline">${events.map(event=>`<li data-state="${event.tone}">
        <div><strong>${html(event.title)}</strong><span>${html(event.description)}</span></div>
        <span class="req-reception-event-label">${html(event.label)}</span><time>${html(receptionTime(event.stamp))}</time>
      </li>`).join('')}</ol>
    </article>`;
  }

  function showCards(key) {
    if (!allowed()) return;
    const supply = key === 'nuevas';
    const list = rows.filter(row=>row.tipo===REQ_TYPES[supply ? 0 : 1]);
    const total = list.reduce((sum,row)=>sum + Number(row.cantidadCajas),0);
    const active = list.filter(row=>supply
      ? tracking?.suministro?.solicitudes?.find(item=>item.id===row.id)?.pendientes !== 0
      : row.estadoV4 !== 'Devuelto' && !row.fechaDevolucion).length;
    const activeLabels = supply ? ['solicitud pendiente','solicitudes pendientes'] : ['solicitud activa','solicitudes activas'];
    find('DialogTitle').textContent = supply ? 'Cajas para acondicionar' : kinds.prestamo;
    find('DialogIntro').textContent = supply ? 'Solicitudes de cajas nuevas' : 'Consulta las cajas solicitadas a Iron Mountain.';
    const receipts=tracking?.suministro?.solicitudes||[];
    const latest=receipts.at(-1);
    find('DialogBody').innerHTML = `
      <div class="req4-request-summary${supply&&receptionEnabled?' req-reception-summary':''}">
        <div><strong>${total}</strong><span>${total === 1 ? 'caja solicitada' : 'cajas solicitadas'}</span></div>
        <div><strong>${active}</strong><span>${activeLabels[active === 1 ? 0 : 1]}</span></div>
        ${supply&&receptionEnabled?`<div><span>Estado actual</span><strong>${html(latest?receiptStatus(latest):'Sin solicitudes')}</strong></div>`:''}
      </div>
      ${list.length ? supply&&receptionEnabled
        ? [...list].reverse().map(row=>receiptHistory(row,receipts.find(item=>item.id===row.id))).join('')
        : `<div class="req4-request-list" role="list">${detailsList(list,tracking,supply)}</div>`
        : '<p class="req4-empty">Sin requerimientos registrados.</p>'}
      ${supply && supplyAvailability(rows,tracking).blocked ? `<div class="req4-supply-lock"><strong>${supplyBlockedMessage}</strong><p>${receptionEnabled ? 'Las nuevas solicitudes se habilitan al completar el acondicionamiento de las cajas anteriores.' : 'Disponible cuando se complete el envío a IM de las cajas pendientes.'}</p></div>` : ''}`;
    delete find('DialogBody').dataset.row;
    cardView = key;
    find('DialogStatus').textContent = '';
    if (!dialog.open) dialog.showModal();
  }

  function show(row) {
    if (!allowed() || !row) return;
    const boxes = tracking?.cajas.filter(box=>box.requerimiento===row.id) || [];
    const supply = row.tipo === REQ_TYPES[0];
    const key = supply ? 'nuevas' : 'prestamo';
    cardView = null;
    find('DialogTitle').textContent = row.numero;
    find('DialogIntro').textContent = 'Consulta de la solicitud';
    find('DialogBody').innerHTML = `${procedure(key,steps[key].length - 1)}
      <p><strong>${html(kinds[key])}</strong> · ${html(row.estadoV4)}</p>
      <dl class="prepared-im-fields">
        <div><dt>Fecha de solicitud</dt><dd>${fmtDate(row.fechaSolicitud)}</dd></div>
        <div><dt>Solicitante</dt><dd>${html(row.usuario)}</dd></div>
        <div><dt>Cajas solicitadas</dt><dd>${Number(row.cantidadCajas)}</dd></div>
      </dl>
      ${supply ? receptionEnabled ? receiptHistory(row,tracking?.suministro?.solicitudes?.find(item=>item.id===row.id)) : '' : `<h3 class="req4-history-heading">Cajas de la solicitud</h3>
        <ul>${boxes.map(box => `<li><strong>${html(box.codigo)}</strong> · cargos ${html(box.cargos.join(', '))}</li>`).join('')}</ul>`}`;
    find('DialogBody').dataset.row = row.id;
    if (!dialog.open) { find('DialogStatus').textContent = ''; dialog.showModal(); }
  }

  function handleClick(event) {
    const button = event.target.closest('button');
    if (!button || !allowed()) return;
    const d = button.dataset;
    if ('reqClose' in d) { dialog.close(); return; }
    if (busy) return;
    if ('reqKind' in d) { selectKind(d.reqKind); return; }
    if ('reqSelect' in d) {
      const box = results[Number(d.reqSelect)];
      if (canRequest(box) && !selected.has(box.clave)) {
        selected.set(box.clave,box);
        button.textContent = 'Agregada';
        button.disabled = true;
        renderSelection();
      }
    }
    if ('reqRemove' in d) {
      selected.delete(d.reqRemove);
      const index = results.findIndex(box => box.clave === d.reqRemove);
      const add = find('Results').querySelector(`[data-req-select="${index}"]`);
      if (add) { add.textContent = 'Agregar'; add.disabled = false; }
      renderSelection();
    }
    if ('reqOpen' in d) show(rows.find(row=>row.id===d.reqOpen));
  }
  root.addEventListener('click',handleClick);
  dialog.addEventListener('click',handleClick);

  return {
    get kind() { return kind.value; },
    update(records,detail) {
      const current = context();
      if (viewer !== current.id) {
        const resetKind = kind.value !== 'nuevas';
        viewer = current.id;
        searchEpoch++;
        pending = null;
        supplyRejected = false;
        cardView = null;
        selected.clear();
        find('Results').textContent = '';
        find('Query').value = '';
        find('Status').textContent = '';
        qty.value = '';
        kind.value = 'nuevas';
        changeKind();
        if (resetKind) onKindChange('nuevas');
        dialog.close();
        renderSelection();
      }
      rows = records;
      tracking = detail;
      if (detail?.suministro) supplyRejected = false;
      if (dialog.open) {
        if (cardView) showCards(cardView);
        else if (find('DialogBody').dataset.row) show(rows.find(row=>row.id===find('DialogBody').dataset.row));
      }
      form.hidden = !current.allowed;
      find('Date').value = limaDate();
      find('User').value = current.name || '';
      renderAvailability();
    },
    show(id) { show(rows.find(row=>row.id===id)); },
    showCard: showCards
  };
}
