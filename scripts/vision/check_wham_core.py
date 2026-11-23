"""Load official WHAM learned weights and exercise motion modules without SMPL assets.
This is a runtime smoke check with synthetic inputs, NOT video inference or an accuracy benchmark.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo', required=True, type=Path)
parser.add_argument('--device', choices=['cpu', 'mps'], default='cpu')
args = parser.parse_args()
repo = args.repo.resolve()
os.chdir(repo)
sys.path.insert(0, str(repo))
import torch
import numpy as np
import yaml
from lib.models.wham import Network

checkpoint_path = repo / 'checkpoints/wham_vit_bedlam_w_3dpw.pth.tar'
if not checkpoint_path.is_file():
    raise FileNotFoundError('Official checkpoint required; no random-weight fallback.')
with open(repo / 'configs/yamls/model_base.yaml') as stream:
    config = yaml.safe_load(stream)
config['d_feat'] = 1024
network = Network(None, **config)
with torch.serialization.safe_globals([np.core.multiarray.scalar, np.dtype, np.dtypes.Float64DType]):
    checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=True)
state = {k: v for k, v in checkpoint['model'].items() if not k.startswith('smpl.')}
network.load_state_dict(state, strict=True)
network.to(args.device).eval()
torch.manual_seed(0)
frames = 8
x = torch.zeros(1, frames, 37, device=args.device)
initial = torch.zeros(1, 1, 88, device=args.device)
root = torch.tensor([[[1., 0., 0., 0., 1., 0.]]], device=args.device)
angular = torch.zeros(1, frames, 6, device=args.device)
with torch.inference_mode():
    start = time.perf_counter()
    joints, context = network.motion_encoder(x, initial)
    rotations, velocities = network.trajectory_decoder(context, root, angular)
    if args.device == 'mps':
        torch.mps.synchronize()
    elapsed = (time.perf_counter() - start) * 1000
    assert all(torch.isfinite(v).all().item() for v in [joints, context, rotations, velocities])
print(json.dumps({
    'kind': 'synthetic-runtime-smoke', 'videoInference': False, 'accuracyMeasured': False,
    'device': args.device, 'torch': torch.__version__, 'frames': frames,
    'checkpointBytes': checkpoint_path.stat().st_size,
    'checkpointSha256': hashlib.file_digest(open(checkpoint_path, 'rb'), 'sha256').hexdigest(),
    'loadedLearnedParameters': sum(p.numel() for p in network.parameters()),
    'jointShape': list(joints.shape), 'velocityShape': list(velocities.shape),
    'firstCallMs': elapsed,
    'note': 'Only motion encoder and trajectory decoder executed. Synthetic zero inputs; no SMPL, RGB features, full-body decoding, contact refinement, or live latency measurement.',
}, indent=2))
