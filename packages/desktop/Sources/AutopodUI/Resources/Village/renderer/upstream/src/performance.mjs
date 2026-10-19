// Character acting is presentation only. Every pose is a function of replay time.
export const PERFORMANCE_VERSION='acting-1';
export function performanceAt(actor,time,{motion=true}={}){
  const base={mode:'idle',animation:'idle',clock:motion?time:0,direction:null,phase:0,hop:0,nudge:0};
  if(actor.moving)return {...base,animation:'walk',mode:'travel'};
  if(actor.gathering)return {...base,direction:'down'};
  if(actor.role==='user'||actor.missingTranscript)return base;
  const s=actor.scene,active=s&&time<s.end,elapsed=Math.max(0,time-(s?.start??0)-(s?.travel??0));
  const pose=(mode,animation,period=2,direction='down')=>({...base,mode,animation,direction,phase:motion?(elapsed%period)/period:0,clock:motion?elapsed:0});
  if(actor.celebration){const cheerTime=Math.max(0,time-actor.celebration.start);return {...pose('celebrate','pose'),clock:motion?cheerTime:0,hop:motion?Math.max(0,Math.sin(cheerTime*5))*7:0};}
  if(active&&s.event.kind==='action.result'&&s.status==='failed')return {...pose('stumble',!motion||elapsed<.85?'hurt':'idle'),clock:motion?Math.min(elapsed,.18):.1,nudge:motion&&elapsed<.85?Math.sin(elapsed*22)*3*(1-elapsed/.85):0};
  if(active&&s.event.kind==='action.result'&&s.status==='completed'&&['check','build'].includes(s.activity))return {...pose('victory',!motion||elapsed<1.5?'pose':'idle'),hop:motion&&elapsed<1.5?Math.max(0,Math.sin(elapsed*Math.PI/ .75))*5:0};
  if(actor.presence?.kind==='input'&&(!active||s.event.data.waiting?.kind==='input')){
    const phase=motion?elapsed%5:0;
    return {...pose('wave',motion&&phase<1.1?'pose':'idle'),phase:motion?phase/5:0,clock:motion?phase*.5:0};
  }
  if(active&&s.event.kind.includes('message'))return base;
  if(actor.presence?.kind==='agents'&&(!active||s.event.data.waiting?.kind==='agents'))return pose('bench','sit',3);
  if(actor.resting&&actor.leisure){
    const restTime=Math.max(0,time-actor.restStartedAt),mode=actor.leisure;
    return {...base,mode,animation:'sit',direction:mode==='fish'?'downLeft':'down',clock:motion?restTime:0,phase:motion?(restTime%4)/4:0};
  }
  const working=active&&['action.start','action.poll'].includes(s.event.kind)||actor.presence?.kind==='running';
  if(!working)return base;
  const activity=actor.presence?.kind==='running'?actor.presence.activity??s?.activity:s?.activity;
  const beat=motion?elapsed%1.6:0,clock=motion?Math.min(beat,.65):.15;
  if(['edit','create'].includes(activity))return {...pose('hammer',beat<.65?'swing':'idle',1.6,'right'),clock};
  if(activity==='check')return {...pose('train',beat<.65?'attack':'idle',1.6,'right'),clock};
  if(activity==='build')return {...pose('build','nod',2),clock:motion?elapsed*.5:0};
  if(['read','search','browser','review','plan'].includes(activity))return pose(activity==='review'||activity==='plan'?'review':'read','nod',3);
  if(activity==='command')return pose('terminal','nod',2);
  return base;
}

function line(ctx,x,y,a,b,color,width=2){ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(a,b);ctx.stroke();}
function bench(ctx,color='#91613e'){
  ctx.fillStyle='#243437';ctx.fillRect(-22,-7,44,9);ctx.fillRect(-18,1,5,8);ctx.fillRect(13,1,5,8);
  ctx.fillStyle=color;ctx.fillRect(-20,-6,40,5);ctx.fillStyle='#d7ad6d';ctx.fillRect(-18,-5,36,1);
}
function book(ctx,phase,{paper=false}={}){
  const x=-15,y=-10;ctx.fillStyle='#27353b';ctx.fillRect(x-2,y-2,34,21);ctx.fillStyle=paper?'#f5e7bd':'#98775a';ctx.fillRect(x,y,30,17);
  ctx.fillStyle='#f6e9bf';ctx.fillRect(x+2,y+1,12,14);ctx.fillRect(x+16,y+1,12,14);
  line(ctx,0,y,0,y+16,'#a78d68');for(let i=0;i<3;i++){line(ctx,-11,y+4+i*4,-4,y+4+i*4,'#a7a082',1);line(ctx,4,y+4+i*4,11,y+4+i*4,'#a7a082',1);}
  if(phase>.65&&phase<.9){const width=Math.round(Math.sin((phase-.65)/.25*Math.PI)*12);ctx.fillStyle='#fff3cf';ctx.fillRect(-width,y+1,width,14);}
}

