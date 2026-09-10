import datetime,json,subprocess,urllib.request,urllib.error,re
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
r={'observedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mutations':False}
def get(url,token=None,limit=1048576):
    req=urllib.request.Request(url,headers={'Authorization':'Bearer '+token} if token else {})
    try:
        with opener.open(req,timeout=20) as response:
            raw=response.read(limit+1)
            return response.status,json.loads(raw) if len(raw)<=limit else None
    except urllib.error.HTTPError as e:return e.code,None
    except Exception:return 'unavailable',None
status,body=get('https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com/health',limit=65536)
r['health']={'status':status,'releaseFieldPresent':isinstance(body,dict) and 'release' in body}
if isinstance(body,dict) and isinstance(body.get('release'),dict):
    v=body['release'];sha=v.get('commitSha');r['health']['releaseCommitSha']=sha if isinstance(sha,str) and re.fullmatch('[a-f0-9]{40}',sha) else None
    r['health']['releaseDirty']=v.get('dirty') if isinstance(v.get('dirty'),bool) else None
url='https://management.northeurope.azuredevcompute.io/subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/sandboxGroups/autopod-spike-neu/diskimages?api-version=2026-02-01-preview'
try:
    auth=subprocess.run(['az','account','get-access-token','--resource','https://dynamicsessions.io/','--query','accessToken','--output','tsv'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=30)
    token=auth.stdout.strip()
    if auth.returncode or not token.startswith('eyJ') or token.count('.')!=2:raise ValueError('auth_unavailable')
    status,body=get(url,token)
    r['sandboxDiskImages']={'status':status,'group':'autopod-spike-neu','sourceDigest':'sha256:4b836cdabc71ffd40aef564b65b6b16564c5312770130bc59251a732078c9d77','matches':[]}
    if isinstance(body,dict):
        entries=body.get('value',body.get('diskImages',[]))
        r['sandboxDiskImages']['recognizedList']=isinstance(entries,list)
        r['sandboxDiskImages']['paginationPresent']=bool(body.get('nextLink'))
        for item in entries[:100] if isinstance(entries,list) else []:
            if not isinstance(item,dict):continue
            labels=item.get('labels',{})
            if not isinstance(labels,dict) or labels.get('sourceDigest')!=r['sandboxDiskImages']['sourceDigest']:continue
            state=item.get('status',{});state=state.get('state') if isinstance(state,dict) else None
            name=item.get('id')
            r['sandboxDiskImages']['matches'].append({'id':name if isinstance(name,str) and re.fullmatch(r'[A-Za-z0-9._/-]{1,2048}',name) else None,'state':state if state in ['Ready','ready','Failed','failed','Provisioning','provisioning'] else 'unrecognized'})
except Exception:r['sandboxDiskImages']={'status':'existing_auth_or_read_unavailable'}
print(json.dumps(r,separators=(',',':')))
