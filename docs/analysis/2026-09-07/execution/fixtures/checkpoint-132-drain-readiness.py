import datetime,json,subprocess,urllib.request,urllib.error,re,pathlib
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
out={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':'GET','path':'/maintenance/hosted-deploy-drain','mutations':False}
try:
 p=subprocess.run(['ap','token'],capture_output=True,text=True,timeout=30);token=p.stdout.strip();assert p.returncode==0 and token.startswith('eyJ') and token.count('.')==2
 q=urllib.request.Request('https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com/maintenance/hosted-deploy-drain',headers={'Authorization':'Bearer '+token})
 with urllib.request.build_opener(NoRedirect()).open(q,timeout=15) as r:
  raw=r.read(8193);assert len(raw)<=8192;v=json.loads(raw);out['httpStatus']=r.status;out['shapeMatched']=isinstance(v,dict) and 'active' in v
  if out['shapeMatched']:out['drainActive']=v['active'] is not None
except urllib.error.HTTPError as e:out['httpStatus']=e.code
except Exception:out['status']='unavailable'
pathlib.Path('/private/tmp/autopod-drain-readiness-132-result.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
