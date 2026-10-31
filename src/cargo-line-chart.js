// Gráfico SVG sin dependencias. Se utiliza únicamente en la ventana «Ver detalle».
export function renderCargoLineChart(surface,legend,categories,lines,{showLabels=false}={}){
  surface.replaceChildren();
  legend.replaceChildren();
  const W=960,H=360,L=62,R=930,T=40,B=294;
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
      add(svg,'rect',{x:X(i)-width/2,y:T-15,width,height:B-T+16,fill:'#f7f9fb'});
    }
  });
  for(let mark=0;mark<=ceiling+0.00001;mark+=step){
    const cy=Y(mark);
    add(svg,'line',{x1:L,y1:cy,x2:R,y2:cy,stroke:'#dae5ee','stroke-width':1,'stroke-dasharray':'4 5'});
    add(svg,'text',{x:L-10,y:cy+4,'text-anchor':'end','font-size':12,fill:'#77899a'},fmt(mark));
  }
  categories.forEach((category,i)=>add(svg,'text',{
    x:X(i),y:B+28,'text-anchor':'middle','font-size':12,'font-weight':600,fill:'#66798b'
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
      const group=add(svg,'g',{tabindex:0,'aria-label':`${line.label}, ${categories[i]}: ${fmt(value)} cargos`});
      add(group,'circle',{cx,cy,r:12,fill:'transparent'});
      add(group,'circle',{cx,cy,r:showLabels?4.7:4,fill:'#fff',stroke:line.color,'stroke-width':2.8});
      add(group,'title',{},`${line.label} · ${categories[i]}: ${fmt(value)} cargos`);
      if(showLabels)add(group,'text',{
        x:cx,y:Math.max(T-8,cy-13),'text-anchor':'middle','font-size':12,'font-weight':800,fill:line.color
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
      group.addEventListener('click',showTip);
    }
    const legendItem=document.createElement('span');legendItem.className='monthly-created-legend-item';
    const swatch=document.createElement('span');swatch.className='monthly-created-swatch';
    swatch.style.backgroundColor=line.color;
    legendItem.append(swatch,document.createTextNode(line.label));
    legend.append(legendItem);
  }
  surface.append(svg,tip);
}
