import { ACTIVITIES } from './activity.mjs';
import { PRESENCE_STYLES } from './presence.mjs';

export function drawPresence(ctx,actor,time,{selected=false}={}){
  if(actor.role==='user'||actor.missingTranscript||actor.celebration)return;
  const kind=actor.presence.kind,active=actor.scene&&time<actor.scene.end;
  if(!['input','agents','running'].includes(kind)&&active)return;
  const style=PRESENCE_STYLES[kind],x=Math.round(actor.position[0]*768-22),y=Math.round(actor.position[1]*768-48);
  ctx.save();ctx.translate(x,y);ctx.fillStyle='#162b34';ctx.fillRect(-12,-12,24,24);ctx.fillStyle=style.color;ctx.fillRect(-9,-9,18,18);
  ctx.strokeStyle='#233644';ctx.fillStyle='#233644';ctx.lineWidth=2;
  const line=(a,b,c,d)=>{ctx.beginPath();ctx.moveTo(a,b);ctx.lineTo(c,d);ctx.stroke();};
  if(kind==='agents'){line(-5,-6,5,-6);line(-5,6,5,6);line(-4,-5,4,5);line(4,-5,-4,5);}
  else if(kind==='running'||kind==='result'){ctx.beginPath();ctx.arc(0,0,6,0,Math.PI*2);ctx.stroke();line(0,0,0,-4);line(0,0,4,2);}
  else if(kind==='finished'){line(-5,0,-1,4);line(-1,4,6,-4);}
  else{ctx.font='bold 18px monospace';ctx.fillText(kind==='input'?'!':kind==='closed'?'☾':'z',-5,6);}
  ctx.restore();
  if(selected&&['input','agents'].includes(kind)){
    const text=actor.presence.label.length>30?actor.presence.label.slice(0,29)+'…':actor.presence.label;
    ctx.font='14px "Pixelify Sans", monospace';const width=ctx.measureText(text).width+12,bx=Math.max(6,Math.min(762-width,actor.position[0]*768-width/2));
    ctx.fillStyle='#162b34ee';ctx.fillRect(bx,y-36,width,22);ctx.fillStyle=style.color;ctx.fillText(text,bx+6,y-20);
  }
}

export function drawWaitingLinks(ctx,state,focus){
  const actor=state.actors.find(a=>a.id===focus);if(actor?.presence.kind!=='agents')return;
  ctx.save();ctx.strokeStyle='#93d5f599';ctx.lineWidth=2;ctx.setLineDash([3,7]);
  for(const id of actor.presence.targetIds){const target=state.actors.find(a=>a.id===id);if(!target)continue;ctx.beginPath();ctx.moveTo(actor.position[0]*768,actor.position[1]*768-20);ctx.lineTo(target.position[0]*768,target.position[1]*768-20);ctx.stroke();}
  ctx.restore();
}

