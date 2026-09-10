import json,subprocess,urllib.request,urllib.error,datetime,hashlib,re
IMAGE='ewiautopodacr.azurecr.io/autopod/dataverse-harness:latest'
DIGEST='sha256:4b836cdabc71ffd40aef564b65b6b16564c5312770130bc59251a732078c9d77'
IMAGE_HASH=hashlib.sha256(IMAGE.encode()).hexdigest()[:16]
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
r={'observedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceImage':IMAGE,'historicalSourceDigest':DIGEST,'sourceImageHash':IMAGE_HASH,'mutations':False,'matches':[]}
try:
    a=subprocess.run(['az','account','get-access-token','--resource','https://dynamicsessions.io/','--query','accessToken','--output','tsv'],capture_output=True,text=True,timeout=30)
    token=a.stdout.strip()
    assert a.returncode==0 and token.startswith('eyJ') and token.count('.')==2
    url='https://management.northeurope.azuredevcompute.io/subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/sandboxGroups/autopod-spike-neu/diskimages?api-version=2026-02-01-preview'
    req=urllib.request.Request(url,headers={'Authorization':'Bearer '+token})
    with urllib.request.build_opener(NoRedirect()).open(req,timeout=20) as resp:
        raw=resp.read(1048577);r['httpStatus']=resp.status
    assert len(raw)<=1048576
    body=json.loads(raw)
    if isinstance(body,list):entries=body;r['responseShape']='array';r['paginationPresent']=False
    elif isinstance(body,dict):
        key=next((k for k in ['value','items','diskImages'] if isinstance(body.get(k),list)),None)
        assert key is not None
        entries=body[key];r['responseShape']=key;r['paginationPresent']=bool(body.get('nextLink'))
    else:raise ValueError('unsupported_shape')
    r['entryCount']=len(entries);r['truncated']=len(entries)>100
    for row in entries[:100]:
        if not isinstance(row,dict):continue
        props=row.get('properties',{});props=props if isinstance(props,dict) else {}
        labels=row.get('labels',props.get('labels',{}));labels=labels if isinstance(labels,dict) else {}
        if labels.get('sourceDigest')!=DIGEST and labels.get('sourceImageHash')!=IMAGE_HASH:continue
        ident=row.get('id',row.get('name'));status=row.get('status',props.get('status',{}));state=status.get('state') if isinstance(status,dict) else None
        digest=labels.get('sourceDigest');name=labels.get('name')
        r['matches'].append({'id':ident if isinstance(ident,str) and re.fullmatch(r'[A-Za-z0-9._/-]{1,1024}',ident) else None,'state':state if isinstance(state,str) and re.fullmatch('[A-Za-z]{1,40}',state) else None,'sourceDigest':digest if isinstance(digest,str) and re.fullmatch(r'sha256:[a-f0-9]{64}',digest) else None,'sourceImageHashMatches':labels.get('sourceImageHash')==IMAGE_HASH,'managedByAutopod':labels.get('managedBy')=='autopod','name':name if isinstance(name,str) and re.fullmatch(r'[A-Za-z0-9._-]{1,128}',name) else None})
        assert len(r['matches'])<=10
    r['status']='metadata_observed'
except urllib.error.HTTPError as e:r.update(status='http_refused',httpStatus=e.code)
except Exception:r['status']='incomplete'
print(json.dumps(r,separators=(',',':')))
