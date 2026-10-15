// Species are presentation identity; original actor IDs and roles remain intact.
export const ROSTER=['pikachu','bulbasaur','squirtle','gengar','charmander','eevee','psyduck','meowth','jigglypuff','snorlax','growlithe','vulpix'];
export const SHARED_USER='@village/you';
const order=(a,b)=>a<b?-1:a>b?1:0;
function hash(text){let value=2166136261;for(const c of text){value^=c.codePointAt(0);value=Math.imul(value,16777619);}return value>>>0;}
export function assignCast(actors,sessionId='session'){
  const assigned=new Map(),counts=new Map(ROSTER.map(s=>[s,0]));
  // Already assigned species survive composition into a city.
  for(const a of actors)if(a.role!=='user'&&ROSTER.includes(a.skin)){assigned.set(a.id,a.skin);counts.set(a.skin,counts.get(a.skin)+1);}
  const pending=actors.filter(a=>a.role!=='user'&&!assigned.has(a.id)).sort((a,b)=>order(a.id,b.id));
  for(const a of pending){
    const offset=hash(`${sessionId}:${a.id}`)%ROSTER.length,min=Math.min(...counts.values());
    const species=Array.from({length:ROSTER.length},(_,i)=>ROSTER[(offset+i)%ROSTER.length]).find(s=>counts.get(s)===min);
    assigned.set(a.id,species);counts.set(species,counts.get(species)+1);
  }
  return actors.map(a=>({...a,skin:a.role==='user'?'red':assigned.get(a.id)}));
}
const userCache=new WeakMap();
function sharedUsers(timeline){
  if(!userCache.has(timeline))userCache.set(timeline,new Set(timeline.teams?.length>1?timeline.actors.filter(a=>a.role==='user').map(a=>a.id):[]));
  return userCache.get(timeline);
}
export function displayActorId(timeline,id){return sharedUsers(timeline).has(id)?SHARED_USER:id;}
export function matchesFocus(timeline,sourceId,focus){return focus===SHARED_USER?displayActorId(timeline,sourceId)===focus:sourceId===focus;}
export function visibleCast(timeline,team=null){
  const actors=timeline.actors.filter(a=>!team||a.teamId===team);
  if(!sharedUsers(timeline).size)return actors;
  const users=actors.filter(a=>a.role==='user'),first=users[0];
  return first?[...actors.filter(a=>a.role!=='user'),{...first,id:SHARED_USER,name:'You',skin:'red',teamId:null,teamColor:null,teamNumber:null,sharedUser:true}]:actors;
}
export function shareUserState(timeline,actors,focus=null){
  if(!sharedUsers(timeline).size)return actors;
  // One trainer represents the latest human message within the selected scope.
  // Source actor IDs remain in scenes and journals, so attribution is unchanged.
  const users=actors.filter(a=>a.role==='user').sort((a,b)=>Number(b.id===focus)-Number(a.id===focus)||(b.scene?.start??-1)-(a.scene?.start??-1)||order(b.scene?.id??b.id,a.scene?.id??a.id));
  if(!users.length)return actors;
  return [...actors.filter(a=>a.role!=='user'),{...users[0],id:SHARED_USER,name:'You',skin:'red',teamId:null,teamColor:null,teamNumber:null,sharedUser:true,position:[.455,.45],direction:0,moving:false}];
}
