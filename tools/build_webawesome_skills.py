#!/usr/bin/env python3
"""Build the cybermole Web Awesome documentation skills from the installed package.

Web Awesome (this app's UI toolkit) ships two Agent Skills inside the npm
package, generated from the Custom Elements Manifest on every release — so
they document the exact component API of the version pinned in
package-lock.json:

  webawesome/          the component reference: per-component API (properties,
                      events, methods, slots, CSS parts/custom properties),
                      installation, usage, form controls, tokens, themes,
                      utilities, framework wrappers
  webawesome-design/  design/composition guidance: <wa-page> vs layout
                      utilities, palettes + theming, --wa-* design tokens,
                      building a project design system on top

This script copies both from node_modules into .agents/skills/ (where pi
picks up project-local skills), so they are version-locked to the installed
dependency and greppable without the node tree. Committed to the repo, like
the gtk-vibes doc skills.

Usage:  python3 tools/build_webawesome_skills.py

Re-run after `npm install` / `npm update` bumps @awesome.me/webawesome
(the script refuses to run against a package that doesn't ship skills).
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG_DIR = ROOT / "node_modules" / "@awesome.me" / "webawesome"
SRC = PKG_DIR / "dist" / "skills"
SKILLS = ROOT / ".agents" / "skills"

EXPECTED = ("webawesome", "webawesome-design")


def package_version() -> str:
    pkg = PKG_DIR / "package.json"
    if not pkg.exists():
        sys.exit(f"error: {PKG_DIR} not found — run `npm install` first")
    return json.loads(pkg.read_text(encoding="utf-8"))["version"]


def main() -> int:
    if not SRC.is_dir():
        sys.exit(
            f"error: {SRC} does not exist — this @awesome.me/webawesome "
            "build doesn't ship skills (or node_modules is stale); "
            "try `npm install @awesome.me/webawesome`"
        )

    version = package_version()
    print(f"@awesome.me/webawesome {version} — copying skills to {SKILLS.relative_to(ROOT)}/")

    for name in EXPECTED:
        src = SRC / name
        if not (src / "SKILL.md").is_file():
            sys.exit(f"error: {src / 'SKILL.md'} missing — unexpected package layout")

        # The shipped frontmatter must stay intact for pi to parse it; just
        # verify it declares the expected skill name.
        front = (src / "SKILL.md").read_text(encoding="utf-8")
        if not re.search(rf"^name:\s*{re.escape(name)}\s*$", front, re.M):
            sys.exit(f"error: {name}/SKILL.md doesn't declare `name: {name}`")

        dest = SKILLS / name
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest)

        files = sum(1 for f in dest.rglob("*") if f.is_file())
        components = sorted(
            f.stem for f in (dest / "references" / "components").glob("*.md")
        ) if (dest / "references" / "components").is_dir() else []
        comp_note = f", {len(components)} component refs" if components else ""
        print(f"  {name:<22} {files:>3} files{comp_note}")

    print("done. Commit the result; rerun whenever the dependency is bumped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
