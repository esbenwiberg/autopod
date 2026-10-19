import { recapSummary } from './recap.mjs';
import { displayActorId } from './cast.mjs';
import { sceneAt } from './timeline.mjs';
import { cameraAt, worldToScreen } from './camera.mjs';
import { reactionAt, sceneDialogue, dialogueCue, dialogueExcerpt } from './dialogue.mjs';
import { drawActivity, drawHandoffs, drawPresence, drawWaitingLinks, drawHarbor, drawCelebration } from './effects.mjs';
import { performanceAt, drawPerformance } from './performance.mjs';
import { STATION_NAMES } from './world.mjs';

export const VIEW={width:768,height:928};
export const RECAP_PANEL={x:16,y:652,width:736,height:268};
function frameIndex(durations,time){const total=durations.reduce((a,b)=>a+b,0);let t=((time*1000)%total+total)%total;for(let i=0;i<durations.length;i++){if(t<durations[i])return i;t-=durations[i];}return 0;}

export function drawCharacter(ctx,actor,assets,x,y,time,scale=2.25,direction=null){
  const species=assets.meta.characters[actor.skin]?actor.skin:assets.meta.roles[actor.skin],char=assets.meta.characters[species],anim=char?.animations[actor.animation??(actor.moving?'walk':'idle')]??char?.animations.idle;
  if(!anim)return;
  const facing=direction??['down','left','right','up'][actor.direction]??'down',dir=anim.directions[facing];
  const index=frameIndex(anim.durationMs,actor.animationTime??time),col=dir.frames[index%dir.frames.length],anchor=dir.anchors?.[index]??anim.anchor;
  const image=assets.images[anim.image];if(!image)return;
  ctx.save();ctx.translate(Math.round(x),Math.round(y));
  if(dir.flipX)ctx.scale(-1,1);
  ctx.drawImage(image,col*anim.frameWidth,dir.row*anim.frameHeight,anim.frameWidth,anim.frameHeight,-anchor[0]*scale,-anchor[1]*scale,anim.frameWidth*scale,anim.frameHeight*scale);
  if(actor.teamColor)drawScarf(ctx,species,facing,actor.animation??(actor.moving?'walk':'idle'),scale,actor.teamColor);
  ctx.restore();
}

// Tiny canvas-native costume accents use the character's own transform, so
// they inherit its facing, scale, action hop and nudge, including portraits.
function drawScarf(ctx,species,facing,animation,scale,color){
  const side=facing.toLowerCase().includes('left')||facing.toLowerCase().includes('right'),back=facing.startsWith('up');
  const profile={red:[-9,5],pikachu:[-7,7],squirtle:[-6,6],bulbasaur:[-1,6],gengar:[-3,9],charmander:[-7,6],eevee:[-5,7],psyduck:[-5,7],meowth:[-7,6],jigglypuff:[-3,7],snorlax:[-7,12],growlithe:[-5,7],vulpix:[-5,6]}[species];if(!profile)return;
  let [y,width]=profile,x=0;
  if(side){width=3;x=facing.toLowerCase().includes('left')?-1:1;if(species==='bulbasaur')y=-4;}
  if(species==='bulbasaur'&&!side){x=5;y=-4;width=3;}
  if(species==='gengar'&&side)y=-4;
  if(animation==='sit'){if(species==='pikachu')y=-8;if(species==='gengar')y=-7;if(species==='squirtle')y=-7;}
  ctx.save();ctx.scale(scale,scale);ctx.translate(x,y);
  // Dark seam, folded cloth, and a short pointed end; no floating marker.
  const left=-Math.floor(width/2);
  ctx.fillStyle='#243b43';ctx.fillRect(left-1,-1,width+2,2);
  ctx.fillStyle=color;ctx.fillRect(left,0,width,1);
  const knot=back?left:left+width-2;ctx.fillRect(knot,1,3,1);ctx.fillRect(knot+1,2,2,1);ctx.fillRect(knot+1,3,1,1);
  ctx.fillStyle='#ffffff66';ctx.fillRect(knot,1,1,1);ctx.restore();
}

