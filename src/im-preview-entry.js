import {setupRequirements} from './requirements-ui.js';
import {REQ_TYPES,limaDate} from './rules.js';

// Fixture local de la preview: nunca consulta ni modifica Supabase o Excel.
const EXAMPLE_BOXES=Object.freeze([
  {clave:'preview-t45',codigo:'T00045',cargos:['300'],ubicacion:'Iron Mountain',
    estado:'Enviado a IM',solicitable:true,prestamo:null},
  {clave:'preview-td46',codigo:'TD00046',cargos:['301'],ubicacion:'Iron Mountain',
    estado:'Enviado a IM',solicitable:true,prestamo:null},
  {clave:'preview-p78',codigo:'P00078',cargos:['302'],ubicacion:'Iron Mountain',
    estado:'Enviado a IM',solicitable:true,prestamo:null}
]);

export function mountImRequestPreview(doc=document){
  const root=doc.getElementById('req4Workspace');
  if(!root)throw Error('No se encontró el panel de vista previa IM.');
  const url=new URL(doc.defaultView.location.href);
  if(url.searchParams.get('reqMail')!=='im'){
    url.searchParams.set('reqMail','im');
    doc.defaultView.history.replaceState(null,'',url.pathname+url.search+url.hash);
  }
  const context=()=>({
    allowed:true,mailAccess:true,mailPreviewMode:true,
    id:'simulacion-im-lectura',name:'Vista previa'
  });
  let simulatedNumber=0;
  const repository={
    pickupMailConfig:async()=>null,
    requirementsMail:async()=>({estado:'NO_ENVIADO'}),
    requestBoxes:async query=>{
      const q=String(query||'').trim().toUpperCase();
      return EXAMPLE_BOXES.filter(box=>box.codigo.toUpperCase().includes(q));
    },
    // Simulación local de guardado: devuelve el mismo formato del aplicativo,
    // sin conectar a Supabase y sin enviar ningún correo.
    requestAction:async(id,action,data)=>{
      if(action!=='crear'||data.tipo!=='prestamo'||!Array.isArray(data.cajas)||!data.cajas.length)
        throw Error('Selecciona cajas para simular una solicitud a IM.');
      return {
        id,numero:'DEMO-IM-'+String(++simulatedNumber).padStart(3,'0'),
        tipo:REQ_TYPES[1],cantidadCajas:data.cajas.length,
        usuario:'Vista previa',fechaSolicitud:limaDate(),estadoV4:'Pendiente'
      };
    }
  };
  const ui=setupRequirements(root,{
    repository,context,refresh:async()=>{},isPreview:true
  });
  ui.update([],{cajas:[],movimientos:[],suministro:{solicitudes:[]}});
  return ui;
}

if(typeof document!=='undefined' && document.querySelector('#req4Workspace[data-im-preview]')){
  mountImRequestPreview(document);
}
