import platform
import socket
import psutil
import sys
import subprocess

class SysInfo:
    @property
    def system_info(self):
        try:
            import importlib
            import sys
            import os
            
            # Temporarily remove local directory from sys.path to avoid importing this file circularly
            local_dir = os.path.dirname(os.path.abspath(__file__))
            original_path = sys.path.copy()
            if local_dir in sys.path:
                sys.path.remove(local_dir)
            if '' in sys.path:
                sys.path.remove('')
                
            pkg = importlib.import_module("system_info")
            sys.path = original_path
            
            return pkg.sysinfo.sysInfo
        except Exception as e:
            # Fallback if the pip package is not installed or fails
            return {
                'Processor': 'Unknown',
                'CPU': 0,
                'CPU_Core': '0',
                'Ip': '127.0.0.1',
                'OS Version': 'Unknown',
                'Operating System': 'Unknown',
                'Host Name': 'Unknown',
                'Total Disk Space': 'Unknown',
                'Available Space': 'Unknown',
                'HD Size': 'Unknown',
                'Ram_Size': 'Unknown',
                'Manufacturer': 'Unknown',
                'Model': 'Unknown',
                'Serial_Number': 'Unknown',
                'Ram_Type': 'Unknown',
                'HD_Type': 'Unknown'
            }

    def get_ip(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            # connect() for UDP doesn't send packets
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except Exception:
            return "127.0.0.1"

    def get_disk_space(self, kind):
        try:
            usage = psutil.disk_usage('/')
            if kind == 'total':
                return f"{round(usage.total / (1024**3))} GB"
            elif kind == 'free':
                return f"{round(usage.free / (1024**3))} GB"
        except Exception:
            return "Unknown"

sysinfo = SysInfo()

if __name__ == "__main__":
    print(sysinfo.system_info)
