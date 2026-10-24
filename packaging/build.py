#!/usr/bin/env python3
"""Build LightMeUp release packages.

    python packaging/build.py windows   # Windows installer (.exe) + portable .zip   (run on Windows)
    python packaging/build.py linux     # .deb + AppImage                            (run on Linux)
    python packaging/build.py deb       # just the .deb (needs only dpkg-deb, no PyInstaller)

Output goes to dist/. The Windows installer needs Inno Setup 6 (iscc) on PATH or in its default folder;
the PyInstaller builds need `pip install pyinstaller`.
"""
import os
import re
import shutil
import stat
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
DIST = ROOT / "dist"
ICONS = ROOT / "packaging" / "icons"
APPIMAGETOOL_URL = "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"


def version():
    m = re.search(r'^__version__ = "([^"]+)"', (ROOT / "server.py").read_text(encoding="utf-8"), re.M)
    return m.group(1)


def run(*cmd, **kw):
    print("+", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True, **kw)


def pyinstaller():
    """One-folder PyInstaller build of server.py with the web app bundled; returns the folder."""
    work = BUILD / "pyinstaller"
    shutil.rmtree(work, ignore_errors=True)
    icon = ICONS / ("lightmeup.ico" if os.name == "nt" else "lightmeup.png")
    run(sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--console",
        "--name", "LightMeUp", "--icon", icon,
        "--add-data", f"{ROOT / 'app'}{os.pathsep}app",
        "--distpath", work / "dist", "--workpath", work / "work", "--specpath", work,
        "--exclude-module", "tkinter", "--exclude-module", "unittest", "--exclude-module", "pydoc",
        ROOT / "server.py")
    return work / "dist" / "LightMeUp"


def copy_extras(dest):
    shutil.copytree(ROOT / "arduino", dest / "arduino", dirs_exist_ok=True)
    for name in ("README.md", "LICENSE", "CHANGELOG.md"):
        shutil.copy2(ROOT / name, dest / name)


# ---------- Windows ----------

def find_iscc():
    found = shutil.which("iscc")
    if found:
        return found
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
        if base and (Path(base) / "Inno Setup 6" / "ISCC.exe").exists():
            return str(Path(base) / "Inno Setup 6" / "ISCC.exe")
    sys.exit("Inno Setup 6 not found (install it, e.g. `choco install innosetup`).")


def build_windows():
    v = version()
    app = pyinstaller()
    copy_extras(app)
    DIST.mkdir(exist_ok=True)
    portable = DIST / f"LightMeUp-{v}-windows-x64-portable.zip"
    with zipfile.ZipFile(portable, "w", zipfile.ZIP_DEFLATED) as z:
        for f in app.rglob("*"):
            z.write(f, Path("LightMeUp") / f.relative_to(app))
    run(find_iscc(), f"/DAppVersion={v}", f"/DSourceDir={app}", f"/DOutputDir={DIST}",
        f"/DRepoRoot={ROOT}", ROOT / "packaging" / "windows" / "lightmeup.iss")
    print("built", portable.name, "and the installer in", DIST)


# ---------- Linux ----------

DESKTOP = """[Desktop Entry]
Type=Application
Name=LightMeUp
GenericName=Animatronic & Light Show Builder
Comment=Program singing skeletons and lights to music
Exec={exec}
Icon=lightmeup
Terminal=true
Categories=AudioVideo;Audio;Utility;
Keywords=DMX;sACN;E1.31;xLights;Halloween;Christmas;animatronic;servo;
"""


