export const DIALOGUE_VERSION = 'dialogue-1';
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
