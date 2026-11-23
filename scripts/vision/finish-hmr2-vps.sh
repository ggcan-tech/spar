#!/usr/bin/env bash
set -euo pipefail
LAB=/opt/spar-vision
exec 9>"$LAB/hmr2.lock"
flock -n 9 || exit 0
# Wait for the initial bounded download started by this task, then resume its bytes.
while pgrep -f '^curl -fL --max-time 180 --silent --show-error https://www.cs.utexas.edu/~pavlakos/4dhumans/hmr2a_model.tar.gz' >/dev/null; do sleep 2; done
printf 'downloading\n' > "$LAB/hmr2.status"
trap 'printf "failed; inspect hmr2.log\n" > "$LAB/hmr2.status"' ERR
if [ ! -f "$LAB/hmr2a_model.tar.gz" ]; then
  curl -fL -C - --retry 5 --retry-all-errors --connect-timeout 20 --speed-limit 1024 --speed-time 90 --silent --show-error \
    https://www.cs.utexas.edu/~pavlakos/4dhumans/hmr2a_model.tar.gz -o "$LAB/hmr2a_model.tar.gz.download"
  mv "$LAB/hmr2a_model.tar.gz.download" "$LAB/hmr2a_model.tar.gz"
fi
printf 'extracting\n' > "$LAB/hmr2.status"
"$LAB/.venv/bin/python" - <<'PY'
import tarfile, shutil
from pathlib import Path
root=Path('/opt/spar-vision')
with tarfile.open(root/'hmr2a_model.tar.gz') as archive:
    candidates=[m for m in archive.getmembers() if m.isfile() and m.name.endswith('.ckpt')]
    if len(candidates)!=1:
        raise RuntimeError('Expected exactly one checkpoint; inspect archive before selecting one.')
    target=root/'WHAM/checkpoints/hmr2a.ckpt'
    with archive.extractfile(candidates[0]) as src, target.with_suffix('.partial').open('wb') as out:
        shutil.copyfileobj(src,out)
    target.with_suffix('.partial').replace(target)
PY
printf 'complete\n' > "$LAB/hmr2.status"
