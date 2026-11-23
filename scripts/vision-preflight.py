"""Read-only GEM-X source/storage preflight; downloads metadata, never models or user data."""
import argparse
import json
import shutil
import subprocess
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--repo', type=Path, required=True)
args = parser.parse_args()
repo = args.repo.resolve()
commit = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
with urllib.request.urlopen('https://huggingface.co/api/models/nvidia/GEM-X/tree/main/onnx', timeout=30) as response:
    files = json.load(response)
models = [{'path': item['path'], 'bytes': item['size']} for item in files if item.get('type') == 'file']
required = sum(item['bytes'] for item in models)
free = shutil.disk_usage(repo).free
# Additional weights, Python, conversion temporaries and OS breathing room are not in ONNX sizes.
reserve = 8 * 1024**3
source = (repo / 'scripts/demo/demo_soma_onnx.py').read_text()
print(json.dumps({
    'repo': str(repo), 'commit': commit, 'onnxFiles': models,
    'allOnnxBytes': required, 'freeBytes': free, 'additionalReserveBytes': reserve,
    'fullOnnxStoragePreflightPass': free >= required + reserve,
    'demoRequiresVideoPath': 'video_path.exists()' in source,
    'referencedWebcamScriptExists': (repo / 'scripts/demo/demo_webcam.py').exists(),
    'note': 'Storage gate only, not a runtime compatibility check. Reserve is a conservative local policy, not a vendor requirement. Subset pipelines need their own measured storage budget.',
}, indent=2))
