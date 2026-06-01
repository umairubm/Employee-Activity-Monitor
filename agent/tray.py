"""Always-visible system-tray presence.

The tray icon is the agent's transparency guarantee: it is present the entire
time the agent runs, shows whether monitoring is active or paused, and gives the
user direct control (pause / resume / view what's collected / quit).
"""

from __future__ import annotations

from typing import Callable


def _make_image(active: bool):
    from PIL import Image, ImageDraw

    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Green eye when active, grey when paused — instantly readable status.
    color = (34, 197, 94, 255) if active else (148, 163, 184, 255)
    draw.ellipse((6, 18, 58, 46), outline=color, width=4)
    draw.ellipse((26, 26, 38, 38), fill=color)
    return img


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
        self.icon = pystray.Icon(
            "workforce_agent",
            icon=_make_image(True),
            title="Workforce Analytics — monitoring active",
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
        self.icon.icon = _make_image(active)
        self.icon.title = (
            "Workforce Analytics — monitoring active"
            if active
            else "Workforce Analytics — monitoring PAUSED"
        )
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
