import { escapeHtml as html, fmtDate, limaDate, REQ_TYPES } from './rules.js';

const kinds = {nuevas: 'Cajas nuevas', prestamo: 'Solicitudes a IM'};
const steps = {nuevas: ['Cantidad', 'Solicitar'], prestamo: ['Buscar', 'Seleccionar', 'Solicitar']};

function receptionStatus(row) {
  if (row.fechaRecepcion && row.tipo === REQ_TYPES[0]) return `Recibido — ${fmtDate(row.fechaRecepcion)}`;
  if (row.estadoV4 === 'Recibido parcialmente') return 'Recepción parcial';
  return row.tipo === REQ_TYPES[0] ? 'Pendiente de recepción' : row.estadoV4;
}

function detailsList(rows) {
  return rows.map(row => `<li><button class="link" type="button" data-req-open="${html(row.id)}">${html(row.numero)}</button>
    · ${fmtDate(row.fechaSolicitud)} · ${html(receptionStatus(row))}
    · ${Number(row.cantidadCajas)} ${Number(row.cantidadCajas) === 1 ? 'caja solicitada' : 'cajas solicitadas'}</li>`).join('');
}

function procedure(kind, current = 0) {
  return `<ol class="req4-steps" aria-label="Etapas del procedimiento">${steps[kind].map((label,index) =>
    `<li${index === current ? ' aria-current="step"' : ''} class="${index < current ? 'is-complete' : ''}"><span>${index + 1}</span>${label}</li>`
  ).join('')}</ol>`;
}

export function requestCards(rows, tracking) {
  const supplies = rows.filter(row => row.estadoV4 && row.tipo === REQ_TYPES[0]);
  const supplyPending = supplies.reduce((total, row) => total + Number(row.cantidadCajas) - row.recibidoV4, 0);
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

export function setupRequirements(root, {repository, context, refresh, onKindChange = () => {}, isPreview = false}) {
  const selected = new Map();
  let rows = [], tracking = null, viewer = null, busy = false, searchEpoch = 0;
  let pending = null;
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
      <div class="req4-dialog-head"><h2 id="req4DialogTitle"></h2><button class="secondary" data-req-close type="button">Cerrar</button></div>
      <div id="req4DialogBody"></div><p id="req4DialogStatus" role="status"></p>
    </dialog>`;
  const find = id => root.ownerDocument.getElementById(`req4${id}`);
  const allowed = () => context().allowed;
  const form = find('Form'), kind = find('Kind'), qty = find('Qty'), dialog = find('Dialog');
  root.ownerDocument.body.append(dialog);
  let results = [];
  const canRequest = box => !!box?.clave && box.solicitable === true && !box.prestamo;

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
      status.textContent = `${saved.numero} guardado en el aplicativo. Consolidación en Excel pendiente.`;
      rows = [...rows.filter(row=>row.id!==saved.id),saved];
      await refresh().catch(() => { status.textContent += ' Actualiza para consultar el registro.'; });
      if (actor !== context().id) return null;
      return saved;
    } catch(error) {
      if (actor !== context().id) return null;
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
      find('Submit').disabled = !allowed();
      root.querySelectorAll('[data-req-kind]').forEach(tab => { tab.disabled = !allowed(); });
    }
  }
  form.addEventListener('submit',async event => {
    event.preventDefault();
    if (busy || !allowed()) return;
    const loan = kind.value === 'prestamo';
    const status = find('Status');
    const count = Number(qty.value);
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

  function show(row) {
    if (!allowed() || !row) return;
    const boxes = tracking?.cajas.filter(box=>box.requerimiento===row.id) || [];
    const supply = row.tipo === REQ_TYPES[0];
    const key = supply ? 'nuevas' : 'prestamo';
    find('DialogTitle').textContent = row.numero;
    find('DialogBody').innerHTML = `${procedure(key,steps[key].length - 1)}
      <p><strong>${html(kinds[key])}</strong> · ${html(row.estadoV4)}</p>
      <dl class="prepared-im-fields">
        <div><dt>Fecha de solicitud</dt><dd>${fmtDate(row.fechaSolicitud)}</dd></div>
        <div><dt>Solicitante</dt><dd>${html(row.usuario)}</dd></div>
        <div><dt>Cajas solicitadas</dt><dd>${Number(row.cantidadCajas)}</dd></div>
      </dl>
      ${supply ? '' : `<h3 class="req4-history-heading">Cajas de la solicitud</h3>
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
      if (dialog.open && find('DialogBody').dataset.row) show(rows.find(row=>row.id===find('DialogBody').dataset.row));
      form.hidden = !current.allowed;
      find('Date').value = limaDate();
      find('User').value = current.name || '';
    },
    show(id) { show(rows.find(row=>row.id===id)); },
    showCard(key) {
      if (!allowed()) return;
      const list = rows.filter(row=>row.estadoV4 && row.tipo===REQ_TYPES[key==='nuevas'?0:1]);
      find('DialogTitle').textContent = key==='nuevas' ? 'Cajas para acondicionar' : kinds.prestamo;
      delete find('DialogBody').dataset.row;
      find('DialogBody').innerHTML = list.length ? `<ul class="req4-detail-list">${detailsList(list)}</ul>` : '<p>Sin requerimientos registrados.</p>';
      find('DialogStatus').textContent = '';
      if (!dialog.open) dialog.showModal();
    }
  };
}
