// Gráfico SVG sin dependencias. Se utiliza únicamente en la ventana «Ver detalle».
export function renderCargoLineChart(surface,legend,categories,lines,{showLabels=false,width=960,height=360,fontSize=12,highlightIndex=null,compactLayout=false,onPointSelect=null}={}){
  surface.replaceChildren();
  legend.replaceChildren();
  const W=Math.max(640,width),H=Math.max(340,height);
  const responsive=width!==960 || height!==360;
  // Mayor margen interior para que puntos, leyendas y números no toquen los bordes.
  // La ventana histórica conserva su geometría original (responsive === false).
  const L=compactLayout?Math.max(83,Math.round(W*.07)):responsive?Math.max(94,Math.round(W*.082)):62;
  const R=compactLayout?W-Math.max(67,Math.round(W*.057)):responsive?W-Math.max(84,Math.round(W*.075)):930;
  const T=compactLayout?Math.max(58,Math.round(H*.11)):responsive?Math.max(88,Math.round(H*.13)):40;
  const B=compactLayout?H-Math.max(62,Math.round(H*.115)):responsive?H-Math.max(101,Math.round(H*.16)):294;
  const numbers=lines.flatMap(line=>line.values).filter(value=>Number.isFinite(value));
  const max=Math.max(1,...numbers);
  const scale=Math.pow(10,Math.floor(Math.log10(max/5)));
  const step=([1,2,2.5,5,10].find(k=>k*scale>=max/5)||10)*scale;
  const ceiling=Math.ceil(max/step)*step;
  const X=i=>L+(R-L)*(categories.length===1?0.5:i/(categories.length-1));
  const Y=v=>B-(B-T)*v/ceiling;
  const NS='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(NS,'svg');
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  svg.setAttribute('role','img');
  svg.setAttribute('aria-label','Gráfico de líneas de cargos por periodo');
  const add=(parent,tag,attributes={},label)=>{
    const el=document.createElementNS(NS,tag);
    for(const [key,value] of Object.entries(attributes))el.setAttribute(key,String(value));
    if(label!==undefined)el.textContent=String(label);
    parent.append(el);return el;
  };
  const fmt=value=>Number(value).toLocaleString('es-PE');
  categories.forEach((name,i)=>{
    if(i%2 && categories.length>1){
      const width=(R-L)/(categories.length-1);
      add(svg,'rect',{x:X(i)-width/2,y:T-15,width,height:B-T+16,
        fill:responsive?'#fbfcfe':'#f7f9fb'});
    }
  });
  // Vista individual: destacar el mes elegido sin recortar el resto del año.
  const highlighted=Number.isInteger(highlightIndex) && highlightIndex>=0 && highlightIndex<categories.length;
  if(highlighted){
    const spacing=(R-L)/Math.max(1,categories.length-1);
    const bandLeft=Math.max(L-8,X(highlightIndex)-spacing*.42);
    const bandRight=Math.min(R+8,X(highlightIndex)+spacing*.42);
    add(svg,'rect',{x:bandLeft,y:T-15,width:bandRight-bandLeft,height:B-T+16,
      rx:6,fill:'#fff0f3'});
  }
  for(let mark=0;mark<=ceiling+0.00001;mark+=step){
    const cy=Y(mark);
    add(svg,'line',{x1:L,y1:cy,x2:R,y2:cy,stroke:responsive?'#e6edf3':'#dae5ee','stroke-width':1,'stroke-dasharray':'4 6'});
    add(svg,'text',{x:L-10,y:cy+4,'text-anchor':'end','font-size':fontSize,fill:'#77899a'},fmt(mark));
  }
  if(highlighted){
    add(svg,'line',{x1:X(highlightIndex),x2:X(highlightIndex),y1:T-3,y2:B,
      stroke:'#c6253e','stroke-width':1.5,'stroke-dasharray':'5 5',opacity:.52});
  }
  categories.forEach((category,i)=>add(svg,'text',{
    x:X(i),y:B+28,'text-anchor':'middle','font-size':fontSize,
    'font-weight':highlighted&&i===highlightIndex?850:600,
    fill:highlighted&&i===highlightIndex?'#b71f34':'#66798b'
  },category));
  const tip=document.createElement('div');
  tip.className='monthly-created-chart-tooltip';tip.hidden=true;
  const hideTip=()=>{tip.hidden=true;};
  for(const line of lines){
    const valid=line.values.map((value,i)=>Number.isFinite(value)?[X(i),Y(value),value,i]:null);
    let part=[];
    const flush=()=>{
      if(part.length>1)add(svg,'polyline',{
        points:part.map(p=>p.slice(0,2).join(',')).join(' '),
        fill:'none',stroke:line.color,'stroke-width':line.width||2.8,
        'stroke-linecap':'round','stroke-linejoin':'round',opacity:.95
      });
      part=[];
    };
    for(const p of valid){if(p)part.push(p);else flush();}
    flush();
    for(const p of valid){
      if(!p)continue;
      const [cx,cy,value,i]=p;
      const selectable=typeof onPointSelect==='function' && lines.length===1;
      const group=add(svg,'g',{tabindex:0,
        ...(selectable?{'role':'button','data-selectable-month':String(i+1)}:{}),
        'aria-label':`${line.label}, ${categories[i]}: ${fmt(value)} cargos`+
          (selectable?' · seleccionar este mes':'')});
      const pointSelected=highlighted && i===highlightIndex && lines.length===1;
      add(group,'circle',{cx,cy,r:pointSelected?20:12,fill:'transparent'});
      if(pointSelected)add(group,'circle',{cx,cy,r:13,fill:'#ffe4e9',stroke:'#eaa5b0','stroke-width':1.6});
      add(group,'circle',{cx,cy,r:pointSelected?7.5:showLabels?5.3:4,
        fill:pointSelected?line.color:'#fff',stroke:pointSelected?'#fff':line.color,'stroke-width':pointSelected?2.8:3});
      add(group,'title',{},`${line.label} · ${categories[i]}: ${fmt(value)} cargos`);
      if(showLabels && (showLabels!=='positive' || value>0))add(group,'text',{
        x:cx,y:Math.max(T-8,cy-16),'text-anchor':'middle','font-size':fontSize,'font-weight':800,fill:line.color
      },fmt(value));
      const showTip=()=>{
        tip.textContent=`${line.label} · ${categories[i]}: ${fmt(value)} cargos`;
        tip.style.left=`${cx/W*100}%`;
        tip.style.top=`${(cy+2)/H*100}%`;
        tip.hidden=false;
      };
      group.addEventListener('mouseenter',showTip);
      group.addEventListener('mouseleave',hideTip);
      group.addEventListener('focus',showTip);
      group.addEventListener('blur',hideTip);
      group.addEventListener('click',()=>{
        showTip();
        if(selectable)onPointSelect(i+1);
      });
      if(selectable)group.addEventListener('keydown',event=>{
        if(event.key==='Enter'||event.key===' '){
          event.preventDefault();onPointSelect(i+1);
        }
      });
    }
    const legendItem=document.createElement('span');legendItem.className='monthly-created-legend-item';
    const swatch=document.createElement('span');swatch.className='monthly-created-swatch';
    swatch.style.backgroundColor=line.color;
    legendItem.append(swatch,document.createTextNode(line.label));
    legend.append(legendItem);
  }
  surface.append(svg,tip);
}
