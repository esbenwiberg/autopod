// Evidence-only milestones. This module never contacts a forge or executes text.
export function shellWords(command){
  if(typeof command!=='string')return null;
  const words=[];let word='',quote=null,started=false;
  for(let i=0;i<command.length;i++){
    const c=command[i];
    if(c==='\\'&&quote!=="'"){if(i+1>=command.length)return null;const next=command[++i];if(next!=='\n'){word+=next;started=true;}continue;}
    if(quote){if(c===quote)quote=null;else {if(quote==='"'&&(c==='$'||c==='`'))return null;word+=c;}started=true;continue;}
    if(c==='"'||c==="'"){quote=c;started=true;continue;}
    if(/[\n\r;&|<>`$()#]/.test(c))return null;
    if(/\s/.test(c)){if(started){words.push(word);word='';started=false;}}else{word+=c;started=true;}
  }
  if(quote)return null;if(started)words.push(word);return words;
}
export function prIntent(data){
  const operations=data.operations;
  if(operations?.length>1)return null;
  const op=operations?.[0],name=(op?.name??data.tool??'').toLowerCase().replace(/[^a-z]/g,'');
  if(/(?:createpullrequest|pullrequestcreate)$/.test(name))return {kind:'api',title:op?.args?.title??data.input?.title??null};
  const commands=data.commands??[op?.args?.cmd??op?.args?.command??data.input?.command];
  if(commands.length!==1)return null;
  const words=shellWords(commands[0]);
  if(!words||words.slice(0,3).join(' ')!=='gh pr create'||words.some(w=>['--help','-h','--dry-run','--web'].includes(w)))return null;
  const index=words.indexOf('--title');
  return {kind:'cli',title:index>=0?words[index+1]??null:words.find(w=>w.startsWith('--title='))?.slice(8)??null};
}
export function safePrUrl(value){
  if(typeof value!=='string')return null;
  try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port||url.hostname!=='github.com'||!/^\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/.test(url.pathname))return null;return `${url.origin}${url.pathname.replace(/\/$/,'')}`;}catch{return null;}
}
export function createdPr(event,scenes){
  if(event.kind!=='action.result'||['failed','running'].includes(event.data.status))return null;
  const ids=[...new Set(event.data.actionIds??event.causes??[])],calls=ids.map(id=>scenes.get(id)).filter(s=>s?.event.kind==='action.start');
  if(calls.length!==1)return null;
  const intent=prIntent(calls[0].event.data);if(!intent)return null;
  if(intent.kind==='cli'&&event.data.status!=='completed')return null;
  const found=new Map();let failed=false;
  function visit(value){
    if(typeof value==='string'){
      if(/^\s*[\[{]/.test(value)){try{visit(JSON.parse(value));return;}catch{}}
      if(intent.kind==='cli')for(const match of value.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*(?![\w./?&#%-])/g)){const url=safePrUrl(match[0]);if(url)found.set(url,{url,title:intent.title});}
    }else if(Array.isArray(value))value.forEach(visit);
    else if(value&&typeof value==='object'){
      if(value.isError===true||value.error||['failed','error'].includes(value.status))failed=true;
      if(intent.kind==='api'){const url=safePrUrl(value.html_url??value.htmlUrl??value.url);if(url&&Number.isInteger(value.number)&&value.number===Number(url.split('/').at(-1)))found.set(url,{url,title:typeof value.title==='string'?value.title:intent.title});}
      Object.values(value).forEach(visit);
    }
  }
  visit(event.data.output);
  if(failed||found.size!==1)return null;
  const pr=[...found.values()][0];return {...pr,number:Number(pr.url.split('/').at(-1)),title:typeof pr.title==='string'?pr.title:null};
}
