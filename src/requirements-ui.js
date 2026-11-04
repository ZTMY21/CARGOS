import { escapeHtml as html, fmtDate, limaDate, REQ_TYPES } from './rules.js';

const kinds = {nuevas: REQ_TYPES[0], prestamo: 'Préstamo de cajas (búsqueda de documentos)'};
const movements = {
  crear:'Solicitud registrada', confirmar:'Confirmación del proveedor', recibir:'Recepción de cajas',
  recibir_caja:'Caja recibida', devolver_caja:'Caja devuelta'
};

function receptionStatus(row) {
  if (row.fechaRecepcion && row.tipo === REQ_TYPES[0]) return `Recibido — ${fmtDate(row.fechaRecepcion)}`;
  if (row.estadoV4 === 'Recibido parcialmente') return 'Recepción parcial';
  return row.tipo === REQ_TYPES[0] ? 'Pendiente de recepción' : row.estadoV4;
}

function detailsList(rows) {
  return rows.map(row => `<li><button class="link" type="button" data-req-open="${html(row.id)}">${html(row.numero)}</button>
    · ${fmtDate(row.fechaSolicitud)} · ${html(receptionStatus(row))}
    · ${row.recibidoV4} de ${Number(row.cantidadCajas)} cajas recibidas</li>`).join('');
}

export function requestCards(rows, tracking) {
  const supplies = rows.filter(row => row.estadoV4 && row.tipo === REQ_TYPES[0]);
  const loans = rows.filter(row => row.estadoV4 && row.tipo === REQ_TYPES[1]);
  const supplyPending = supplies.reduce((total, row) => total + Number(row.cantidadCajas) - row.recibidoV4, 0);
  const loanPending = new Set(tracking?.cajas.filter(box => !box.devolucion).map(box => box.clave)).size;
  return [['nuevas','Cajas para acondicionar',tracking ? supplyPending : '—',supplies],
          ['prestamo','Préstamos de cajas',tracking ? loanPending : '—',loans]]
      .map(([kind,title,total,records]) => {
        const last=records.at(-1);
        return `<section class="kpi kpi-color req4-card">
          <div class="expiry-card-heading">
            <div class="l">${title}</div>
            <button type="button" class="expiry-detail-button" data-req-card="${kind}" aria-label="Ver detalle de ${title}" aria-haspopup="dialog" aria-controls="req4Dialog">Ver detalle</button>
          </div>
          <div class="n">${total}</div>
          ${last ? `<p>${fmtDate(last.fechaSolicitud)} · ${html(receptionStatus(last))} · ${last.recibidoV4}/${Number(last.cantidadCajas)} recibidas</p>` : ''}
        </section>`;
      }).join('');
}

