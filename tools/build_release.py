"""Package the unpacked Chrome extension into a ZIP with manifest.json at its root.

    python tools/build_release.py                      # public build, starts with an empty queue
    python tools/build_release.py --with-bundled-list  # private build that ships extension/bundled-papers.json

The ZIP can be attached to a GitHub release, unpacked for "Load unpacked",
or uploaded to the Chrome Web Store developer dashboard.
"""
from pathlib import Path
import argparse
import json
import zipfile

ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / 'extension'
REQUIRED = ['manifest.json', 'background.js', 'core.js', 'content.js', 'dashboard.html', 'dashboard.js', 'dashboard.css',
            'ui-effects.js', 'importers.js', 'file-dedup.js', 'cleanup-ui.js', 'report-csv.js', 'report-docx.js',
            'fonts/wenxian-serif.woff2', 'fonts/OFL.txt', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png']

parser = argparse.ArgumentParser()
parser.add_argument('--with-bundled-list', action='store_true', help='include extension/bundled-papers.json')
parser.add_argument('--out', type=Path, default=ROOT / 'dist')
args = parser.parse_args()

manifest = json.loads((EXTENSION / 'manifest.json').read_text(encoding='utf-8'))
suffix = '-with-list' if args.with_bundled_list else ''
output = args.out / f"literature-batch-assistant-v{manifest['version']}{suffix}.zip"
args.out.mkdir(parents=True, exist_ok=True)

files = sorted(path for path in EXTENSION.rglob('*') if path.is_file())
if not args.with_bundled_list:
    files = [path for path in files if path.name != 'bundled-papers.json']
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for path in files:
        archive.write(path, path.relative_to(EXTENSION).as_posix())

with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    names = set(archive.namelist())
    missing = [name for name in REQUIRED if name not in names]
    assert not missing, f'missing from release: {missing}'
    assert json.loads(archive.read('manifest.json'))['manifest_version'] == 3
    bundled = 'bundled-papers.json' in names
    assert bundled == args.with_bundled_list, 'bundled list presence does not match the requested build'
    papers = len(json.loads(archive.read('bundled-papers.json'))['papers']) if bundled else 0

print(json.dumps({'archive': str(output.relative_to(ROOT)), 'bytes': output.stat().st_size, 'files': len(files),
                  'version': manifest['version'], 'bundledPapers': papers}, ensure_ascii=False, indent=2))
