"""PyInstaller entry point for system service variant."""

from agent.agent_system_service import main

if __name__ == "__main__":
    raise SystemExit(main())
