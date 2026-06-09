"""PyInstaller entry point.

Kept separate from ``agent/agent.py`` so the frozen build always imports the
agent as a proper package (``agent.*``), regardless of how the source tree is
laid out at build time.
"""

from agent.agent import main

if __name__ == "__main__":
    raise SystemExit(main())
