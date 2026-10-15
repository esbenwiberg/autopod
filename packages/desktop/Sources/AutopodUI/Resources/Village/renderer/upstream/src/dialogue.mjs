export const DIALOGUE_VERSION = 'dialogue-3';

const imageFile=/\.(?:png|jpe?g|webp|gif|avif|heic|heif|bmp|tiff?)(?:[?#][^\s]*)?$/i;
function imagePath(line){
  const path=line.trim().replace(/^["'`<]|["'`>]$/g,'');
  return imageFile.test(path)&&(/^(?:\/|\.\.?\/|~\/|[a-z]:[\\/]|https?:\/\/|file:\/\/)/i.test(path)||!/[\s]/.test(path));
}

// Presentation only: the complete source text stays on the event and in the
// journal. Bounded, mechanical excerpts are not generated summaries.
export function dialogueExcerpt(value,{limit=240}={}) {
  const original=typeof value==='string'?value:'';
  let text=original.slice(0,12000),attachment=false,technical=false,image=false,screenshot=false;
  const request=text.match(/^#{1,3}\s*My request(?: for Codex)?:\s*$/m);
  if(/^\s*# Files mentioned by the user:/.test(text)){
    image=text.slice(0,request?.index??text.length).split(/\r?\n/).some(line=>/^##\s/.test(line)&&imageFile.test(line.trim()));
    attachment=true;text=request?text.slice(request.index+request[0].length):'';
  }
  text=text.replace(/<image\b[^>]*>[\s\S]*?<\/image>|<image\b[^>]*\/?>|!\[[^\]]*\]\([^\n]*?\)/gi,tag=>{
      image=true;attachment=true;
      // Only an explicit attachment label/type identifies a screenshot. A
      // filename containing "screenshot" is still just an image path.
      screenshot||=/^<image\b[^>]*\b(?:type|kind|alt|name)\s*=\s*["']screenshot["']/i.test(tag)||/^!\[screenshot\]/i.test(tag);
      return '';
    })
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi,'')
    .replace(/^Message Type: (?:MESSAGE|FINAL_ANSWER)[\s\S]*?\bPayload:\s*/,'')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g,()=>{technical=true;return '';});
  const structured=s=>{try{const v=JSON.parse(s);return v!==null&&typeof v==='object';}catch{return false;}};
  if(structured(text.trim())){text='';technical=true;}
  const kept=[],lines=text.split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const line=lines[i].trim();
    if(imagePath(line)){image=true;attachment=true;continue;}
    // Omit complete embedded JSON blocks without interpreting their values.
    if(/^[{[]/.test(line)){
      let block=line,found=false;
      for(let j=i;j<Math.min(lines.length,i+80);j++){
        if(j>i)block+='\n'+lines[j];
        if(structured(block)){i=j;found=true;technical=true;break;}
      }
      if(found)continue;
    }
    if(/^\s*(?:at\s+\S.*(?:\(|:\d)|File "|Traceback \(|\^+$|\d+\s*\||\{"|"[^"]+"\s*:|[}\]][,;]?$)/.test(line)){technical=true;continue;}
    kept.push(line);
  }
  text=kept.join(' ').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/(?:https?:\/\/|(?:\/|[A-Za-z]:\\)(?:[^\s<>"']+[\/\\]))[^\s<>"']+/g,()=>{technical=true;return '[link or file]';})
    .replace(/\S{90,}/g,()=>{technical=true;return '[long value]';})
    .replace(/(?:^|\s)#{1,6}\s+|\*\*|__|`/g,' ').replace(/\s+/g,' ').trim();
  if(!text)text=screenshot?'Shared a screenshot.':image?'Shared an image.':attachment?'Shared an attachment.':technical?'Shared code or diagnostic data.':'Message recorded.';
  if(text.length>limit){const part=text.slice(0,limit-1),space=part.lastIndexOf(' ');text=part.slice(0,space>limit*.6?space:part.length).trimEnd()+'…';}
  return {text,shortened:text!==original.trim()};
}

export function sceneDialogue(scene){
  if(!scene)return {text:'Press Play to follow the conversation.',shortened:false};
  if(scene.pullRequest)return dialogueExcerpt(`PR #${scene.pullRequest.number} created${scene.pullRequest.title?': '+scene.pullRequest.title:'.'}`);
  const text=scene.text+(scene.event.kind.includes('message')?'':scene.event.data.evidence?.length?' · '+scene.event.data.evidence.join(' · '):'');
  return dialogueExcerpt(text);
}
export const CUE_LABELS = {cheer:'Cheering',frustration:'Frustration',relief:'Relief',confusion:'Confusion',emphasis:'Emphasis'};

// These are presentation cues, not sentiment scores or evidence of task success.
// Mask code and quoted material without moving offsets in the original message.
function spokenText(text) {
  return text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|^\s*>[^\n]*|"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'(?!\w)/gm, s=>' '.repeat(s.length));
}
const RULES = [
  ['cheer',/\b(?:fuck(?:ing)?\s+(?:yes|yeah)|hell\s+(?:yes|yeah)|let['’]s\s+go|we\s+(?:did|nailed)\s+it|nailed\s+it|woohoo|hooray|hurrah)\b|[🎉🥳🙌]/giu],
  ['frustration',/\b(?:fuck(?:ing)?|shit|damn(?:\s+it)?|ugh|argh)\b[^.!?\n]{0,65}\b(?:fail(?:ed|ing|s)?|broke|broken|crash(?:ed|es)?|again|stuck)\b|\b(?:ugh|argh|damn\s+it)\b/giu],
  ['relief',/\b(?:finally|phew|at\s+last|what\s+a\s+relief)\b/giu],
  ['confusion',/\b(?:wait\s*[,….!?-]*\s*what|what\s+the\s+(?:fuck|hell)|huh)\s*[?!]+/giu],
];
function negated(text,index) {
  const prefix=text.slice(Math.max(0,index-60),index).split(/[.!?\n;]/).at(-1);
  return /\b(?:not|never|don['’]t|do\s+not|without)\b(?:\s+\w+){0,3}\s*$/i.test(prefix);
}
export function dialogueCue(text,kind='message') {
  if(!['message','agent.message'].includes(kind)||typeof text!=='string')return null;
  const spoken=spokenText(text),spans=[];
  for(const m of spoken.matchAll(/\b(?:fuck(?:ing|ed|s)?|shit(?:ty)?|damn|bloody|bastard)\b/giu))spans.push({start:m.index,end:m.index+m[0].length,style:'strong'});
  for(const [type,pattern] of RULES){
    pattern.lastIndex=0;
    const match=[...spoken.matchAll(pattern)].find(m=>!negated(spoken,m.index));
    if(match){
      spans.push({start:match.index,end:match.index+match[0].length,style:'cue'});
      return {version:DIALOGUE_VERSION,type,label:CUE_LABELS[type],basis:'Recorded dialogue wording',trigger:text.slice(match.index,match.index+match[0].length),spans:spans.sort((a,b)=>a.start-b.start||a.end-b.end)};
    }
  }
  return spans.length?{version:DIALOGUE_VERSION,type:'emphasis',label:CUE_LABELS.emphasis,basis:'Recorded dialogue wording',trigger:text.slice(spans[0].start,spans[0].end),spans}:null;
}

export function reactionAt(scene,time,{enabled=true}={}) {
  const cue=scene?.dialogueCue,elapsed=time-(scene?.start??0)-(scene?.travel??0);
  if(!cue||!enabled||elapsed<0||time>=scene.end)return null;
  const phase=Math.min(1,elapsed/2.4),fade=Math.max(0,1-phase);
  return {type:cue.type,phase,fade,
    hop:cue.type==='cheer'?Math.abs(Math.sin(Math.min(elapsed,1.2)*Math.PI*2.5))*13*Math.max(0,1-elapsed/1.2):0,
    nudge:cue.type==='frustration'?Math.sin(elapsed*24)*3*Math.max(0,1-elapsed/.7):0};
}
