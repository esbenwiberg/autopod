import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { CONTRACT_DIAGNOSTICS_VERSION, type ContractDiagnostic, inspectSpecContractYaml, numericPrefix, parseBriefs, type BriefFile } from '@autopod/shared';

export interface SeriesPreflight { specRoot: string; briefsDir: string; briefFiles: BriefFile[]; briefs?: ReturnType<typeof parseBriefs>; diagnostics: ContractDiagnostic[]; }
export function resolveSpecLayout(folder: string): { specRoot: string; briefsDir: string } { const abs=resolve(folder); return basename(abs)==='briefs' ? {specRoot:resolve(abs,'..'),briefsDir:abs} : existsSync(join(abs,'briefs')) && statSync(join(abs,'briefs')).isDirectory() ? {specRoot:abs,briefsDir:join(abs,'briefs')} : {specRoot:abs,briefsDir:abs}; }
const diagnostic=(source:string, path:string, code:string, message:string, hint:string): ContractDiagnostic=>({source,path,code,message,hint});
export function preflightSeriesFolder(folder: string): SeriesPreflight {
  const {specRoot,briefsDir}=resolveSpecLayout(folder); const diagnostics: ContractDiagnostic[]=[]; const briefFiles: BriefFile[]=[];
  if (!existsSync(briefsDir) || !statSync(briefsDir).isDirectory()) return {specRoot,briefsDir,briefFiles,diagnostics:[diagnostic(briefsDir,'','SERIES_BRIEFS_NOT_FOUND','Briefs directory does not exist.','Create a briefs directory or point at a brief folder.')]};
  const dirs=readdirSync(briefsDir).filter(n=>statSync(join(briefsDir,n)).isDirectory()).sort((a,b)=>numericPrefix(a)-numericPrefix(b));
  const direct = !dirs.length && existsSync(join(briefsDir, 'brief.md'));
  if (direct) dirs.push('');
  for (const name of dirs) { const dir=name ? join(briefsDir,name) : briefsDir; const brief=join(dir,'brief.md'); const yaml=join(dir,'contract.yaml'), yml=join(dir,'contract.yml'); if (!existsSync(brief)) { diagnostics.push(diagnostic(dir,'brief.md','SERIES_BRIEF_MISSING','Brief folder is missing brief.md.','Add brief.md beside the contract.')); continue; } if (existsSync(yaml)&&existsSync(yml)) { diagnostics.push(diagnostic(dir,'contract','SERIES_DUPLICATE_CONTRACT','Both contract.yaml and contract.yml exist.','Keep exactly one contract file.')); continue; } const contract=existsSync(yaml)?yaml:existsSync(yml)?yml:undefined; if (!contract) { diagnostics.push(diagnostic(dir,'contract','SERIES_CONTRACT_MISSING','Brief folder is missing contract.yaml or contract.yml.','Add one contract-v1 file.')); continue; } const text=readFileSync(contract,'utf8'); diagnostics.push(...inspectSpecContractYaml(text,contract).diagnostics); briefFiles.push({filename:name || basename(dir),content:readFileSync(brief,'utf8'),contractContent:text}); }
  if (!dirs.length) diagnostics.push(diagnostic(briefsDir,'','SERIES_BRIEFS_EMPTY','No contract brief folders found.','Add a brief folder containing brief.md and contract.yaml.'));
  let briefs: ReturnType<typeof parseBriefs> | undefined;
  if (!diagnostics.length) { try { briefs=parseBriefs(briefFiles); } catch (e) { diagnostics.push(diagnostic(briefsDir,'depends_on','SERIES_DEPENDENCY_INVALID',e instanceof Error?e.message:String(e),'Repair every dependency so it names a sibling folder and forms no cycle.')); } }
  return {specRoot,briefsDir,briefFiles,briefs,diagnostics};
}
export function preflightEnvelope(result: SeriesPreflight) { return { diagnosticsVersion: CONTRACT_DIAGNOSTICS_VERSION, valid: result.diagnostics.length===0, contractVersion: 1, diagnostics: result.diagnostics }; }
