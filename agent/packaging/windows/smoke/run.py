"""Console entry point used by the Windows PowerShell launcher.

Kept as a tiny sibling of the harness so ``python smoke/run.py`` works from
the repository checkout without requiring the checkout to be installed as a
package.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from smoke_harness import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())