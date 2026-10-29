import { safeImage } from './rules.js';
import { cargoLocations } from './cargo-details.js';

const nullable = value => value === '' || value === undefined ? null : value;
export function reqFromDb(row) {
  return {
    id: row.id, numero: row.numero, tipo: row.tipo, fechaSolicitud: row.fecha_solicitud,
    cantidadCajas: row.cantidad_cajas ?? '', numerosCargo: row.numeros_cargo || '',
    fechaRecepcion: row.fecha_recepcion || '', fechaDevolucion: row.fecha_devolucion || '',
    usuario: row.usuario, updatedAt: row.updated_at
  };
}
export function docFromDb(row) {
  return {
    id: row.id, kardex: row.kardex, fechaRegistro: row.fecha_registro, tipoDoc: row.tipo_doc,
    periodo: row.periodo, ubicacion: row.ubicacion, folios: row.folios ?? '', cargos: row.cargos || [],
    cajaAsignada: row.caja_asignada || '', fEnvio: row.f_envio || '', sustento: row.sustento || '',
    sustentoImagen: safeImage(row.sustento_imagen), usuario: row.usuario,
    imConfirmado: !!row.im_confirmado, imCodigoCaja: row.im_codigo_caja || '',
    imFechaEnvio: row.im_fecha_envio || '', imResponsable: row.im_responsable || '',
    imPreparado: !!row.im_preparado, imCajaPreparada: row.im_caja_preparada || '',
    imResponsablePreparacion: row.im_responsable_preparacion || '',
    imLiveCodigoCaja: row.im_live_codigo_caja || '',
    imLiveClasificacion: row.im_live_clasificacion || '',
    imLiveFechaEnvio: row.im_live_fecha_envio || '',
    facturas: row.facturas || '', obs: row.obs || '', updatedAt: row.updated_at,
    facturasEncontradas: row.facturas_encontradas || [], cantidadFacturas: row.cantidad_facturas,
    ubicacionesCodigo: row.ubicaciones_codigo, errorUbicacion: row.error_ubicacion,
    tieneSustentoImagen: row.tiene_sustento_imagen || !!row.sustento_imagen,
    claveOrigen: row.clave_origen || '', hojaOrigen: row.hoja_origen || '',
    fechaOrigen: row.fecha_origen || '', anioOrigen: row.anio_origen,
    estadoOrigen: row.estado_origen || '', datosOrigen: row.datos_origen || {},
    importacionId: row.importacion_id, completo: 'facturas' in row
  };
}
export function reqToDb(row, importing = false) {
  const data = {
    tipo: row.tipo, fecha_solicitud: row.fechaSolicitud, cantidad_cajas: nullable(row.cantidadCajas),
    numeros_cargo: row.numerosCargo || '', fecha_recepcion: nullable(row.fechaRecepcion),
    fecha_devolucion: nullable(row.fechaDevolucion), usuario: row.usuario
  };
  if (importing) Object.assign(data, { id: row.id, numero: row.numero });
  else if (row.id) data.id = row.id;
  return data;
}
export function docToDb(row, importing = false) {
  const data = {
    tipo_doc: row.tipoDoc, periodo: nullable(row.periodo),
    ubicacion: nullable(row.ubicacion),
    folios: nullable(row.folios), cargos: row.cargos || [], caja_asignada: nullable(row.cajaAsignada),
    f_envio: nullable(row.fEnvio), sustento: row.sustento || '', sustento_imagen: row.sustentoImagen || '',
    usuario: row.usuario, facturas: row.facturas || '', obs: row.obs || ''
  };
  if (importing) Object.assign(data, {
    id: row.id, kardex: nullable(row.kardex), fecha_registro: row.fechaRegistro,
    clave_origen: nullable(row.claveOrigen), hoja_origen: row.hojaOrigen || '', fecha_origen: nullable(row.fechaOrigen),
    anio_origen: nullable(row.anioOrigen), estado_origen: row.estadoOrigen || '', datos_origen: row.datosOrigen || {}
  });
  else if (row.id) data.id = row.id;
  return data;
}
function checked(result) {
  if (result.error) throw result.error;
  return result.data;
}
export class KardexRepository {
  constructor(client) { this.client = client; this.previousQueue=Promise.resolve(); }
  async snapshot() { return checked(await this.client.rpc('kardex_snapshot')); }
  async access() { return checked(await this.client.rpc('kardex_access')); }
  async preparedImDetails() { return checked(await this.client.rpc('kardex_prepared_im_detail')); }
  async requestedIMDetails() { return checked(await this.client.rpc('kardex_requested_im_detail')); }
  async shippedIMBoxesMonthly() { return checked(await this.client.rpc('kardex_im_boxes_sent_monthly')); }
  async previousCargos(ids, {signal, onBatch=()=>{}}={}) {
    const result={};
    // Keep the RPC's 100-ID bound and serialize overlapping pages. The SQL
    // proposal optimizes a full page with a single protected catalog scan.
    const unique=[...new Set(ids)];
    for(let offset=0;offset<unique.length;offset+=100) {
      if(signal?.aborted)throw signal.reason || new DOMException('Aborted','AbortError');
      const batch=unique.slice(offset,offset+100);
      const job=this.previousQueue.then(async()=>{
        if(signal?.aborted)throw signal.reason || new DOMException('Aborted','AbortError');
        let request=this.client.rpc('kardex_previous_cargos',{p_documento_ids:batch});
        if(signal)request=request.abortSignal(signal);
        return checked(await request);
      });
      this.previousQueue=job.catch(()=>{});
      const data=await job;
      if(!data || typeof data!=='object' || Array.isArray(data)
        || batch.some(id=>!Array.isArray(data[id])))
        throw new Error('Respuesta incompleta al consultar cargos anteriores.');
      Object.assign(result,data);
      onBatch(data);
    }
    return result;
  }
  async requestAdminAccess() { return checked(await this.client.rpc('kardex_admin_apply')); }
  async pendingAdminRequests() { return checked(await this.client.rpc('kardex_admin_pending')); }
  async reviewAdminRequest(id,approved) { return checked(await this.client.rpc('kardex_admin_review',{p_id:id,p_approve:approved})); }
  async fetchDoc(id) { return docFromDb(checked(await this.client.from('documentos').select().eq('id',id).single())); }
  async fetchImage(id) { return safeImage(checked(await this.client.from('documentos').select('sustento_imagen').eq('id',id).single()).sustento_imagen); }
  async search(filters, offset=0, limit=100, signal) {
    let query=this.client.rpc('kardex_search',{
      query_text:filters.query||'',estado_filter:filters.state||'',tipo_filter:filters.type||'',
      ubicacion_filter:filters.location||'',year_filter:filters.year||'',invoice_exact:!!filters.invoiceExact,
      page_offset:offset,page_limit:limit
    });
    if(signal) query=query.abortSignal(signal);
    const result = checked(await query);
    // Load original rows only for this search page, without images or the full catalog.
    if (filters.query?.trim() && result.rows.length) {
      try {
        for (let offset=0; offset<result.rows.length; offset+=20) {
          const page=result.rows.slice(offset,offset+20);
          let request=this.client.from('documentos').select('id,datos_origen').in('id',page.map(d=>d.id));
          if(signal)request=request.abortSignal(signal);
          const sources=checked(await request);
          for(const row of page) {
            const source=sources.find(d=>d.id===row.id);
            if (!source) throw new Error('No se pudo leer el grupo');
            row.ubicaciones_codigo=await cargoLocations(source.datos_origen);
          }
        }
      } catch(error) {
        if(signal?.aborted)throw error;
        for(const row of result.rows)if(!row.ubicaciones_codigo)row.error_ubicacion='No se pudo consultar el grupo. Actualiza los datos.';
      }
    }
    return result;
  }
  async exportRows(filters) {
    const ids=[];
    for(let offset=0;;offset+=1000) {
      const result=await this.search(filters,offset,1000);
      ids.push(...result.rows.map(r=>r.id));
      if(ids.length>=result.total)break;
    }
    const docs=[];
    for(let offset=0;offset<ids.length;offset+=25) {
      const rows=checked(await this.client.from('documentos').select().in('id',ids.slice(offset,offset+25)));
      docs.push(...rows.map(docFromDb));
    }
    return docs.sort((a,b)=>b.kardex.localeCompare(a.kardex));
  }
  async saveReq(row, existing) { return this.save('requerimientos', reqToDb(row), existing, reqFromDb); }
  async saveDoc(row, existing) { return this.save('documentos', docToDb(row), existing, docFromDb); }
  async save(table, data, existing, mapper) {
    let query;
    if (existing) {
      query = this.client.from(table).update(data).eq('id', existing.id).eq('updated_at', existing.updatedAt);
    } else query = this.client.from(table).insert(data);
    const result = await query.select();
    if (!existing && result.error?.code === '23505' && data.id) {
      const previous = checked(await this.client.from(table).select().eq('id',data.id).single());
      const matches = previous && Object.keys(data).every(key => {
        const expected = ['folios','cantidad_cajas'].includes(key) && data[key] !== null ? Number(data[key]) : data[key];
        return JSON.stringify(previous[key]) === JSON.stringify(expected);
      });
      if (matches) return mapper(previous);
    }
    const rows = checked(result);
    if (!rows?.length) throw new Error('Otro usuario modificó o eliminó este registro. Recarga los datos y vuelve a editarlo.');
    return mapper(rows[0]);
  }
  async remove(table, existing) {
    const rows = checked(await this.client.from(table).delete().eq('id', existing.id)
      .eq('updated_at', existing.updatedAt).select('id'));
    if (!rows?.length) throw new Error('El registro cambió en otra pantalla. Recarga los datos antes de eliminarlo.');
  }
  async replace(reqs, docs) {
    return checked(await this.client.rpc('kardex_import', {
      requerimientos_data: reqs.map(r => reqToDb(r, true)),
      documentos_data: docs.map(d => docToDb(d, true))
    }));
  }
  async importFile(file, imported, progress=()=>{}) {
    const session=checked(await this.client.auth.getSession())?.session;
    if(!session?.user?.id) throw new Error('Inicia sesión antes de importar.');
    const bytes=await file.arrayBuffer();
    const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    const fileName=file.name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9._-]/g,'_');
    const path=`${session.user.id}/${crypto.randomUUID()}/${fileName}`;
    progress('Guardando una copia privada del Excel original…');
    checked(await this.client.storage.from('respaldos-excel').upload(path,file,{
      contentType:/\.xlsm$/i.test(file.name)?'application/vnd.ms-excel.sheet.macroEnabled.12':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      upsert:false
    }));
    const importId=checked(await this.client.rpc('kardex_begin_import',{
      archivo_nombre:file.name,archivo_path:path,archivo_sha256:sha,archivo_formato:imported.format||'kardex'
    }));
    const reqNumbers=new Map(imported.reqs.map(r=>[r.id,r.numero]));
    const records=[...imported.reqs.map(r=>({kind:'req',data:reqToDb(r,true)})),
      ...imported.docs.map(d=>({kind:'doc',data:{...docToDb(d,true),req_numero:reqNumbers.get(d.cajaAsignada)||''}}))];
    const chunks=makeImportBatches(records);
    let processed=0;
    for(let index=0;index<chunks.length;index++) {
      const chunk=chunks[index];
      checked(await this.client.rpc('kardex_stage_import',{
        import_id:importId,batch_number:index,req_data:chunk.reqs,doc_data:chunk.docs
      }));
      processed+=chunk.reqs.length+chunk.docs.length;
      progress(`Preparados ${processed.toLocaleString('es-PE')} de ${records.length.toLocaleString('es-PE')} registros…`);
    }
    progress('Confirmando la importación completa…');
    const result=checked(await this.client.rpc('kardex_commit_import',{import_id:importId,expected_batches:chunks.length}));
    return {...result,importacion_id:importId};
  }
  async reset() { return checked(await this.client.rpc('kardex_reset')); }
}

export function makeImportBatches(records,maxBytes=450000,maxRecords=200) {
  const encoder=new TextEncoder(),chunks=[];
  let chunk={reqs:[],docs:[]},size=0,count=0;
  for(const record of records) {
    const bytes=encoder.encode(JSON.stringify(record.data)).length;
    if(count&&(size+bytes>maxBytes||count>=maxRecords)) {chunks.push(chunk);chunk={reqs:[],docs:[]};size=count=0;}
    chunk[record.kind==='req'?'reqs':'docs'].push(record.data);size+=bytes;count++;
  }
  if(count)chunks.push(chunk);
  return chunks;
}
