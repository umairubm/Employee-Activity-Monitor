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
        active_title: str = "Workforce Analytics — monitoring active",
        paused_title: str = "Workforce Analytics — monitoring PAUSED",
        toggle_active_label: str = "Pause monitoring",
        toggle_paused_label: str = "Resume monitoring",
        quit_label: str = "Quit agent",
        app_name: str = "Workforce Analytics",
        include_info: bool = True,
        include_config: bool = True,
    ) -> None:
        import pystray

        self._pystray = pystray
        self._on_toggle_pause = on_toggle_pause
        self._on_show_info = on_show_info
        self._on_open_config = on_open_config
        self._on_quit = on_quit
        self._is_active = is_active
        self._status_text = status_text
        # Labels/titles are parameterised so the same tray serves the employee
        # wording ("Pause/Resume monitoring") and the friendlier freelancer
        # wording ("Start/Stop work"); defaults preserve the original strings.
        self._active_title = active_title
        self._paused_title = paused_title
        self._toggle_active_label = toggle_active_label
        self._toggle_paused_label = toggle_paused_label
        self._quit_label = quit_label
        self._app_name = app_name
        # Optional menu items. Default True keeps the original employee menu; the
        # freelancer build hides them for a minimal Start/Stop/Kill menu.
        self._include_info = include_info
        self._include_config = include_config
        self.icon = pystray.Icon(
            "workforce_agent",
            icon=_make_image(True),
            title=active_title,
        )
        self.icon.menu = self._build_menu()

    def _build_menu(self):
        Menu = self._pystray.Menu
        MenuItem = self._pystray.MenuItem
        items = [
            MenuItem(lambda _: self._status_text(), None, enabled=False),
            Menu.SEPARATOR,
            MenuItem(
                lambda _: self._toggle_paused_label
                if not self._is_active()
                else self._toggle_active_label,
                self._toggle,
            ),
        ]
        if self._include_info:
            items.append(MenuItem("What is being monitored?", self._info))
        if self._include_config:
            items.append(MenuItem("Open config folder", self._open_config))
        items.append(Menu.SEPARATOR)
        items.append(MenuItem(self._quit_label, self._quit))
        return Menu(*items)

    def refresh(self) -> None:
        active = self._is_active()
        self.icon.icon = _make_image(active)
        self.icon.title = self._active_title if active else self._paused_title
        self.icon.update_menu()

    def notify(self, message: str, title: str | None = None) -> None:
        try:
            self.icon.notify(message, title or self._app_name)
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

    def stop(self) -> None:
        """Stop the tray event loop (safe for remote-update shutdown)."""
        self.icon.stop()
