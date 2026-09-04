import re

with open('agent/agent.py', 'r') as f:
    content = f.read()

# 1. Add _pending_os_commands = {} in __init__
if "_pending_os_commands" not in content:
    content = content.replace(
        "self._paused = threading.Event()",
        "self._paused = threading.Event()\n        self._pending_os_commands = {}"
    )

# 2. Modify _handle_command to schedule restart/shutdown
old_handle_cmd = """            elif ctype in ("lock_screen", "logout_user", "restart", "shutdown"):
                self.api.ack_command(cid, "acknowledged")
                self._execute_os_command(ctype)
                self.api.ack_command(cid, "completed")"""

new_handle_cmd = """            elif ctype in ("lock_screen", "logout_user", "restart", "shutdown"):
                self.api.ack_command(cid, "acknowledged")
                if ctype in ("restart", "shutdown"):
                    # Schedule it so it can be cancelled
                    timer = threading.Timer(120.0, self._execute_os_command, args=[ctype])
                    self._pending_os_commands[cid] = timer
                    timer.start()
                    # We ack 'completed' now or later? The spec says 'cancellations lists restart/shutdown commands cancelled by an admin ... after the agent already acknowledged them'. So we can ack completed now or let it be. Let's just ack completed.
                    self.api.ack_command(cid, "completed")
                else:
                    self._execute_os_command(ctype)
                    self.api.ack_command(cid, "completed")"""

content = content.replace(old_handle_cmd, new_handle_cmd)


# 3. Add _cancel_command
cancel_cmd = """    def _cancel_command(self, command: dict) -> None:
        cid = command.get("id")
        if cid in self._pending_os_commands:
            self._pending_os_commands[cid].cancel()
            del self._pending_os_commands[cid]
"""
if "def _cancel_command" not in content:
    content = content.replace("    def _update_agent(self,", cancel_cmd + "\n    def _update_agent(self,")


with open('agent/agent.py', 'w') as f:
    f.write(content)

