"""Prepare the isolated Xcode UI project; does not launch apps or servers."""
import argparse
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('output', type=Path)
parser.add_argument('--upstream-port', type=int, default=31993)
parser.add_argument('--proxy-port', type=int, default=31994)
args = parser.parse_args()
assert 1024 <= args.upstream_port <= 65535 and 1024 <= args.proxy_port <= 65535
assert args.upstream_port != args.proxy_port
here = Path(__file__).resolve().parent
root = here.parents[5]
out = args.output.resolve()
assert not out.exists(), 'Use a new task-owned directory; existing output is preserved'
out.mkdir(parents=True)
(out/'Tests').mkdir()
for template, target in [('project.template.yml','project.yml'), ('MatrixTests.swift','Tests/MatrixTests.swift'), ('native-matrix-proxy.mjs','native-matrix-proxy.mjs')]:
    value = (here/template).read_text().replace('__SOURCE_ROOT__', str(root))
    value = value.replace('31993',str(args.upstream_port)).replace('31994',str(args.proxy_port))
    (out/target).write_text(value)
subprocess.run(['xcodegen','generate','--spec',str(out/'project.yml'),'--project',str(out)],check=True)
print('Prepared local-only UI test project at ' + str(out))
print('Start generated native-matrix-proxy.mjs; it owns its loopback fixture child')
print('Run selected NativeInteractionTests/MatrixTests cases; scan interaction is still unverified')
