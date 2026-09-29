#!/usr/bin/env python3
"""Guards against tool-description drift across the TS/Python boundary.

The tool descriptions in tools.py are copied verbatim from
../agents/src/tools/db-tools.ts. They are prompt engineering: the model reads
them to decide whether to call a tool, and they were tuned against live
sessions. Because they are duplicated across a language boundary, nothing in
either compiler can notice when one side is edited and the other isn't — this
script is that check. Run it in CI, or after touching either file.

Exit 0 if every description matches byte for byte, 1 otherwise.
"""

from __future__ import annotations

import pathlib
import re
import sys

HERE = pathlib.Path(__file__).parent
TS = HERE.parent / "agents" / "src" / "tools" / "db-tools.ts"
PY = HERE / "tools.py"


def ts_descriptions(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    pattern = r"name:\s*'([a-z_]+)',\s*\n\s*description:\s*\n?\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)"
    for m in re.finditer(pattern, text):
        parts = re.findall(r"'((?:[^'\\]|\\.)*)'", m.group(2))
        out[m.group(1)] = "".join(parts).replace("\\'", "'").replace('\\"', '"')
    return out


def py_descriptions(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    pattern = r'name="([a-z_]+)",\s*\n\s*description=\(\s*\n((?:\s*"(?:[^"\\]|\\.)*"\s*\n)+)\s*\),'
    for m in re.finditer(pattern, text):
        parts = re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(2))
        out[m.group(1)] = "".join(parts)
    return out


def main() -> int:
    if not TS.exists():
        print(f"cannot find {TS}", file=sys.stderr)
        return 1

    ts = ts_descriptions(TS.read_text(encoding="utf-8"))
    py = py_descriptions(PY.read_text(encoding="utf-8"))

    if not ts or not py:
        # A parser that silently finds nothing would pass forever; treat it as failure.
        print(f"parsed {len(ts)} TS and {len(py)} Python descriptions — expected both non-empty")
        return 1

    failures = 0
    for name in sorted(set(ts) | set(py)):
        a, b = ts.get(name), py.get(name)
        if a is None:
            print(f"  only in tools.py     : {name}")
            failures += 1
        elif b is None:
            print(f"  only in db-tools.ts  : {name}")
            failures += 1
        elif a != b:
            print(f"  DRIFT {name}\n     ts: {a!r}\n     py: {b!r}")
            failures += 1
        else:
            print(f"  ok    {name}")

    print()
    if failures:
        print(f"{failures} tool description(s) out of sync")
        return 1
    print(f"all {len(ts)} tool descriptions identical")
    return 0


if __name__ == "__main__":
    sys.exit(main())