// Fixed waterway coordinates and transcript time make seeking and export agree.
export function drawHarbor(ctx,timeline,time,{team=null,motion=true}={}){
  if(!['village-3','village-4'].includes(timeline.assetVersion))return;
  const departures=(timeline.departures??[]).filter(d=>(!team||d.teamId===team)&&d.start<=time&&d.end>time);
  const boats=departures.length?departures.map(d=>({phase:motion?(time-d.start)/(d.end-d.start):0,color:timeline.actors.find(a=>a.id===d.actorId)?.teamColor??'#7cd9c0'})):[{phase:0,color:'#497b77'}];
  ctx.save();ctx.beginPath();ctx.rect(0,0,768,768);ctx.clip();
  for(const {phase,color} of boats){
    // Leave the dock toward the south; turn east only after clearing the rock.
    const points=[[.25,.925],[.26,.965],[.29,1.02],[.43,1.05]],scaled=phase*3,i=Math.min(2,Math.floor(scaled)),f=scaled-i;
    const x=Math.round((points[i][0]+(points[i+1][0]-points[i][0])*f)*768),y=Math.round((points[i][1]+(points[i+1][1]-points[i][1])*f)*768);
    ctx.save();ctx.translate(x,y);ctx.fillStyle='#a8e7e6aa';if(phase>0){ctx.fillRect(-12,-19,24,2);ctx.fillRect(-9,-25,18,2);}
    ctx.fillStyle='#162b34';ctx.beginPath();ctx.moveTo(-14,-10);ctx.lineTo(14,-10);ctx.lineTo(14,5);ctx.lineTo(7,13);ctx.lineTo(0,17);ctx.lineTo(-7,13);ctx.lineTo(-14,5);ctx.closePath();ctx.fill();ctx.fillStyle='#946237';ctx.fillRect(-11,-7,22,12);ctx.fillRect(-7,5,14,5);ctx.fillStyle='#dba75d';ctx.fillRect(-8,-4,16,4);ctx.fillRect(-8,4,16,3);ctx.fillRect(-23,1,12,3);ctx.fillRect(11,1,12,3);
    ctx.fillStyle='#f4e2ae';ctx.fillRect(0,-25,2,30);ctx.fillRect(3,-24,12,12);ctx.fillRect(3,-12,7,4);ctx.fillStyle=color;ctx.fillRect(3,-24,12,12);ctx.restore();
  }
  ctx.restore();
}
// Small canvas-native pictograms stay sharp at either browser or export resolution.
export function drawActivity(ctx,actor,time,{motion=true}={}){
  const s=actor.scene;if(actor.celebration||!s||time>=s.end||actor.moving||s.event.kind==='message'||s.event.kind==='agent.message')return;
  if(['hammer','train','build','review','read','terminal','wave','bench'].includes(actor.performance?.mode)&&s.event.kind!=='action.result')return;
  const p=ACTIVITIES[s.activity]??ACTIVITIES.unknown;
  const elapsed=motion?Math.max(0,time-s.start-s.travel):0,beat=Math.floor(elapsed*4)%4;
  const result=s.event.kind==='action.result',failed=result&&s.status==='failed',completed=result&&s.status==='completed';
  const x=Math.round(actor.position[0]*768+20),y=Math.round(actor.position[1]*768-45);
  ctx.save();ctx.translate(x,y);ctx.fillStyle='#142531';ctx.fillRect(-14,-14,29,29);ctx.fillStyle=failed?'#ffb3a2':completed?'#aee4c7':p.color;ctx.fillRect(-11,-11,23,23);
  ctx.strokeStyle='#233644';ctx.fillStyle='#233644';ctx.lineWidth=2;ctx.lineCap='square';
  const line=(x1,y1,x2,y2)=>{ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();};
  if(failed){line(-5,-5,5,5);line(5,-5,-5,5);}
  else if(completed){line(-6,0,-2,5);line(-2,5,7,-5);}
  else switch(p.glyph){
    case 'book':ctx.strokeRect(-8,-6,7,12);ctx.strokeRect(1,-6,7,12);line(-1,-7,-1,7);if(beat%2)line(2,-3,6,-3);break;
    case 'search':ctx.beginPath();ctx.arc(-2+(beat%2),-2,5,0,Math.PI*2);ctx.stroke();line(2,2,7,7);break;
    case 'hammer':ctx.rotate(Math.sin(elapsed*9)*.35);ctx.fillRect(-1,-4,3,13);ctx.fillRect(-7,-7,13,5);break;
    case 'terminal':ctx.strokeRect(-8,-6,16,12);line(-5,-3,-2,0);line(-2,0,-5,3);if(beat%2===0)line(1,3,5,3);break;
    case 'check':for(let i=0;i<3;i++){ctx.strokeRect(-7,-7+i*6,3,3);if(i===beat%3)line(0,-5+i*6,7,-5+i*6);}break;
    case 'blocks':ctx.fillRect(-8,2,7,6);ctx.fillRect(1,2,7,6);ctx.fillRect(-3,-6-(beat%2)*2,7,6);break;
    case 'review':ctx.strokeRect(-7,-8,14,17);for(let i=0;i<3;i++)line(-3,-4+i*4,4,-4+i*4);line(3,5,8,0);break;
    case 'box':ctx.strokeRect(-8,-6,16,13);line(-8,-6,0,-2);line(0,-2,8,-6);line(0,-2,0,7);break;
    case 'flag':line(-5,-8,-5,9);ctx.fillRect(-3,-7,10,7);ctx.clearRect(5,-7+(beat%2)*2,2,2);break;
    case 'letter':ctx.strokeRect(-8,-5,16,11);line(-8,-5,0,1);line(0,1,8,-5);break;
    case 'question':ctx.font='bold 21px monospace';ctx.fillText('?',-6,7);break;
    case 'wait':ctx.beginPath();ctx.arc(0,0,8,0,Math.PI*2);ctx.stroke();line(0,0,0,-5);line(0,0,Math.cos(elapsed*2)*5,Math.sin(elapsed*2)*5);break;
  }
  // This strip shows the scene's animation time, never tool execution progress.
  ctx.fillStyle=p.color;ctx.fillRect(-14,18,Math.round(29*Math.min(1,(time-s.start-s.travel)/(s.end-s.start-s.travel))),2);
  ctx.restore();
}
export function drawHandoffs(ctx,state,{motion=true}={}){
  for(const s of state.active){
    if(s.event.kind!=='agent.message'||!s.event.data.recipient)continue;
    const sender=state.actors.find(a=>a.id===s.event.actorId),recipient=state.actors.find(a=>a.id===s.event.data.recipient);
    if(!sender||!recipient||sender.moving)continue;
    const phase=motion?Math.min(1,Math.max(0,(state.time-s.start-s.travel)/1.2)):.5;
    if(phase>=1)continue;
    const from=sender.position,to=recipient.position;
    ctx.save();ctx.strokeStyle='#f7deb588';ctx.lineWidth=2;ctx.setLineDash([4,6]);ctx.beginPath();ctx.moveTo(from[0]*768,from[1]*768-20);ctx.lineTo(to[0]*768,to[1]*768-20);ctx.stroke();ctx.setLineDash([]);
    const x=(from[0]+(to[0]-from[0])*phase)*768,y=(from[1]+(to[1]-from[1])*phase)*768-20;
    ctx.fillStyle='#182733';ctx.fillRect(x-10,y-7,20,14);ctx.fillStyle='#f7deb5';ctx.fillRect(x-8,y-5,16,10);ctx.strokeStyle='#725d42';ctx.beginPath();ctx.moveTo(x-8,y-5);ctx.lineTo(x,y+1);ctx.lineTo(x+8,y-5);ctx.stroke();ctx.restore();
  }
}