export function drawPerformance(ctx,actor,p,time,{layer='front',motion=true}={}){
  if(['idle','travel'].includes(p.mode))return;
  const x=Math.round(actor.position[0]*768),y=Math.round(actor.position[1]*768),phase=p.phase;
  ctx.save();ctx.translate(x,y);
  if(layer==='back'){
    if(['sit','bench'].includes(p.mode))bench(ctx,p.mode==='bench'?'#638d9e':'#91613e');
    if(p.mode==='read'&&actor.resting)bench(ctx);
    if(p.mode==='fish'){
      bench(ctx);const bob=motion?Math.sin(phase*Math.PI*2)*2:0;
      // Fish only from authored bank seats; the bobber lands in the creek.
      line(ctx,-9,-16,-33,-40,'#493a29',3);line(ctx,-9,-17,-32,-41,'#d2a565',1);
      line(ctx,-32,-40,-40,23+bob,'#eee4bf',1);ctx.fillStyle='#eef6d9';ctx.fillRect(-43,18+bob,6,5);ctx.fillStyle='#d67961';ctx.fillRect(-43,23+bob,6,3);
      ctx.strokeStyle='#b6e9e0';ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(-40,27,8+phase*9,2+phase*3,0,0,Math.PI*2);ctx.stroke();
    }
    if(p.mode==='train'){
      ctx.fillStyle='#473a2d';ctx.fillRect(40,-7,5,14);ctx.fillRect(31,5,24,4);ctx.fillStyle='#a7764e';ctx.fillRect(29,-40,28,34);ctx.fillStyle='#dbc08a';ctx.fillRect(32,-37,22,28);ctx.fillStyle='#ae6053';ctx.fillRect(36,-32,14,18);ctx.fillStyle='#e9d4a2';ctx.fillRect(40,-27,6,8);
    }
    if(['hammer','build','terminal','review'].includes(p.mode)){
      const bx=p.mode==='hammer'?26:-22;ctx.fillStyle='#332d2a';ctx.fillRect(bx,-13,42,10);ctx.fillRect(bx+4,-3,5,14);ctx.fillRect(bx+33,-3,5,14);ctx.fillStyle='#a77b4a';ctx.fillRect(bx+1,-12,40,5);
      if(p.mode==='hammer'){ctx.fillStyle='#93a4a5';ctx.fillRect(30,-22,30,6);ctx.fillRect(39,-17,13,5);ctx.fillStyle='#536474';ctx.fillRect(40,-13,11,3);}
    }
    ctx.restore();return;
  }
  if(['read','bench','review'].includes(p.mode)){
    book(ctx,phase,{paper:p.mode==='review'});
    if(p.mode==='review')line(ctx,13,1,22+(motion?Math.sin(phase*12)*2:0),-17,'#e1cba0',3);
  }
  if(p.mode==='hammer'){
    const striking=phase<.41,angle=striking?-.8+Math.sin(phase/.41*Math.PI)*1.4:.65;
    ctx.save();ctx.translate(21,-23);ctx.rotate(angle);ctx.fillStyle='#49362b';ctx.fillRect(-2,-22,4,25);ctx.fillStyle='#e2b66e';ctx.fillRect(-1,-20,2,20);ctx.fillStyle='#334653';ctx.fillRect(-9,-25,19,9);ctx.fillStyle='#bac3bc';ctx.fillRect(-7,-24,15,4);ctx.restore();
    if(motion&&phase>.22&&phase<.37)for(let i=0;i<5;i++){ctx.fillStyle=i%2?'#fff0b0':'#eaa75b';ctx.fillRect(44+(i-2)*5,-24-Math.abs(i-2)*3,3,3);}
  }
  if(p.mode==='train'&&motion&&phase>.16&&phase<.36){
    const burst=(phase-.16)/.2;for(let i=0;i<6;i++){const a=i*Math.PI/3;line(ctx,43+Math.cos(a)*13,-24+Math.sin(a)*13,43+Math.cos(a)*(16+burst*6),-24+Math.sin(a)*(16+burst*6),'#ffe2a0',2);}
  }
  if(p.mode==='build'){
    for(let i=0;i<3;i++){const bx=-16+i*12,by=-25-(i===2&&motion?Math.round((1-phase)*16):0);ctx.fillStyle='#283c47';ctx.fillRect(bx,by,11,11);ctx.fillStyle=['#d4b57c','#92c5c2','#a8afd3'][i];ctx.fillRect(bx+2,by+2,7,7);}
  }
  if(p.mode==='terminal'){
    ctx.fillStyle='#243741';ctx.fillRect(-18,-34,36,26);ctx.fillStyle='#76aa98';ctx.fillRect(-15,-31,30,19);ctx.fillStyle='#25464a';ctx.fillRect(-11,-26,3,3);ctx.fillRect(-8,-23,3,3);if(phase<.5)ctx.fillRect(0,-18,10,2);ctx.fillStyle='#a3aba0';ctx.fillRect(-19,-7,38,4);
  }
  if(p.mode==='wave'&&motion&&phase<.22){line(ctx,-22,-35,-28,-39,'#ffe0a0');line(ctx,22,-35,28,-39,'#ffe0a0');}
  if(['victory','celebrate'].includes(p.mode)&&motion&&p.hop>0){ctx.fillStyle='#dfedb1';ctx.fillRect(-20,-32-p.hop,3,3);ctx.fillRect(19,-41-p.hop,3,3);}
  ctx.restore();
}
