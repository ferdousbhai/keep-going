#!/usr/bin/env python3
"""Exercise the installer, package build and release provenance without touching system config or keys."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def executable(path, content):
    path.write_text('#!/bin/bash\nset -eu\n' + content)
    path.chmod(0o755)


def commit_fixture(root, tag=None):
    steps = [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']]
    if tag:
        steps.append(['tag', tag])
    for args in steps:
        subprocess.run(['git', *args], cwd=root, check=True)
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()


class InstallerTests(unittest.TestCase):
    # EUID is read-only in bash, so the root branch is reached by renaming it.
    def run_installer(self, as_root, sudo_user, migrate_fails=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'bin'
            binary.mkdir()
            etc = root / 'etc'
            (etc / 'pacman.d').mkdir(parents=True)
            (etc / 'pacman.conf').write_text('[options]\n')
            home = root / 'home'
            (home / '.config/omarchy').mkdir(parents=True)
            executable(binary / 'sudo', 'exec "$@"\n')
            executable(binary / 'chown', 'exit 0\n')
            executable(binary / 'install', 'while [[ $# -gt 0 ]]; do case "$1" in -d) shift;; -o|-g) shift 2;; *) mkdir -p "$1"; shift;; esac; done\n')
            executable(binary / 'curl', 'while [[ $1 != -o ]]; do shift; done; echo public-key > "$2"\n')
            executable(binary / 'gpg', "echo 'fpr:::::::::52130299581DAD685226900CA89CA1A6A1E74251:'\n")
            executable(binary / 'getent', f"echo \"$2:x:1000:1000::{home}:/bin/bash\"\n")
            executable(binary / 'id', 'case "$1" in -u) [[ ${2:-root} == root ]] && echo 0 || echo 1000 ;; -gn) echo users ;; -un) echo root ;; esac\n')
            for command in ('pacman-key', 'pacman', 'omarchy-pkg-add'):
                executable(binary / command, 'echo "$0 $*" >> "$CALL_LOG"\n')
            executable(binary / 'runuser', 'echo "runuser $*" >> "$CALL_LOG"; shift 3; exec "$@"\n')
            executable(binary / 'keep-going', f'echo "keep-going $* HOME=$HOME" >> "$CALL_LOG"; exit {1 if migrate_fails else 0}\n')
            source = (ROOT / 'packaging/repo/install.sh').read_text().replace('/etc/', f'{etc}/')
            if as_root:
                source = source.replace('EUID', 'TEST_EUID')
            script = root / 'install.sh'
            script.write_text(source)
            log = root / 'calls'
            env = dict(os.environ, PATH=f'{binary}:{os.environ["PATH"]}', CALL_LOG=str(log), USER='root', TEST_EUID='0')
            env.pop('SUDO_USER', None)
            if sudo_user:
                env['SUDO_USER'] = sudo_user
            result = subprocess.run(['bash', str(script)], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = log.read_text()
            self.assertIn('[keep-going]\nSigLevel = Required DatabaseRequired\n', (etc / 'pacman.d/keep-going.conf').read_text())
            self.assertIn(f'Include = {etc}/pacman.d/keep-going.conf', (etc / 'pacman.conf').read_text())
            self.assertTrue((home / '.config/omarchy/hooks/pre-refresh-pacman.d/keep-going').exists())
            self.assertIn('omarchy-pkg-add keep-going', calls)
            return calls, result

    def test_root_migrates_the_sudo_user(self):
        calls, _ = self.run_installer(as_root=True, sudo_user='alice')
        self.assertIn('runuser -u alice -- env HOME=', calls)
        self.assertIn('keep-going --migrate HOME=', calls)
        # The migration runs after the package is in place.
        self.assertLess(calls.index('omarchy-pkg-add'), calls.index('keep-going --migrate'))

    def test_desktop_user_migrates_directly(self):
        calls, _ = self.run_installer(as_root=False, sudo_user='alice')
        self.assertNotIn('runuser', calls)
        self.assertIn('keep-going --migrate', calls)

    def test_plain_root_registers_nothing(self):
        calls, _ = self.run_installer(as_root=True, sudo_user=None)
        self.assertNotIn('keep-going --migrate', calls)

    def test_failed_migration_still_installs(self):
        calls, result = self.run_installer(as_root=True, sudo_user='alice', migrate_fails=True)
        self.assertIn('keep-going --migrate', calls)
        self.assertIn('keep-going --migrate', result.stderr)


class VerificationTests(unittest.TestCase):
    def test_exact_release_and_native_architecture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'bin/verify-release').write_text((ROOT / 'bin/verify-release').read_text())
            executable(root / 'uname', 'echo aarch64\n')
            executable(root / 'bin/arch-run', 'printf "%s\\0" "$@" > "$CALL_LOG"\n')
            log = root / 'args'
            env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}', CALL_LOG=str(log))
            subprocess.run(['bash', str(root / 'bin/verify-release'), '0.4.2', 'aarch64'], env=env, check=True)
            args = log.read_bytes().decode().split('\0')[:-1]
            self.assertIn('KEEP_GOING_RELEASES_URL=https://github.com/ferdousbhai/keep-going/releases/download/v0.4.2', args)
            self.assertIn('EXPECTED_ARCH=aarch64', args)
            self.assertNotIn('releases/latest', '\n'.join(args))
            subprocess.run(['bash', '-n'], input=args[-1], text=True, check=True)
            log.unlink()
            result = subprocess.run(['bash', str(root / 'bin/verify-release'), '0.4.2', 'x86_64'], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(log.exists())


class PackageBuildTests(unittest.TestCase):
    def test_committed_source_and_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'packaging/aur/keep-going').mkdir(parents=True)
            (root / 'bin/build-package').write_text((ROOT / 'bin/build-package').read_text())
            (root / 'package.json').write_text('{\n  "name": "@ferdousbhai/keep-going",\n  "version": "0.4.2",\n  "type": "module"\n}\n')
            for relative in ('scripts/install.mjs', 'scripts/hosts.mjs', 'plugins/keep-going/scripts/keep-going.mjs', 'extensions/opencode.js'):
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(ROOT / relative, root / relative)
            recipe = root / 'packaging/aur/keep-going/PKGBUILD'
            recipe.write_text('pkgver=0.4.2\nsource=(original)\nsha256sums=(SKIP)\n')
            commit = commit_fixture(root)
            recipe.write_text('uncommitted recipe must not be built\n')
            mocks = root / 'mocks'
            mocks.mkdir()
            # Stands in for package(): the layout the real PKGBUILD installs.
            executable(mocks / 'makepkg', '''
grep -qx 'source=(source.tar.gz)' PKGBUILD
sum=$(sha256sum source.tar.gz | cut -d" " -f1)
grep -qx "sha256sums=('$sum')" PKGBUILD
tar -xzf source.tar.gz
lib=pkg/usr/lib/keep-going
mkdir -p "$lib"
cp -r keep-going-0.4.2/scripts keep-going-0.4.2/plugins keep-going-0.4.2/extensions "$lib/"
echo pacman > "$lib/system-package"
printf 'pkgname = keep-going\\npkgver = 0.4.2-1\\narch = any\\n' > pkg/.PKGINFO
tar -C pkg -czf "$PKGDEST/keep-going-0.4.2-1-any.pkg.tar.zst" .PKGINFO usr
''')
            executable(mocks / 'bsdtar', 'exec tar "$@"\n')
            output = root / 'output'
            env = dict(os.environ, PATH=f'{mocks}:{os.environ["PATH"]}')
            subprocess.run(['bash', str(root / 'bin/build-package'), str(output)], env=env, check=True)
            self.assertEqual((output / 'source-commit.txt').read_text().strip(), commit)

    def test_stale_pkgver_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'packaging/aur/keep-going').mkdir(parents=True)
            (root / 'bin/build-package').write_text((ROOT / 'bin/build-package').read_text())
            (root / 'package.json').write_text('{\n  "version": "0.4.2"\n}\n')
            (root / 'packaging/aur/keep-going/PKGBUILD').write_text('pkgver=0.4.1\n')
            commit_fixture(root)
            mocks = root / 'mocks'
            mocks.mkdir()
            executable(mocks / 'makepkg', 'echo built >> "$CALL_LOG"\n')
            # The refusal comes before any tool runs; CI's Ubuntu has no bsdtar.
            executable(mocks / 'bsdtar', 'exit 1\n')
            log = root / 'calls'
            env = dict(os.environ, PATH=f'{mocks}:{os.environ["PATH"]}', CALL_LOG=str(log))
            result = subprocess.run(['bash', str(root / 'bin/build-package'), str(root / 'output')], env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('pkgver', result.stderr)
            self.assertFalse(log.exists())


class ReleaseTests(unittest.TestCase):
    def run_release(self, failure=''):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'packaging/repo').mkdir(parents=True)
            (root / 'bin/release').write_text((ROOT / 'bin/release').read_text())
            (root / 'package.json').write_text('{\n  "name": "@ferdousbhai/keep-going",\n  "version": "0.4.2",\n  "type": "module"\n}\n')
            (root / 'packaging/repo/install.sh').write_text('installer fixture\n')
            commit = commit_fixture(root, 'v0.4.2')
            binary = root / 'mocks'
            binary.mkdir()
            log = root / 'calls'
            executable(binary / 'gh', '''
echo "gh $*" >> "$CALL_LOG"
case "$1 $2" in
  'api '*) echo "$COMMIT" ;;
  'run list') echo 123 ;;
  'run watch') [[ $FAILURE != ci ]] ;;
  'run view') printf '%s\\tpush\\tsuccess\\trelease\\n' "$COMMIT" ;;
  'run download')
    dest=${!#}; mkdir -p "$dest/meta"
    provenance=$COMMIT
    [[ $FAILURE != source ]] || provenance=wrong
    echo "$provenance" > "$dest/source-commit.txt"
    metadata_arch=any
    [[ $FAILURE != architecture ]] || metadata_arch=x86_64
    printf 'pkgname = keep-going\\npkgver = 0.4.2-1\\narch = %s\\n' "$metadata_arch" > "$dest/meta/.PKGINFO"
    tar -C "$dest/meta" -czf "$dest/keep-going-0.4.2-1-any.pkg.tar.zst" .PKGINFO ;;
  'release view') echo true ;;
esac
''')
            executable(binary / 'bsdtar', 'exec tar "$@"\n')
            executable(binary / 'gpg', '''
echo "gpg $*" >> "$CALL_LOG"
if [[ "$*" == *--detach-sign* ]]; then
  [[ $FAILURE != signing ]] || exit 1
  touch "${!#}.sig"
elif [[ "$*" == *--export* ]]; then echo public-key; fi
''')
            executable(binary / 'repo-add', '''
repo=${@: -2:1}
repo=${repo%.db.tar.gz}
for suffix in db.tar.gz db.tar.gz.sig files.tar.gz files.tar.gz.sig; do echo database > "$repo.$suffix"; done
for suffix in db db.sig files files.sig; do
  target=${suffix/.sig/}.tar.gz
  [[ $suffix != *.sig ]] || target+=.sig
  ln -s "$repo.$target" "$repo.$suffix"
done
''')
            env = dict(os.environ, PATH=f'{binary}:{os.environ["PATH"]}', CALL_LOG=str(log), COMMIT=commit, FAILURE=failure)
            result = subprocess.run(['bash', 'bin/release', '0.4.2'], cwd=root, env=env, capture_output=True, text=True)
            calls = log.read_text()
            if failure:
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('gh release upload', calls)
                if failure in ('source', 'architecture', 'ci'):
                    self.assertNotIn('--detach-sign', calls)
            else:
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                assets = next(root.glob('target/release-repo-*/assets'))
                self.assertTrue((assets / 'keep-going.db').is_file())
                self.assertFalse((assets / 'keep-going.db').is_symlink())
                self.assertTrue((assets / 'keep-going-signing-key.asc').exists())
                self.assertTrue((assets / 'keep-going-0.4.2-1-any.pkg.tar.zst.sig').exists())
                self.assertIn('gh release edit v0.4.2 --repo ferdousbhai/keep-going --draft=false --latest', calls)
                self.assertEqual((assets / 'install.sh').read_text(), 'installer fixture\n')

    def test_success(self): self.run_release()
    def test_wrong_source(self): self.run_release('source')
    def test_wrong_architecture(self): self.run_release('architecture')
    def test_ci_failure(self): self.run_release('ci')
    def test_signing_failure(self): self.run_release('signing')


if __name__ == '__main__':
    unittest.main()