def write(path, text, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    path.chmod(mode)


def build_deb():
    """Architecture-independent .deb that runs server.py with the system Python."""
    v = version()
    pkg = BUILD / "deb" / f"lightmeup_{v}_all"
    shutil.rmtree(pkg.parent, ignore_errors=True)
    opt = pkg / "opt" / "lightmeup"
    opt.mkdir(parents=True)
    shutil.copy2(ROOT / "server.py", opt / "server.py")
    shutil.copytree(ROOT / "app", opt / "app")
    shutil.copytree(ROOT / "arduino", opt / "arduino")
    write(pkg / "usr/bin/lightmeup", '#!/bin/sh\nexec python3 /opt/lightmeup/server.py "$@"\n', 0o755)
    write(pkg / "usr/share/applications/lightmeup.desktop", DESKTOP.format(exec="lightmeup --open"))
    icon = pkg / "usr/share/icons/hicolor/256x256/apps/lightmeup.png"
    icon.parent.mkdir(parents=True)
    shutil.copy2(ICONS / "lightmeup.png", icon)
    unit = pkg / "usr/lib/systemd/system/lightmeup.service"
    unit.parent.mkdir(parents=True)
    shutil.copy2(ROOT / "packaging/linux/lightmeup.service", unit)
    doc = pkg / "usr/share/doc/lightmeup"
    write(doc / "copyright", "Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\n"
          "Upstream-Name: LightMeUp\nSource: https://github.com/pascalseguin/lightmeup\n\n"
          "Files: *\nCopyright: Pascal Seguin and LightMeUp contributors\nLicense: MIT\n\n"
          + (ROOT / "LICENSE").read_text(encoding="utf-8"))
    shutil.copy2(ROOT / "README.md", doc / "README.md")
    size_kb = sum(f.stat().st_size for f in pkg.rglob("*") if f.is_file()) // 1024
    write(pkg / "DEBIAN/control", f"""Package: lightmeup
Version: {v}
Section: utils
Priority: optional
Architecture: all
Depends: python3 (>= 3.8)
Installed-Size: {size_kb}
Maintainer: Pascal Seguin <pascal@phseguin.ca>
Homepage: https://github.com/pascalseguin/lightmeup
Description: Show builder for animatronic skeletons and DMX lights
 Point-and-click editor for programming singing skeletons and exterior
 lights to music. Auto lip sync from vocals, beat-driven lights, live
 E1.31/sACN output and .fseq export for Falcon Player and xLights.
""")
    DIST.mkdir(exist_ok=True)
    out = DIST / f"lightmeup_{v}_all.deb"
    run("dpkg-deb", "--root-owner-group", "--build", pkg, out)
    return out


APPRUN = """#!/bin/sh
# Started from a file manager there is no terminal; reopen in one so the window can be closed to stop the server.
HERE="$(dirname "$(readlink -f "$0")")"
if [ ! -t 0 ] && [ -z "$LIGHTMEUP_NO_TERMINAL" ] && [ -n "$APPIMAGE" ]; then
  export LIGHTMEUP_NO_TERMINAL=1
  for t in x-terminal-emulator gnome-terminal konsole xfce4-terminal mate-terminal xterm; do
    if command -v "$t" >/dev/null 2>&1; then
      case "$t" in
        gnome-terminal) exec gnome-terminal -- "$APPIMAGE" "$@" ;;
        *) exec "$t" -e "$APPIMAGE" "$@" ;;
      esac
    fi
  done
fi
exec "$HERE/usr/lib/lightmeup/LightMeUp" "$@"
"""


def build_appimage():
    v = version()
    app = pyinstaller()
    appdir = BUILD / "LightMeUp.AppDir"
    shutil.rmtree(appdir, ignore_errors=True)
    shutil.copytree(app, appdir / "usr/lib/lightmeup")
    write(appdir / "AppRun", APPRUN, 0o755)
    write(appdir / "lightmeup.desktop", DESKTOP.format(exec="LightMeUp"))
    shutil.copy2(ICONS / "lightmeup.png", appdir / "lightmeup.png")
    tool = BUILD / "appimagetool"
    if not tool.exists():
        print("downloading appimagetool")
        urllib.request.urlretrieve(APPIMAGETOOL_URL, tool)
        tool.chmod(tool.stat().st_mode | stat.S_IEXEC)
    DIST.mkdir(exist_ok=True)
    out = DIST / f"LightMeUp-{v}-x86_64.AppImage"
    run(tool, appdir, out, env={**os.environ, "ARCH": "x86_64", "APPIMAGE_EXTRACT_AND_RUN": "1"})
    return out


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else ""
    if target == "windows":
        build_windows()
    elif target == "linux":
        build_deb()
        build_appimage()
    elif target == "deb":
        build_deb()
    elif target == "appimage":
        build_appimage()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
