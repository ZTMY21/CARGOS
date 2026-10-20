// Gráfico de barras verticales SVG para el detalle IM; sin bibliotecas externas.
export function renderImBarChart(container,labels,values,{accent='#208550',emptyLabel='Sin envíos registrados'}={}){
  container.replaceChildren();
  const W=640,H=318,L=55,R=621,T=39,B=270;
  const visible=values.map((value,i)=>Number.isFinite(value)?{value,i}:null).filter(Boolean);
  const max=Math.max(0,...visible.map(point=>point.value));
  const ns='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  svg.setAttribute('role','img');
  svg.setAttribute('aria-label','Gráfico de barras de cargos enviados a Iron Mountain');
  const add=(parent,tag,attributes={},content)=>{
    const e=document.createElementNS(ns,tag);
    for(const [k,v] of Object.entries(attributes))e.setAttribute(k,String(v));
    if(content!==undefined)e.textContent=String(content);
    parent.append(e);return e;
  };
  const fmt=value=>Number(value).toLocaleString('es-PE');
  const niceStep=(value)=>{
    const power=Math.pow(10,Math.floor(Math.log10(value)));
    return ([1,2,2.5,5,10].find(k=>k*power>=value)||10)*power;
  };
  const step=niceStep(Math.max(1,max/4));
  const ceiling=Math.max(step,Math.ceil(max/step)*step);
  const y=value=>B-(B-T)*value/ceiling;
  for(let i=0;i<=4;i++){
    const value=ceiling*i/4,yy=y(value);
    add(svg,'line',{x1:L,y1:yy,x2:R,y2:yy,stroke:'#e6ebf0','stroke-width':1});
    add(svg,'text',{x:L-9,y:yy+4,'text-anchor':'end','font-size':11,fill:'#8493a3'},fmt(Math.round(value)));
  }
  const span=(R-L)/Math.max(1,labels.length),width=Math.min(46,span*.61);
  const tip=document.createElement('div');
  tip.className='im-shipped-tooltip';tip.hidden=true;
  const showTip=(i,v,cx,cy)=>{
    tip.textContent=`${labels[i]}: ${fmt(v)} cargos enviados`;
    tip.style.left=`${100*cx/W}%`;
    tip.style.top=`${100*cy/H}%`;
    tip.hidden=false;
  };
  visible.forEach(({value,i})=>{
    const center=L+span*(i+.5),barH=Math.max(value>0?3:0,B-y(value));
    const group=add(svg,'g',{tabindex:0,'aria-label':`${labels[i]}: ${fmt(value)} cargos enviados`});
    if(value>0)add(group,'rect',{x:center-width/2,y:B-barH,width,height:barH,rx:Math.min(5,width/5),fill:accent});
    add(group,'rect',{x:center-span*.44,y:T,width:span*.88,height:B-T,fill:'transparent'});
    add(group,'title',{},`${labels[i]}: ${fmt(value)} cargos enviados`);
    if(value>0)add(group,'text',{x:center,y:Math.max(T-9,B-barH-9),
      'text-anchor':'middle','font-size':11,'font-weight':800,fill:'#176b47'},fmt(value));
    const on=()=>showTip(i,value,center,Math.max(T+32,y(value)));
    group.addEventListener('mouseenter',on);
    group.addEventListener('focus',on);
    group.addEventListener('click',on);
    group.addEventListener('mouseleave',()=>{tip.hidden=true;});
    group.addEventListener('blur',()=>{tip.hidden=true;});
  });
  labels.forEach((label,i)=>{
    const center=L+span*(i+.5);
    add(svg,'text',{x:center,y:B+23,'text-anchor':'middle','font-size':labels.length>10?10:11,fill:'#64778a'},label);
  });
  if(max===0){
    add(svg,'text',{x:(L+R)/2,y:(T+B)/2,'text-anchor':'middle','font-size':13,
      'font-weight':700,fill:'#64748b'},emptyLabel);
  }
  container.append(svg,tip);
}
