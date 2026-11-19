"""Run the normal Codex report worker with only the host-pinned case's files."""
import argparse
import json
import os
from pathlib import Path
import re
import runpy
import stat
import sys
import tempfile


def case_data(root, case):
    if not re.fullmatch(r'[A-Z][A-Z0-9_]{0,31}', case):
        raise ValueError('case-name-invalid')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    repository = os.open(root, flags)
    try:
        directory = os.open(case, flags, dir_fd=repository)
    finally:
        os.close(repository)
    try:
        names = sorted(os.listdir(directory))
        if not 1 <= len(names) <= 16:
            raise ValueError('case-file-count')
        files = {}
        remaining = 16 * 1024
        for name in names:
            if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}', name):
                raise ValueError('case-filename')
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            with os.fdopen(fd, 'rb') as f:
                st = os.fstat(f.fileno())
                if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > remaining:
                    raise ValueError('case-file-invalid')
                data = f.read(remaining + 1)
                if len(data) != st.st_size or b'\0' in data:
                    raise ValueError('case-file-invalid')
            remaining -= len(data)
            files[name] = data.decode('utf-8')
        return json.dumps({'case': case, 'files': files}, ensure_ascii=False, separators=(',', ':'))
    finally:
        os.close(directory)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--case', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--reasoning', required=True)
    parser.add_argument('objective')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='managed-case-') as temp:
        data = Path(temp) / 'case.json'
        data.write_text(case_data(args.repository, args.case), encoding='utf-8')
        sys.argv = ['codex_worker.py', '--readme', str(data), '--model', args.model,
                    '--reasoning', args.reasoning, '--', args.objective +
                    '\nUse only the following frozen case files. Return the report text; the host writes the report.']
        runpy.run_path(str(Path(__file__).with_name('codex_worker.py')), run_name='__main__')