const THEMES={
  cheer:{accent:'#ffe08b',ink:'#775116',paper:'#fff2bf'},
  frustration:{accent:'#ffb3a2',ink:'#8e373b',paper:'#ffe4d6'},
  relief:{accent:'#aee4c7',ink:'#29634c',paper:'#e0f1d8'},
  confusion:{accent:'#d9c7ff',ink:'#5c4683',paper:'#eee5ff'},
  emphasis:{accent:'#ffd29a',ink:'#83502b',paper:'#fff0d3'},
};
function styledLines(ctx,text,width,size,cue){
  const lines=[];let runs=[],x=0;
  const add=(value,start,space)=>{
    const emphasized=cue?.spans.some(s=>s.start<start+value.length&&s.end>start)??false;
    const font=`${emphasized?'700 ':''}${size}px "Pixelify Sans", monospace`;
    ctx.font=font;let measured=ctx.measureText(value).width,gap=space&&x?ctx.measureText(' ').width:0;
    if(x+gap+measured>width&&runs.length){lines.push({runs,width:x});runs=[];x=0;gap=0;}
    if(measured>width&&value.length>1){let offset=start;for(const char of value){add(char,offset,false);offset+=char.length;}return;}
    x+=gap;runs.push({text:value,x,font,emphasized});x+=measured;
  };
  for(const match of text.matchAll(/\S+/gu))add(match[0],match.index,true);
  if(runs.length)lines.push({runs,width:x});return lines.length?lines:[{runs:[],width:0}];
}
function drawLine(ctx,line,x,y,normal,accent){
  for(const run of line.runs){ctx.font=run.font;ctx.fillStyle=run.emphasized?accent:normal;ctx.fillText(run.text,x+run.x,y);}
}
function drawReaction(ctx,reaction,x,y){
  if(!reaction||reaction.fade<=0)return;
  ctx.save();ctx.globalAlpha=reaction.fade;
  if(reaction.type==='cheer'){
    const colors=['#ffe08b','#9bdfbf','#edaaa5','#b4c8ff'];
    for(let i=0;i<16;i++){
      const angle=i*2.399963,spread=14+reaction.phase*58;
      ctx.fillStyle=colors[i%4];
      ctx.fillRect(Math.round(x+Math.cos(angle)*spread),Math.round(y-42+Math.sin(angle)*spread*.55+reaction.phase*24),4,7);
    }
  }else if(reaction.type==='frustration'){
    ctx.strokeStyle='#ffb3a2';ctx.lineWidth=3;
    for(const side of [-1,1]){ctx.beginPath();ctx.moveTo(x+side*25,y-54);ctx.lineTo(x+side*34,y-64);ctx.lineTo(x+side*30,y-68);ctx.stroke();}
  }else if(reaction.type==='confusion'){
    ctx.font='700 27px "Pixelify Sans", monospace';ctx.fillStyle='#e4d4ff';ctx.fillText('?',x+24,y-55);
  }else if(reaction.type==='relief'){
    ctx.fillStyle='#d7edd1';for(let i=0;i<3;i++)ctx.fillRect(x+22+i*7+reaction.phase*9,y-27-i*6-reaction.phase*12,5,3);
  }
  ctx.restore();
}
function box(ctx,x,y,w,h,fill='#20354d'){ctx.fillStyle='#101c2c';ctx.fillRect(x,y,w,h);ctx.fillStyle='#98a7b5';ctx.fillRect(x+3,y+3,w-6,h-6);ctx.fillStyle='#47556b';ctx.fillRect(x+6,y+6,w-12,h-12);ctx.fillStyle=fill;ctx.fillRect(x+9,y+9,w-18,h-18);}
const short=(text,n)=>text.length>n?text.slice(0,n-1).trimEnd()+'…':text;

