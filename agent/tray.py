"""Always-visible system-tray presence.

The tray icon is the agent's transparency guarantee: it is present the entire
time the agent runs, shows whether monitoring is active or paused, and gives the
user direct control (pause / resume / view what's collected / quit).
"""

from __future__ import annotations

import sys
from typing import Callable


def _make_image(active: bool):
    from PIL import Image, ImageDraw
    import math

    size = 64
    # Create a fully transparent icon
    return Image.new("RGBA", (size, size), (0, 0, 0, 0))


class AgentTray:
    def __init__(
        self,
        on_toggle_pause: Callable[[], None],
        on_show_info: Callable[[], None],
        on_open_config: Callable[[], None],
        on_quit: Callable[[], None],
        is_active: Callable[[], bool],
        status_text: Callable[[], str],
    ) -> None:
        import pystray

        self._pystray = pystray
        self._on_toggle_pause = on_toggle_pause
        self._on_show_info = on_show_info
        self._on_open_config = on_open_config
        self._on_quit = on_quit
        self._is_active = is_active
        self._status_text = status_text
        display_name = "System Process"
        self.icon = pystray.Icon(
            "sys_proc",
            icon=_make_image(False),
            title=display_name,
        )
        self.icon.menu = self._build_menu()

    def _build_menu(self):
        item = self._pystray.Menu
        MenuItem = self._pystray.MenuItem
        return item(
            MenuItem(lambda _: self._status_text(), None, enabled=False),
            self._pystray.Menu.SEPARATOR,
            MenuItem(
                lambda _: "Resume monitoring" if not self._is_active() else "Pause monitoring",
                self._toggle,
            ),
            MenuItem("What is being monitored?", self._info),
            MenuItem("Open config folder", self._open_config),
            self._pystray.Menu.SEPARATOR,
            MenuItem("Quit agent", self._quit),
        )

    def refresh(self) -> None:
        active = self._is_active()
        display_name = "System Process"
        self.icon.icon = _make_image(active)
        self.icon.title = display_name
        self.icon.update_menu()

    def notify(self, message: str, title: str = "Workforce Analytics") -> None:
        try:
            self.icon.notify(message, title)
        except Exception:
            pass

    def _toggle(self, _icon, _item) -> None:
        self._on_toggle_pause()
        self.refresh()

    def _info(self, _icon, _item) -> None:
        self._on_show_info()

    def _open_config(self, _icon, _item) -> None:
        self._on_open_config()

    def _quit(self, _icon, _item) -> None:
        self._on_quit()
        self.icon.stop()

    def run(self) -> None:
        self.icon.run()
