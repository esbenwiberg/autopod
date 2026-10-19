import { LOCATIONS, stationRoute, stationSeat } from './world.mjs';
import { presenceAt } from './presence.mjs';
const length=path=>path.slice(1).reduce((n,p,i)=>n+Math.hypot(p[0]-path[i][0],p[1]-path[i][1]),0);
export function buildInterludes(timeline){
  const agents=timeline.actors.filter(a=>a.role!=='user'),tracks=Object.fromEntries(timeline.actors.map(a=>[a.id,[]]));
  const candidates=[];
  for(const [slot,a] of agents.entries()){
    const scenes=timeline.scenes.filter(s=>s.event.actorId===a.id);
    for(let i=0;i<scenes.length;i++){
      const s=scenes[i],next=scenes[i+1],start=s.end+.8,end=next?.start??timeline.duration;
      if(end-start<1)continue;
      const presence=presenceAt(timeline,a.id,start);
      const leisure=['input','agents','running','result'].includes(presence.kind)?null:slot===2?'fish':slot%2?'read':'sit';
      const station=presence.kind==='input'?'noticeboard':presence.kind==='agents'?'courtyard':['running','result'].includes(presence.kind)?presence.station??s.station:leisure==='fish'?'fishing':'camp';
      candidates.push({a,s,next,start,end,leisure,station});
    }
  }
  // Reserve only for visitors to this resting destination, not all agents in
  // the replay. A stable slot also prevents characters jumping between rests.
  const visitors=new Map();
  for(const c of candidates){if(!visitors.has(c.station))visitors.set(c.station,new Set());visitors.get(c.station).add(c.a.id);}
  const seats=new Map([...visitors].map(([station,ids])=>[station,[...ids].sort()]));
  for(const {a,s,next,start,end,leisure,station} of candidates){
      const ids=seats.get(station),slot=ids.indexOf(a.id);
      const from=s.path.at(-1),target=station==='fishing'?[...LOCATIONS.fishing]:stationSeat(station,slot,ids.length);
      const path=station===s.station?[from]:[from,...stationRoute(s.station,station),target].filter((p,i,arr)=>!i||Math.hypot(p[0]-arr[i-1][0],p[1]-arr[i-1][1])>.002);
      const travel=length(path)*4.5;
      // Return to the next scene's original starting point before that scene
      // begins. This keeps both movement and already-compiled event times intact.
      if(next&&end-start<travel*2+2)continue;
      if(!next&&end-start<travel+.5)continue;
      tracks[a.id].push({start,end,path,travel,leisure,returnAt:next?end-travel:null,station});
  }
  return tracks;
}
export function interludeAt(timeline,actorId,time){return (timeline.interludes?.[actorId]??[]).find(s=>s.start<=time&&(s.end>time||s.returnAt===null&&s.end===time))??null;}
