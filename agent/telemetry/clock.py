import time

class Clock:
    def wall_time(self) -> float:
        return time.time()
        
    def monotonic(self) -> float:
        return time.monotonic()
        
class FakeClock(Clock):
    def __init__(self, wall: float = 0, mono: float = 0):
        self._wall = wall
        self._mono = mono
        
    def wall_time(self) -> float:
        return self._wall
        
    def monotonic(self) -> float:
        return self._mono
        
    def advance(self, seconds: float):
        self._wall += seconds
        self._mono += seconds
