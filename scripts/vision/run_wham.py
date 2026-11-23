"""Headless WHAM integration entry point. Inspect dependencies with --check before inference.
No auto-download, no camera recording, no random-weight fallback. Uses the upstream video demo.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace

PIN = '2b54f7797391c94876848b905ed875b154c4a295'
ASSETS = [
    'dataset/body_models/smpl/SMPL_NEUTRAL.pkl',
    'dataset/body_models/J_regressor_wham.npy',
    'dataset/body_models/J_regressor_h36m.npy',
    'dataset/body_models/J_regressor_feet.npy',
    'dataset/body_models/smpl_mean_params.npz',
    'checkpoints/wham_vit_bedlam_w_3dpw.pth.tar',
    'checkpoints/hmr2a.ckpt',
    'checkpoints/yolov8x.pt',
    'checkpoints/vitpose-h-multi-coco.pth',
]
MODULES = ['torch', 'numpy', 'cv2', 'smplx', 'yacs', 'joblib', 'loguru', 'progress',
           'einops', 'mmcv', 'mmpose', 'ultralytics', 'scipy', 'yaml', 'timm', 'skimage', 'imageio', 'tensorboard']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--video', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--device', choices=['cpu', 'cuda'], default='cpu')
    parser.add_argument('--camera', choices=['fixed', 'moving'], default='fixed',
                        help='fixed is an explicit capture assumption, not an automatically detected state')
    args = parser.parse_args()
    repo = args.repo.resolve()
    commit = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    sys.path.insert(0, str(repo))
    sys.path.insert(0, str(repo / 'third-party/ViTPose'))
    missing_assets = [name for name in ASSETS if not (repo / name).is_file() or (repo / name).stat().st_size < 1024]
    if args.camera == 'moving' and not (repo / 'checkpoints/dpvo.pth').is_file():
        missing_assets.append('checkpoints/dpvo.pth')
    missing_modules = [name for name in MODULES if importlib.util.find_spec(name) is None]
    report = {'sourceCommit': commit, 'expectedCommit': PIN, 'device': args.device,
              'cameraAssumption': args.camera, 'missingAssets': missing_assets,
              'missingModules': missing_modules, 'freeBytes': shutil.disk_usage(repo).free,
              'inferenceRun': False,
              'note': 'Preflight checks presence only, not package/weight compatibility. CPU path is a port candidate, not validated real-time support.'}
    if args.check:
        print(json.dumps(report, indent=2))
        return 0 if commit == PIN and not missing_assets and not missing_modules else 2
    if commit != PIN or missing_assets or missing_modules:
        print(json.dumps(report, indent=2), file=sys.stderr)
        raise RuntimeError('WHAM prerequisites incomplete; inference has not started. Run --check.')
    if args.video is None or not args.video.is_file() or args.output is None:
        raise ValueError('--video must be an existing local file; --output is required.')
    video, output = args.video.resolve(), args.output.resolve()
    # Never reuse another video's cached preprocessing or overwrite an existing result.
    output.mkdir(parents=True, exist_ok=False)
    os.chdir(repo)
    config_dir = repo.parent / 'yolo-config'
    config_dir.mkdir(exist_ok=True)
    os.environ['YOLO_CONFIG_DIR'] = str(config_dir)
    import torch
    import numpy as np
    import cv2
    import yaml
    if args.device == 'cuda' and not torch.cuda.is_available():
        raise RuntimeError('CUDA explicitly selected but unavailable.')
    from configs.config import get_cfg_defaults
    from configs import constants
    from lib.models import build_body_model
    from lib.models.wham import Network
    import demo

    cfg = get_cfg_defaults()
    cfg.merge_from_file('configs/yamls/demo.yaml')
    cfg.DEVICE = args.device
    cfg.FLIP_EVAL = False
    smpl = build_body_model(cfg.DEVICE, cfg.TRAIN.BATCH_SIZE * cfg.DATASET.SEQLEN)
    with open(cfg.MODEL_CONFIG) as stream:
        model_cfg = yaml.safe_load(stream)
    model_cfg['d_feat'] = constants.IMG_FEAT_DIM[cfg.MODEL.BACKBONE]
    network = Network(smpl, **model_cfg).to(cfg.DEVICE)
    # Only load checkpoints obtained from the official model source. Older WHAM archives use pickle.
    with torch.serialization.safe_globals([np.core.multiarray.scalar, np.dtype, np.dtypes.Float64DType]):
        checkpoint = torch.load(cfg.TRAIN.CHECKPOINT, map_location='cpu', weights_only=True)
    ignored = {'smpl.body_pose', 'smpl.betas', 'smpl.global_orient', 'smpl.J_regressor_extra', 'smpl.J_regressor_eval'}
    state = {key: value for key, value in checkpoint['model'].items() if key not in ignored}
    incompatible = network.load_state_dict(state, strict=False)
    missing_learned = [key for key in incompatible.missing_keys if not key.startswith('smpl.')]
    if missing_learned or incompatible.unexpected_keys:
        raise RuntimeError(f'Checkpoint architecture mismatch: {missing_learned}, {incompatible.unexpected_keys}')
    network.eval()
    demo.args = SimpleNamespace(run_smplify=False)
    if args.camera == 'fixed':
        class FixedCamera:
            def __init__(self, video_path, *_):
                cap = cv2.VideoCapture(str(video_path))
                if not cap.isOpened():
                    raise RuntimeError('Cannot open video.')
                self.length = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                cap.release()
                if self.length < 2:
                    raise ValueError('Video needs at least two frames.')
            def track(self):
                pass
            def process(self):
                result = np.zeros((self.length, 7))
                result[:, 6] = 1.0  # DPVO quaternion ordering is x, y, z, w
                return result
        # Fixed-camera angular motion is identity by explicit user-supplied capture condition.
        # This bypasses CUDA-only DPVO, not global motion estimation or its uncertainty.
        demo.SLAMModel = FixedCamera
        demo._run_global = True
    elif not demo._run_global:
        raise RuntimeError('Moving-camera run requires working DPVO; refusing local-only fallback.')
    manifest = {**report, 'missingAssets': [], 'missingModules': [], 'timing': 'offline',
                'flipEvaluation': False, 'temporalSmplify': False, 'video': str(video),
                'worldRegistration': 'unregistered model trajectory; not shared room coordinates',
                'status': 'started'}
    manifest_path = output / 'spar-run.json'
    manifest_path.write_text(json.dumps(manifest, indent=2))
    try:
        demo.run(cfg, str(video), str(output), network, run_global=True, save_pkl=True, visualize=False)
        manifest['status'] = 'complete'
        manifest['inferenceRun'] = True
    except Exception as error:
        manifest['status'] = 'failed'
        manifest['error'] = str(error)
        raise
    finally:
        manifest_path.write_text(json.dumps(manifest, indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(f'WHAM: {error}', file=sys.stderr)
        sys.exit(1)
