"""Native Windows installer smoke-test support.

The smoke runner is deliberately kept separate from the agent runtime.  It is
safe to import on non-Windows builders: pywinauto and Windows-only helpers are
loaded only when the runner is actually invoked on Windows.
"""
