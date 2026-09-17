import re

with open('agent/system_info.py', 'r') as f:
    content = f.read()

new_methods = """
    def get_metrics(self):
        try:
            import time
            tz_offset_minutes = -int(time.timezone / 60) if time.localtime().tm_isdst == 0 else -int(time.altzone / 60)
            
            drive = 'C:\\\\' if platform.system() == "Windows" else '/'
            usage = psutil.disk_usage(drive)
            disk_free = usage.free
            disk_total = usage.total
            
            cpu_percent = psutil.cpu_percent(interval=None)
            ram_percent = psutil.virtual_memory().percent
            
            return {
                "tzOffsetMinutes": tz_offset_minutes,
                "metrics": {
                    "cpuPercent": cpu_percent,
                    "ramPercent": ram_percent,
                    "diskFreeBytes": disk_free,
                    "diskTotalBytes": disk_total
                }
            }
        except Exception:
            return {}

"""

# Insert new_methods before get_ip
content = content.replace("    def get_ip(self):", new_methods + "    def get_ip(self):")

with open('agent/system_info.py', 'w') as f:
    f.write(content)