export function renderFrame(ctx,timeline,time,assets,{focus=null,team=null,reactions=true,camera='village',chapter=null}={}){
  const state=sceneAt(timeline,time,{focus,team}),w=ctx.canvas.width,h=ctx.canvas.height;
  focus=displayActorId(timeline,focus);
  ctx.save();ctx.scale(w/VIEW.width,h/VIEW.height);ctx.imageSmoothingEnabled=false;
  ctx.fillStyle='#101c2c';ctx.fillRect(0,0,VIEW.width,VIEW.height);
  state.camera=cameraAt(timeline,state,{focus,team,mode:camera,motion:reactions});
  ctx.save();ctx.beginPath();ctx.rect(0,0,768,768);ctx.clip();
  ctx.scale(state.camera.scale,state.camera.scale);ctx.translate(-state.camera.x,-state.camera.y);
  ctx.drawImage(timeline.assetVersion==='village-4'?(assets.innMap??assets.restMap??assets.map):timeline.assetVersion==='village-3'?(assets.restMap??assets.cityMap??assets.map):timeline.assetVersion==='village-2'?(assets.cityMap??assets.map):assets.map,0,0,768,768);
  drawHarbor(ctx,timeline,state.time,{team,motion:reactions});
  const spoken=state.active.filter(s=>s.event.kind.includes('message')&&(!focus||displayActorId(timeline,s.event.actorId)===focus));
  const active=focus?state.current:(state.active.findLast(s=>s.status==='failed')??spoken.findLast(s=>s.dialogueCue)??spoken.at(-1)??state.current),display=sceneDialogue(active),cue=dialogueCue(display.text,active?.event.kind),theme=THEMES[cue?.type];
  state.current=active;
  drawWaitingLinks(ctx,state,focus);
  drawHandoffs(ctx,state,{motion:reactions});
  const selected=state.actors.find(a=>a.id===focus);
  const actors=state.actors.filter(a=>!a.retired).sort((a,b)=>a.position[1]-b.position[1]);
  for(const a of actors){
    const acting=performanceAt(a,state.time,{motion:reactions});a.performance=acting;
    const x=a.position[0]*768,y=a.position[1]*768,reaction=reactionAt(a.scene,state.time,{enabled:reactions});
    ctx.fillStyle='#14232055';ctx.beginPath();ctx.ellipse(x,y+3,a.role==='user'?15:22,7,0,0,Math.PI*2);ctx.fill();
    if(selected?.teamId&&a.teamId===selected.teamId&&a.id!==focus){ctx.save();ctx.globalAlpha=.4;ctx.strokeStyle=a.teamColor;ctx.lineWidth=1.5;ctx.beginPath();ctx.ellipse(x,y+3,22,8,0,0,Math.PI*2);ctx.stroke();ctx.restore();}
    if(a.role==='helper'&&reactions&&state.time-a.appearsAt<1){ctx.strokeStyle='#ffe8a7';ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(x,y,18+(state.time-a.appearsAt)*24,8+(state.time-a.appearsAt)*12,0,0,Math.PI*2);ctx.stroke();}
    if(a.id===(focus??displayActorId(timeline,active?.event.actorId))){ctx.strokeStyle=a.teamColor??'#f8e6aa';ctx.lineWidth=2.5;ctx.beginPath();ctx.ellipse(x,y+3,25,10,0,0,Math.PI*2);ctx.stroke();}
    drawPerformance(ctx,a,acting,time,{layer:'back',motion:reactions});
    drawCharacter(ctx,{...a,animation:acting.animation,animationTime:acting.clock},assets,x+(reaction?.nudge??0)+acting.nudge,y-(reaction?.hop??0)-acting.hop,time,a.role==='user'?2.1:1.9,acting.direction);
    drawPerformance(ctx,a,acting,time,{motion:reactions});
    drawReaction(ctx,reaction,x,y);
    drawActivity(ctx,a,time,{motion:reactions});
    drawPresence(ctx,a,time,{selected:a.id===focus});
    if(a.id===(focus??displayActorId(timeline,active?.event.actorId))){
      ctx.font='14px "Pixelify Sans", monospace';const name=short(a.name,22),tw=ctx.measureText(name).width;
      ctx.fillStyle='#152530df';ctx.fillRect(x-tw/2-5,y+14,tw+10,20);ctx.fillStyle='#f3e6c3';ctx.fillText(name,x-tw/2,y+29);
    }
  }
  drawCelebration(ctx,timeline,state.time,{team,motion:reactions});
  ctx.restore();
  if(state.time>=timeline.recap?.start){
    if(state.time>=timeline.recap.cardAt){
      const recap=recapSummary(timeline,team);
      const {x,y,width,height}=RECAP_PANEL;
      box(ctx,x,y,width,height,'#203b40');
      ctx.fillStyle='#ffe1a0';ctx.font='28px "Pixelify Sans", monospace';ctx.fillText('QUEST RECAP',36,y+41);
      const title=team?timeline.teams.find(t=>t.id===team)?.title:timeline.title;
      ctx.fillStyle='#b6d5c9';ctx.font='16px "Pixelify Sans", monospace';ctx.fillText(short(title??'The village',74),36,y+66);
      recap.lines.forEach((line,i)=>{ctx.fillStyle=i===1?'#bbccc5':'#f3e6c3';ctx.font='20px "Pixelify Sans", monospace';ctx.fillText(line,36,y+97+i*29);});
    }else{
      box(ctx,0,768,768,160);
      ctx.fillStyle='#b6ecd2';ctx.font='26px "Pixelify Sans", monospace';ctx.fillText('GATHERING IN THE SQUARE',28,811);
      ctx.fillStyle='#f3e6c3';ctx.font='21px "Pixelify Sans", monospace';ctx.fillText('A little rest after the adventure.',28,847);
      ctx.font='18px "Pixelify Sans", monospace';ctx.fillStyle='#b3bfcc';
      ctx.fillText('Waiting agents keep their posts. Closed sessions rest at the Inn.',28,881);
      ctx.fillText('This recap reflects the log, not overall task completion.',28,907);
    }
    ctx.restore();return state;
  }
  const celebration=(timeline.celebrations??[]).findLast(c=>(!team||c.teamId===team)&&c.start<=state.time&&state.time<c.end);
  if(celebration){ctx.fillStyle='#142531ed';ctx.fillRect(16,16,736,64);ctx.fillStyle='#b6ecd2';ctx.font='22px \"Pixelify Sans\", monospace';ctx.fillText(`PR #${celebration.pr.number} CREATED`,30,43);ctx.fillStyle='#f3e6c3';ctx.font='18px \"Pixelify Sans\", monospace';ctx.fillText(short(celebration.pr.title??'A new adventure sets sail',62),30,67);}
  const speaker=state.actors.find(a=>a.id===(focus??displayActorId(timeline,active?.event.actorId)));
  const status=speaker?.role!=='user'&&speaker?.presence&&(!active||state.time>=active.end||['input','agents','closed'].includes(speaker.presence.kind))?speaker.presence:null;
  if(status?.sourceId)state.current=timeline.scenes.find(s=>s.id===status.sourceId)??active;
  if(active&&speaker&&!speaker.retired&&!celebration&&state.time<active.end){
    const data=active.event.data,bubble=dialogueExcerpt(display.text,{limit:90}).text;
    const close=state.camera.mode==='follow',limit=close?340:250;
    const lines=styledLines(ctx,bubble,limit,close?24:theme?21:18,cue).slice(0,4),bw=Math.min(limit+28,Math.max(120,...lines.map(l=>l.width+24))),bh=lines.length*24+20;
    const reaction=reactionAt(active,state.time,{enabled:reactions}),pop=reaction?Math.sin(Math.min(1,reaction.phase*8)*Math.PI)*3:0;
    const [sx,sy]=worldToScreen(state.camera,speaker.position);
    const x=Math.max(10,Math.min(758-bw,sx-bw/2)),y=Math.max(14,Math.min(744-bh,sy-66*state.camera.scale-bh-pop));
    ctx.fillStyle=theme?.ink??'#23313c';ctx.fillRect(x-4,y-4,bw+8,bh+8);ctx.fillStyle=theme?.paper??'#f5eccf';ctx.fillRect(x,y,bw,bh);
    ctx.beginPath();ctx.moveTo(x+bw/2-7,y+bh);ctx.lineTo(x+bw/2,y+bh+10);ctx.lineTo(x+bw/2+7,y+bh);ctx.fill();
    lines.forEach((l,i)=>drawLine(ctx,l,x+12,y+25+i*24,data.status==='failed'?'#893d3f':'#24323b',theme?.ink??'#24323b'));
  }
  if(chapter){ctx.fillStyle='#142531ed';ctx.fillRect(0,736,768,32);ctx.font='17px "Pixelify Sans", monospace';ctx.fillStyle='#f3e6c3';ctx.fillText(`HIGHLIGHTS · ${short(chapter,45)}`,14,758);}
  box(ctx,0,768,768,160);
  if(speaker)drawCharacter(ctx,{...speaker,moving:false,animationTime:reactions?time:0},assets,52,883,time,2.6,'down');
  ctx.fillStyle='#b2d9cd';ctx.font='17px "Pixelify Sans", monospace';
  const who=(speaker?.teamNumber?`${speaker.teamNumber} · `:'')+(speaker?.name??'The village');const kind=status?'AT A GLANCE':active?.event.kind.includes('message')?'DIALOGUE':(active?.activityLabel??'RECORDED ACTION').toUpperCase();
  ctx.fillText(`${short(who,24).toUpperCase()}  ·  ${kind}`,100,801);
  if(status||active&&!cue){ctx.font='13px "Pixelify Sans", monospace';ctx.fillStyle='#b3bfcc';ctx.fillText(status?speaker.activityLabel+(speaker.resting&&!speaker.moving&&speaker.leisure?` · ${{sit:'Sitting',read:'Reading',fish:'Fishing'}[speaker.leisure]}`:''):STATION_NAMES[active.station]??'',100,819);}
  if(cue&&!status){ctx.font='13px "Pixelify Sans", monospace';ctx.fillStyle=theme.accent;ctx.fillText(cue.label.toUpperCase(),100,819);}
  const text=status?`${status.label}. ${status.kind==='closed'?'Resting at the Inn after an explicit session-end record.':status.kind==='finished'?'The green tick marks a completed turn.':status.kind==='idle'?'No new action recorded. The waiting reason is unknown.':status.kind==='input'?'At the Guild noticeboard. An input request is open.':status.kind==='agents'?'At the Guild benches until a report arrives.':status.basis+'.'}`:display.text;
  const lines=styledLines(ctx,text,635,24,status?null:cue),pages=Math.max(1,Math.ceil(lines.length/3));
  const phase=active?Math.max(0,Math.min(.999,(state.time-active.start-active.travel)/(active.end-active.start-active.travel))):0,page=Math.floor(phase*pages);
  lines.slice(page*3,page*3+3).forEach((line,i)=>drawLine(ctx,line,100,(847)+i*26,'#f5eddb',theme?.accent??'#f5eddb'));
  ctx.font='12px "Pixelify Sans", monospace';ctx.fillStyle='#b3bfcc';
  const speakerTeam=timeline.teams?.find(t=>t.id===(speaker?.sharedUser?active?.event.teamId:speaker?.teamId));
  if(speakerTeam){
    ctx.fillStyle=speakerTeam.color;ctx.fillRect(100,904,18,16);ctx.fillStyle='#172936';ctx.font='700 12px "Pixelify Sans", monospace';ctx.fillText(String(speakerTeam.number),105,916);
    ctx.fillStyle=speakerTeam.color;ctx.font='14px "Pixelify Sans", monospace';let label=speakerTeam.title;
    while(label.length&&ctx.measureText(label).width>565)label=label.slice(0,-2).trimEnd()+'…';ctx.fillText(label,125,916);
  }
  ctx.fillStyle='#b3bfcc';ctx.font='12px "Pixelify Sans", monospace';
  if(pages>1)ctx.fillText(`${page+1}/${pages}`,719,916);
  if(!status&&display.shortened&&!speakerTeam){ctx.fillStyle='#b3bfcc';ctx.fillText('Excerpt · full message in journal',100,916);}
  ctx.restore();return state;
}
