import pathlib,json,subprocess,runpy,io,contextlib,re,hashlib
from unittest.mock import patch
from types import SimpleNamespace
b=pathlib.Path('docs/analysis/2026-09-07/execution')
p=json.loads((b/'fixtures/canary-126-contract.json').read_text())
checks={}
checks['candidateCanarySourceUnchanged']=subprocess.run(['git','diff','--quiet',p['candidate'],'--','packages/daemon/src/containers/azure-sandbox-api-client.ts','packages/daemon/src/runtimes/runtime-config-capability.ts','packages/daemon/src/pods/registry-injector.ts']).returncode==0
r=json.loads((b/'receipts/checkpoint-126-diskimage-identity.json').read_text())
checks['observedAccess200AndCompleteArray']=r['httpStatus']==200 and r['responseShape']=='array' and not r['truncated'] and not r['paginationPresent']
checks['exactDigestMismatch']=len(r['matches'])==1 and r['matches'][0]['sourceDigest']!=p['importBody']['labels']['sourceDigest']
checks['resourceLimits']=p['sandboxBodyTemplate']['resources']=={'cpu':'2000m','memory':'4096Mi','disk':'40Gi'} and p['limits']['sandboxCreateAttempts']==1 and p['limits']['providerCalls']==0
checks['supportedNuget']=p['commands']['nugetSearch'][:3]==['dotnet','package','search'] and '--configfile' in p['commands']['nugetSearch']
checks['jsonValid']=all(json.loads(f.read_text()) is not None for f in [b/'acceptance.json',b/'fixtures/canary-126-contract.json',*b.glob('receipts/checkpoint-126-*.json')])
row={'id':'fixture-only','properties':{'labels':{'sourceDigest':p['importBody']['labels']['sourceDigest']},'status':{'state':'Ready'}}}
for name,body in [('array',[row]),('value',{'value':[row]}),('items',{'items':[row]}),('diskImages',{'diskImages':[row]})]:
 class Response:
  status=200
  def __enter__(self):return self
  def __exit__(self,*args):pass
  def read(self,n):return json.dumps(body).encode()
 out=io.StringIO()
 with patch('subprocess.run',return_value=SimpleNamespace(returncode=0,stdout='eyJ.fixture.only')),patch('urllib.request.build_opener',return_value=SimpleNamespace(open=lambda *args,**kwargs:Response())),contextlib.redirect_stdout(out):
  runpy.run_path(str(b/'fixtures/inspect-canary-diskimage-identity.py'))
 result=json.loads(out.getvalue());checks['inventoryShape_'+name]=result['status']=='metadata_observed' and result['matches'][0]['state']=='Ready'
missing=[]
for f in [b/'checkpoint-126.md',b/'exact-image-canary-packet.md',b/'closure-report.md',b/'sandbox-access-handoff.md']:
 for link in re.findall(r'\]\(([^)]+)\)',f.read_text()):
  if not link.startswith(('https:','http:','#')) and not (f.parent/link.split('#')[0]).exists():missing.append(link)
checks['evidenceLinksResolve']=not missing
checks['diffWhitespace']=subprocess.run(['git','diff','--check']).returncode==0
result={'scope':'local preparation only; not live canary acceptance','checks':checks,'passed':all(checks.values()),'contractSHA256':hashlib.sha256((b/'fixtures/canary-126-contract.json').read_bytes()).hexdigest()}
(b/'receipts/checkpoint-126-packet-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2));assert result['passed']
