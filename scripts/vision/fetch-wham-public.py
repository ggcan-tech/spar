"""Download only the public assets linked by pinned upstream WHAM fetch_demo_data.sh."""
from pathlib import Path
import argparse
import tarfile
import gdown

parser = argparse.ArgumentParser()
parser.add_argument('--repo', type=Path, required=True)
args = parser.parse_args()
repo = args.repo.resolve()
assets = {
    'wham_vit_bedlam_w_3dpw.pth.tar': '19qkI-a6xuwob9_RFNSPWf1yWErwVVlks',
    'hmr2a.ckpt': '1J6l8teyZrL0zFzHhzkC7efRhU0ZJ5G9Y',
    'yolov8x.pt': '1zJ0KP23tXD42D47cw1Gs7zE2BA_V_ERo',
    'vitpose-h-multi-coco.pth': '1xyF7F3I7lWtdq82xmEPVQ5zl4HaasBso',
}
(repo / 'checkpoints').mkdir(exist_ok=True)
for name, file_id in assets.items():
    destination = repo / 'checkpoints' / name
    if destination.is_file():
        print(f'Already present: {name}', flush=True)
        continue
    partial = destination.with_name(destination.name + '.download')
    print(f'Downloading: {name}', flush=True)
    result = gdown.download(id=file_id, output=str(partial), quiet=True, use_cookies=False)
    if not result:
        raise RuntimeError(f'Official download failed: {name}')
    partial.replace(destination)
aux = repo.parent / 'wham-body-aux.tar.gz'
if not aux.exists():
    if not gdown.download(id='1pbmzRbWGgae6noDIyQOnohzaVnX_csUZ', output=str(aux), quiet=True, use_cookies=False):
        raise RuntimeError('Auxiliary download failed')
(repo / 'dataset').mkdir(exist_ok=True)
with tarfile.open(aux) as archive:
    # The conversion matrix is not used by this WHAM SMPL pipeline (578 MB uncompressed).
    members = [m for m in archive.getmembers() if not m.name.endswith('smplx2smpl.pkl')]
    archive.extractall(repo / 'dataset', members=members, filter='data')
print('Public assets prepared. SMPL_NEUTRAL.pkl is separately licensed; not downloaded.', flush=True)
