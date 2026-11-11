"""Prepare the pinned official Windows x64 Mihomo sidecar for packaging."""
import hashlib
import io
from pathlib import Path
import urllib.request
import zipfile

URL = 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.33/mihomo-windows-amd64-v1-v1.19.33.zip'
ARCHIVE_SHA256 = 'fb0b960eff568459502d4ebe53e9cca203053d86ec9024fe935f19615d74d9aa'
EXE_SHA256 = 'a4fbf2b8bc2b5416ce2d0d392ac59f2e0a234ea4fcf635b66bd21e62ea9641b9'
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'sidecars/mihomo/bin/mihomo-x86_64-pc-windows-msvc.exe'

def main():
    if OUT.is_file() and hashlib.sha256(OUT.read_bytes()).hexdigest() == EXE_SHA256:
        print('Pinned Mihomo sidecar is ready.')
        return
    request = urllib.request.Request(URL, headers={'User-Agent': 'C-le-console-build'})
    with urllib.request.urlopen(request, timeout=120) as response:
        data = response.read(40_000_001)
    if len(data) > 40_000_000 or hashlib.sha256(data).hexdigest() != ARCHIVE_SHA256:
        raise RuntimeError('Mihomo archive size or SHA-256 mismatch; nothing installed.')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        executable = archive.read('mihomo-windows-amd64-v1.exe')
    if hashlib.sha256(executable).hexdigest() != EXE_SHA256:
        raise RuntimeError('Mihomo executable SHA-256 mismatch; nothing installed.')
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(executable)
    print('Pinned Mihomo sidecar prepared:', OUT)

if __name__ == '__main__':
    main()