export function setupRequirements(root, {repository, context, refresh, isPreview = false}) {
  const selected = new Map();
  let rows = [], tracking = null, viewer = null, busy = false, searchEpoch = 0;
  let pending = null, redrawAfterRefresh = null;
  root.innerHTML = `
    <h3>Nuevo requerimiento</h3>
    <form id="req4Form">
      <div class="grid">
        <label class="field">Tipo de requerimiento<select id="req4Kind">
          <option value="nuevas">${kinds.nuevas}</option><option value="prestamo">${kinds.prestamo}</option>
        </select></label>
        <label class="field">Fecha de solicitud<input id="req4Date" type="date" readonly></label>
        <label class="field">Usuario solicitante<input id="req4User" readonly></label>
        <label class="field" id="req4QtyWrap">Cantidad de cajas<input id="req4Qty" type="number" min="1" max="100" step="1" required></label>
        <label class="field" id="req4ReceiptWrap">Fecha de recepción<input type="date" readonly></label>
      </div>
      <section id="req4Loan" hidden>
        <label class="field">Buscar por cargo, factura, guía, boleta o código de caja<input id="req4Query" type="search" maxlength="120"></label>
        <button id="req4Search" type="button" class="secondary">Buscar</button>
        <div id="req4Results" aria-live="polite"></div>
        <h4>Cajas seleccionadas</h4><div id="req4Selected" aria-live="polite"></div>
      </section>
      <div class="actions"><button type="submit">Guardar requerimiento</button>
        <span id="req4Status" role="status"></span></div>
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
    find('Selected').innerHTML = selected.size ? `<ul>${[...selected.values()].map(box => `<li>
      <strong>${html(box.codigo)}</strong> · cargos ${html(box.cargos.join(', '))}
      ${!canRequest(box) ? ' · No disponible para préstamo' : ''}
      <button class="link" data-req-remove="${html(box.clave)}" type="button">Retirar</button>
    </li>`).join('')}</ul>` : '<p>Agrega las cajas que deseas solicitar.</p>';
  }
  function changeKind() {
    const loan = kind.value === 'prestamo';
    find('Loan').hidden = !loan;
    find('QtyWrap').hidden = find('ReceiptWrap').hidden = loan;
    qty.disabled = loan;
    qty.required = !loan;
  }
  kind.addEventListener('change',changeKind);
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
      container.innerHTML = found.length ? `<ul>${found.map((box,index) => `<li>
        <strong>${html(box.codigo || (box.tipo === 'documento' ? 'Documento encontrado sin caja física registrada' : 'Cargo encontrado sin caja física registrada'))}</strong> · ${html(box.estado === 'Caja solicitada' ? 'Por solicitud en la hoja de envíos' : box.estado)}
        ${box.ubicacion ? ` · ${html(box.ubicacion)}` : ''} · cargos ${html((box.cargos || []).join(', '))}
        ${box.prestamo ? ` · Préstamo activo ${html(box.prestamo)}`
          : canRequest(box) ? `<button type="button" class="link" data-req-select="${index}">Solicitar</button>`
            : box.estado === 'Caja solicitada' ? ' · Sin préstamo activo · Pendiente de reenvío a Iron Mountain'
              : box.clave ? ' · Solicitud disponible cuando se confirme el envío a Iron Mountain' : ''}
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

  async function write(action,data,status) {
    if (!allowed() || busy) return null;
    busy = true;
    const actor = context().id;
    status.textContent = 'Guardando…';
    const signature = JSON.stringify([action,data]);
    if (pending?.signature !== signature) pending = {signature,id:crypto.randomUUID()};
    try {
      const saved = await repository.requestAction(pending.id, action, data);
      if (actor !== context().id) return null;
      pending = null;
      status.textContent = `${saved.numero} guardado en el aplicativo. Consolidación en Excel pendiente.`;
      rows = [...rows.filter(row=>row.id!==saved.id),saved];
      if (data.caja && tracking) {
        const field = action === 'recibir_caja' ? 'recepcion' : 'devolucion';
        tracking = {...tracking,cajas:tracking.cajas.map(box=>box.requerimiento===saved.id && box.codigo===data.caja
          ? {...box,[field]:data.fecha} : box)};
      }
      if (action !== 'crear') redrawAfterRefresh = saved.id;
      void refresh().catch(() => { status.textContent += ' Actualiza para consultar el registro.'; });
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
    } finally { busy = false; }
  }
  form.addEventListener('submit',async event => {
    event.preventDefault();
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
    if (await write('crear',data,status)) {
      qty.value = '';
      selected.clear();
      renderSelection();
    }
  });

  function show(row) {
    if (!allowed() || !row) return;
    const boxes = tracking?.cajas.filter(box=>box.requerimiento===row.id) || [];
    const log = tracking?.movimientos.filter(movement=>movement.requerimiento===row.id) || [];
    const supply = row.tipo === REQ_TYPES[0];
    const pendingBoxes = Number(row.cantidadCajas) - row.recibidoV4;
    find('DialogTitle').textContent = row.numero;
    find('DialogBody').innerHTML = `<p><strong>${html(row.tipo)}</strong> · ${html(row.estadoV4)}</p>
      <p>${fmtDate(row.fechaSolicitud)} · ${html(row.usuario)} · ${row.recibidoV4} de ${Number(row.cantidadCajas)} cajas recibidas</p>
      ${row.fechaRecepcion ? `<p>Fecha de recepción ${fmtDate(row.fechaRecepcion)}</p>` : ''}
      ${row.confirmadoV4 ? `<p>Confirmación del proveedor ${fmtDate(row.confirmadoV4)}</p>` : ''}
      <label class="field">Fecha del movimiento<input id="req4MoveDate" type="date" min="${html(row.fechaSolicitud)}" max="${limaDate()}" value="${limaDate()}"></label>
      ${supply ? `
        <div class="actions">
          ${row.confirmadoV4 ? '' : '<button type="button" data-req-action="confirmar">Registrar confirmación</button>'}
          ${pendingBoxes > 0 ? `<label class="field">Cantidad recibida<input id="req4MoveQty" type="number" min="1" max="${pendingBoxes}" step="1"></label>
            <button type="button" data-req-action="recibir">Registrar recepción</button>` : ''}
          <button class="secondary" type="button" data-req-draft>Preparar correo de solicitud</button>
        </div>
        <div id="req4Draft"></div>`
      : `<ul>${boxes.map(box => `<li><strong>${html(box.codigo)}</strong> · cargos ${html(box.cargos.join(', '))}
        · ${box.recepcion ? `Recibida ${fmtDate(box.recepcion)}` : 'Pendiente de recepción'}
        ${box.devolucion ? ` · Devuelta ${fmtDate(box.devolucion)}`
          : `<button class="link" type="button" data-req-action="${box.recepcion?'devolver_caja':'recibir_caja'}" data-caja="${html(box.codigo)}">${box.recepcion?'Registrar devolución':'Registrar recepción'}</button>`}
      </li>`).join('')}</ul>`}
      <h3>Historial</h3>
      <ul>${log.map(movement => `<li>${fmtDate(movement.fecha)} · ${html(movements[movement.tipo])}
        ${movement.datos.cantidad ? ` (${Number(movement.datos.cantidad)} cajas)` : ''}
        ${movement.datos.caja ? ` · ${html(movement.datos.caja)}` : ''} · ${html(movement.responsable)}</li>`).join('')}</ul>`;
    find('DialogBody').dataset.row = row.id;
    if (!dialog.open) { find('DialogStatus').textContent = ''; dialog.showModal(); }
  }

  async function handleClick(event) {
    const button = event.target.closest('button');
    if (!button || !allowed()) return;
    const d = button.dataset;
    if ('reqClose' in d) dialog.close();
    if ('reqSelect' in d) {
      const box = results[Number(d.reqSelect)];
      if (canRequest(box) && !selected.has(box.clave) && window.confirm(`¿Deseas solicitar esta caja?\nCódigo de caja: ${box.codigo}`)) {
        selected.set(box.clave,box);
        renderSelection();
      }
    }
    if ('reqRemove' in d) { selected.delete(d.reqRemove); renderSelection(); }
    if ('reqOpen' in d) show(rows.find(row=>row.id===d.reqOpen));
    const row = rows.find(item=>item.id===find('DialogBody').dataset.row);
    if (!row) return;
    if ('reqDraft' in d) {
      const draft = find('Draft');
      draft.innerHTML = '<label class="field">Borrador de correo<textarea readonly rows="8"></textarea></label>';
      draft.querySelector('textarea').value = `Asunto: ${row.numero} · Solicitud de cajas para acondicionar\n\nBuen día,\n\nSolicito ${row.cantidadCajas} cajas nuevas para acondicionamiento en el CD Santa Anita.\nRequerimiento ${row.numero} del ${fmtDate(row.fechaSolicitud)}.\n\nSaludos,\n${row.usuario}\nCD Santa Anita`;
      draft.querySelector('textarea').select();
    }
    if ('reqAction' in d) {
      const date = find('MoveDate');
      const count = find('MoveQty');
      if (!date.value || !date.reportValidity()) return;
      if (d.reqAction === 'recibir' && (!count.value || !count.reportValidity())) return;
      const data = {requerimiento:row.id,fecha:date.value};
      if (d.caja) data.caja = d.caja;
      if (d.reqAction === 'recibir') data.cantidad = Number(count.value);
      const saved = await write(d.reqAction,data,find('DialogStatus'));
      if (saved && dialog.open) show(saved);
    }
  }
  root.addEventListener('click',handleClick);
  dialog.addEventListener('click',handleClick);

  return {
    update(records,detail) {
      const current = context();
      if (viewer !== current.id) {
        viewer = current.id;
        searchEpoch++;
        pending = null;
        redrawAfterRefresh = null;
        selected.clear();
        find('Results').textContent = '';
        find('Query').value = '';
        find('Status').textContent = '';
        qty.value = '';
        dialog.close();
        renderSelection();
      }
      rows = records;
      tracking = detail;
      if (redrawAfterRefresh && detail && dialog.open && find('DialogBody').dataset.row === redrawAfterRefresh) {
        const row = rows.find(item=>item.id===redrawAfterRefresh);
        const date = find('MoveDate')?.value;
        const count = find('MoveQty')?.value;
        redrawAfterRefresh = null;
        show(row);
        if (date && find('MoveDate')) find('MoveDate').value = date;
        if (count && find('MoveQty')) find('MoveQty').value = count;
      }
      form.hidden = !current.allowed;
      find('Date').value = limaDate();
      find('User').value = current.name || '';
    },
    show(id) { show(rows.find(row=>row.id===id)); },
    showCard(key) {
      if (!allowed()) return;
      const list = rows.filter(row=>row.estadoV4 && row.tipo===REQ_TYPES[key==='nuevas'?0:1]);
      find('DialogTitle').textContent = key==='nuevas' ? 'Cajas para acondicionar' : 'Préstamos de cajas';
      delete find('DialogBody').dataset.row;
      find('DialogBody').innerHTML = list.length ? `<ul>${detailsList(list)}</ul>` : '<p>Sin requerimientos registrados.</p>';
      find('DialogStatus').textContent = '';
      if (!dialog.open) dialog.showModal();
    }
  };
}
