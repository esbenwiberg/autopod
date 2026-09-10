import datetime,json,pathlib,subprocess,urllib.request,urllib.error,shlex
ident='12b21a50-930d-4a0c-8e3a-d99f872e73b4';pod='middle-tahr'
base='https://management.northeurope.azuredevcompute.io/subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/sandboxGroups/autopod-spike-neu/sandboxes/'+ident
p=subprocess.run(['az','account','get-access-token','--resource','https://dynamicsessions.io/','-o','json'],capture_output=True,text=True,timeout=30);assert p.returncode==0;token=json.loads(p.stdout)['accessToken']
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*a,**kw):return None
def req(suffix='',body=None):
 r=urllib.request.Request(base+suffix+'?api-version=2026-02-01-preview',data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,**({'Content-Type':'application/json'} if body is not None else {})})
 try:
  with urllib.request.build_opener(NoRedirect()).open(r,timeout=45) as res:
   raw=res.read(256*1024+1);assert len(raw)<=256*1024;return json.loads(raw)
 except urllib.error.HTTPError as e:
  raw=e.read(4096);print(json.dumps({'httpStatus':e.code,'error':raw.decode(errors='replace')}));raise SystemExit(1)
x=req();assert x['id']==ident and x['labels']['podId']==pod and x['labels']['managedBy']=='autopod'
commands=[['curl','--silent','--show-error','--max-time','12','--output','/dev/null','--write-out','health_http=%{http_code}\n','https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com/health'],['sh','-c','id; ps -eo pid,comm | head -20; test ! -f /etc/haproxy/haproxy.cfg || sed -n "1,150p" /etc/haproxy/haproxy.cfg']]
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'id':ident,'ownershipMatched':True,'resource':{k:v for k,v in x.items() if k in ['image','imageId','state','status','properties']},'checks':[]}
for c in commands:
 v=req('/executeShellCommand',{'command':shlex.join(c),'user':'autopod'});out['checks'].append(v)
pathlib.Path('/private/tmp/autopod-rollout-134/canary-connectivity.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
