import { displayActorId } from './cast.mjs';
import { sceneAt } from './timeline.mjs';

const SIZE=768;
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));

// Sample replay time, never the previous rendered frame. Seeking and video
// exports therefore follow exactly the same path as uninterrupted playback.
export function cameraAt(timeline,state,{focus=null,team=null,mode='village',motion=true}={}){
  focus=displayActorId(timeline,focus);
  const actor=state.actors.find(a=>a.id===focus);
  if(state.time>=timeline.recap?.start||mode!=='follow'||!actor||actor.retired)return {mode:'village',scale:1,x:0,y:0,actorId:null};
  const samples=motion?[0,.08,.16,.24,.32].map(delay=>sceneAt(timeline,Math.max(actor.appearsAt,state.time-delay),{team}).actors.find(a=>a.id===focus)?.position??actor.position):[actor.position];
  const center=[0,1].map(axis=>samples.reduce((n,p)=>n+p[axis],0)/samples.length);
  const distance=samples.slice(1).reduce((n,p,i)=>n+Math.hypot(p[0]-samples[i][0],p[1]-samples[i][1]),0);
  const scale=motion?2.15-Math.min(.5,distance*7):2;
  const span=SIZE/scale;
  return {mode:'follow',scale,actorId:actor.id,
    x:clamp(center[0]*SIZE-span/2,0,SIZE-span),
    y:clamp(center[1]*SIZE-span*.62,0,SIZE-span)};
}

export function worldToScreen(camera,position){return [(position[0]*SIZE-camera.x)*camera.scale,(position[1]*SIZE-camera.y)*camera.scale];}

export function actorAtScreen(state,x,y){
  if(x<0||x>SIZE||y<0||y>=SIZE)return null;
  const camera=state.camera??{scale:1,x:0,y:0};
  return state.actors.filter(a=>!a.retired).map(actor=>{
    const [sx,sy]=worldToScreen(camera,actor.position);
    return {actor,d:Math.hypot(sx-x,sy-20*camera.scale-y),visible:sx>=0&&sx<=SIZE&&sy>=0&&sy<=SIZE};
  }).filter(a=>a.visible&&a.d<35*camera.scale).sort((a,b)=>a.d-b.d)[0]?.actor??null;
}
