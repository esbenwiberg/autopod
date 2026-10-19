export function checkKey(scene,byId){
  if(scene.activity!=='check'||scene.event.kind!=='action.result')return null;
  const ids=scene.event.data.actionIds??scene.event.causes??[],calls=ids.map(id=>byId.get(id)).filter(s=>s?.event.kind==='action.start');
  if(calls.length!==1)return null;
  const data=calls[0].event.data,commands=data.commands??(data.tool==='Bash'?[data.input?.command]:[]);
  if(commands.length!==1||typeof commands[0]!=='string'||(data.operations?.length??1)!==1)return null;
  // Exact recorded command, actor, and working directory: no inferred repair.
  const cwd=data.operations?.[0]?.args?.workdir??data.input?.cwd??'';
  return JSON.stringify([scene.event.actorId,cwd,commands[0]]);
}
