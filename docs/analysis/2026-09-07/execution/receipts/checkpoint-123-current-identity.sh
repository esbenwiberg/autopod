#!/bin/sh
set -eu
python3 - <<'AUTOPOD_IDENTITY_PY'
import base64

import hashlib

import json

import os

import re

import selectors

import shutil

import signal

import stat

import subprocess

import tempfile

import time

import zlib

from pathlib import Path

ACTIVE = Path('/data/autopod/autopod.db')

ACTIVE_ID = (2049, 13107203)

SNAPSHOT = Path('/data/autopod/backups/1788930281287.db')

SNAPSHOT_BYTES = 877150208

SNAPSHOT_HASH = '3624d3be6ef845f4dded1b84be7bbe38891ca9d3b469c43db166e4dcdd473c68'

SERVICE_CWD = Path('/opt/autopod/releases/c0e5a5b4/packages/daemon')

CANDIDATE = '4e73cd8ce88e44cdb5c2d8d0a89447b819fa5a39'

MIGRATIONS_HASH = '0413c2b3502ce14cf74d164ac6fc474b91143101fd8599d4fea27c91ebb733bf'

ARTIFACTS = {'candidate-migrations.mjs', 'verify-upgrade-copy.mjs', 'verify-upgrade-copy-cli.mjs'}

def require(condition, code):
    if not condition:
        raise ValueError(code)

def file_hash(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source:
        value = hashlib.sha256()
        while block := source.read(1024 * 1024):
            value.update(block)
        return value.hexdigest()

def bounded_process(argv, cwd, seconds, output_limit=16384):
    """Own a new process group; reap the verifier before returning/cleanup."""
    process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               start_new_session=True,
                               env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    output = bytearray()
    deadline = time.monotonic() + seconds
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                require(time.monotonic() < deadline, 'process_timeout')
                for key, _ in selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                    block = os.read(key.fd, 4096)
                    if not block:
                        selector.unregister(key.fileobj)
                    else:
                        output.extend(block)
                        require(len(output) <= output_limit, 'process_output_limit')
            code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        return code, bytes(output)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        process.stdout.close()

def inspect():
    result={'status':'incomplete','activeDatabaseOpened':False,'privateCopyCreated':False}
    signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(TimeoutError()))
    signal.alarm(60)
    try:
        code,output=bounded_process(['systemctl','show','autopod-daemon','-p','MainPID','--value'],'/',10,128)
        require(code==0 and output.strip().isdigit(),'service_pid')
        pid=int(output); require(pid>1,'service_inactive')
        cwd=Path(f'/proc/{pid}/cwd').resolve(strict=True)
        require(re.fullmatch(r'/opt/autopod/releases/[a-f0-9]{8,40}/packages/daemon',str(cwd)),'unexpected_layout')
        result.update(servicePid=pid,serviceCwd=str(cwd),serviceCwdMatchesApproved=cwd==SERVICE_CWD)
        active=ACTIVE.lstat(); require(stat.S_ISREG(active.st_mode),'active_type')
        result.update(activeDevice=active.st_dev,activeInode=active.st_ino,activeIdentityMatchesApproved=(active.st_dev,active.st_ino)==ACTIVE_ID)
        matched=False
        with os.scandir(f'/proc/{pid}/fd') as entries:
            for index,entry in enumerate(entries):
                require(index<2048,'descriptor_limit')
                try:
                    opened=os.stat(entry.path)
                    matched |= (opened.st_dev,opened.st_ino)==(active.st_dev,active.st_ino)
                except FileNotFoundError: pass
        result['serviceHasActiveDescriptor']=matched
        node=Path(f'/proc/{pid}/exe').resolve(strict=True)
        code,output=bounded_process([str(node),'--version'],str(cwd),10,128)
        require(code==0 and re.fullmatch(rb'v[0-9]+\.[0-9]+\.[0-9]+\n?',output),'node_version')
        result['nodeVersion']=output.decode().strip()
        snap=SNAPSHOT.lstat()
        result['snapshotIdentityMatchesApproved']=stat.S_ISREG(snap.st_mode) and snap.st_nlink==1 and snap.st_size==SNAPSHOT_BYTES and SNAPSHOT.resolve()==SNAPSHOT and not Path(str(SNAPSHOT)+'-wal').exists() and not Path(str(SNAPSHOT)+'-journal').exists() and file_hash(SNAPSHOT)==SNAPSHOT_HASH
        st=os.statvfs(ACTIVE.parent)
        result['headroomMatchesApproved']=st.f_bavail*st.f_frsize>3*SNAPSHOT_BYTES+256*1024**2
        require(Path(f'/proc/{pid}/cwd').resolve(strict=True)==cwd,'service_changed')
        result['status']='current_identity_observed'
    except Exception:
        result['status']='incomplete'
    finally: signal.alarm(0)
    print(json.dumps(result,separators=(',',':')))
inspect()
AUTOPOD_IDENTITY_PY
