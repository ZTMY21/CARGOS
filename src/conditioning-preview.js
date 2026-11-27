import './conditioning-workspace.css';
import {attachConditioningWorkspace} from './conditioning-workspace.js';

// Preview aislada: nunca inicializa Supabase ni hace solicitudes a Drive.
const group=document.getElementById('grp-acondicionamiento');
const controls=document.getElementById('grp-cajas');
const icons=[...document.querySelectorAll('svg')].find(el=>el.querySelector('#iv-box'));
const stage=document.createElement('main');
stage.className='wrap';
const banner=document.createElement('p');
banner.className='notice';
banner.textContent='Vista previa de Acondicionamiento · datos ficticios. No registra cargos ni modifica Excel o Supabase.';
stage.append(banner,group);
controls.hidden=true;
document.body.replaceChildren(...(icons?[icons]:[]),stage,controls);
document.body.className='';
group.hidden=false;group.open=true;

const cargos=new Map([
  ['2024:350',{codigo:'0350',historico:true}],
  ['2025:419',{codigo:'0419'}],
  ['2025:350',{codigo:'0350'}],
  ['2023:761',{codigo:'0761',enviado:true}],
  ['2026:880',{codigo:'0880',asignado:true}]
]);
let box=null;
const repository={
  async conditioning(action,data){
    if(action==='listar')return {nuevas:1,solicitadas:0,preparadas:Number(!!box),listado:box?[box]:[]};
    if(action==='estados')return box?[box]:[];
    if(action==='buscar')return box?.codigo===data.p_codigo
      ? {...box,status:'preparada'}
      : {codigo:'T9000000123',clave:'9000000123',origen:'nueva',status:'disponible'};
    if(action==='cargo'){
      const key=String(Number(String(data.p_cargos[0]).replace(/\D/g,'')));
      const entry=cargos.get(data.p_anio+':'+key);
      return {status:!entry?'inexistente':entry.enviado||entry.asignado||box?.cargos.includes(entry.codigo)
        ?'no_disponible':'disponible',codigo:entry?.codigo};
    }
    if(action==='preparar'){
      box={codigo:'T9000000123',clave:'9000000123',origen:'nueva',cargos:data.p_cargos,
        anios:[...new Set(data.p_datos.anios_cargos)],cargo_anios:data.p_datos.anios_cargos,
        preparada:'2026-11-26',responsable:'Ejemplo',revision:1,sincronizada:1};
      return box;
    }
    throw Error('Operación no disponible en esta vista previa.');
  },
  async reception(){return null;},
  async conditioningExcel(action){
    if(action==='sincronizar')return {verified:true,count:0};
    throw Error('Los Excel reales no están disponibles en la vista previa.');
  }
};
const guide=document.createElement('p');
guide.className='acond-preview-guide';
guide.textContent='Prueba la caja T9000000123: histórico 0350 (2024) y normal 0419 (2025). Para probar bloqueos: 0761 (2023) ya enviado y 0880 (2026) asignado.';
group.prepend(guide);
const workspace=attachConditioningWorkspace({repository});
workspace.activate();
