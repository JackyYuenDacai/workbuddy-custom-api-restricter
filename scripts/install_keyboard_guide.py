"""Back up and sync the keyboard skill to the user's two skill stores."""
from datetime import datetime
from pathlib import Path
import hashlib
import shutil

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'skills' / 'app-keyboard-workflows'
USER = Path('C:/Users/JackyYuen')

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    backup = ROOT / 'skill-backups' / ('keyboard-guide-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    backup.mkdir(parents=True)
    for store in ['.workbuddy', '.codex']:
        target = USER / store / 'skills' / SOURCE.name
        if target.exists():
            shutil.copytree(target, backup / store / SOURCE.name)
        shutil.copytree(SOURCE, target, dirs_exist_ok=True)
        files = [p for p in SOURCE.rglob('*') if p.is_file()]
        assert all(digest(p) == digest(target / p.relative_to(SOURCE)) for p in files)
        print(f'Installed and hash-verified {len(files)} files: {target}')

    # Only update the routing line, preserving all other installed parent changes.
    parent = USER / '.workbuddy/skills/windows-computer-use/SKILL.md'
    source_parent = ROOT / 'skills/windows-computer-use/SKILL.md'
    route = next(line for line in source_parent.read_text(encoding='utf-8').splitlines() if '[app-keyboard-workflows]' in line)
    content = parent.read_text(encoding='utf-8')
    lines = content.splitlines(keepends=True)
    indices = [i for i, line in enumerate(lines) if '[app-keyboard-workflows]' in line]
    assert len(indices) == 1, 'Expected exactly one existing supplementary skill route'
    shutil.copy2(parent, backup / 'windows-computer-use-SKILL.md')
    i = indices[0]
    lines[i] = route + ('\n' if lines[i].endswith('\n') else '')
    parent.write_text(''.join(lines), encoding='utf-8')
    assert route in parent.read_text(encoding='utf-8').splitlines()
    print(f'Updated WorkBuddy parent route. Backup: {backup}')

if __name__ == '__main__':
    main()