// Pixel bursts use replay time only, so seeks and video frames are identical.
export function drawCelebration(ctx,timeline,time,{team=null,motion=true}={}){
  const active=(timeline.celebrations??[]).filter(c=>(!team||c.teamId===team)&&c.start<=time&&time<c.end);
  if(!motion||!active.length)return;
  for(const [index,c] of active.entries()){
    const color=timeline.actors.find(a=>a.id===c.actorId)?.teamColor??'#7cd9c0';
    for(let burst=0;burst<3;burst++){
      const elapsed=time-c.start-burst*.32;if(elapsed<0)continue;
      const phase=(elapsed%2.6)/2.6;if(phase>.8)continue;
      const x=(.13+burst*.105)*768,y=(.82-(burst%2)*.08)*768,r=8+phase*60;
      ctx.save();ctx.globalAlpha=1-phase*.45;
      for(let ray=0;ray<12;ray++){
        const angle=ray*Math.PI/6+index*.4;ctx.fillStyle=ray%3===0?'#fff1b6':ray%3===1?color:'#ffb3ce';
        ctx.strokeStyle='#263244';ctx.lineWidth=6;ctx.beginPath();ctx.moveTo(Math.round(x+Math.cos(angle)*r*.65),Math.round(y+Math.sin(angle)*r*.65+phase*phase*22));ctx.lineTo(Math.round(x+Math.cos(angle)*r),Math.round(y+Math.sin(angle)*r+phase*phase*22));ctx.stroke();
        ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(Math.round(x+Math.cos(angle)*r*.65),Math.round(y+Math.sin(angle)*r*.65+phase*phase*22));ctx.lineTo(Math.round(x+Math.cos(angle)*r),Math.round(y+Math.sin(angle)*r+phase*phase*22));ctx.stroke();
        ctx.fillRect(Math.round(x+Math.cos(angle)*r),Math.round(y+Math.sin(angle)*r+phase*phase*22),4,4);
        if(phase>.12){ctx.globalAlpha=(1-phase/.8)*.4;ctx.fillRect(Math.round(x+Math.cos(angle)*r*.7),Math.round(y+Math.sin(angle)*r*.7+phase*phase*22),3,3);ctx.globalAlpha=1-phase*.45;}
      }
      ctx.restore();
    }
  }
}
