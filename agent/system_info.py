import platform
import socket
import psutil
import sys
import subprocess

class SysInfo:
    @property
    def system_info(self):
        try:
            cpu_physical = psutil.cpu_count(logical=False)
            cpu_logical = psutil.cpu_count(logical=True)
            
            info = {
                'Processor': platform.processor() or "",
                'CPU': cpu_logical if cpu_logical else "",
                'CPU_Core': str(cpu_physical) if cpu_physical else "",
                'Ip': self.get_ip() or "",
                'OS Version': platform.version() or "",
                'Operating System': platform.system() or "",
                'Host Name': socket.gethostname() or "",
                'Total Disk Space': self.get_disk_space('total') or "",
                'Available Space': self.get_disk_space('free') or "",
                'HD Size': self.get_disk_space('total') or "",
                'Ram_Size': f"{round(psutil.virtual_memory().total / (1024**3))} GB",
                'Manufacturer': "",
                'Model': "",
                'Serial_Number': "",
                'Ram_Type': "",
                'HD_Type': ""
            }
            
            if platform.system() == "Windows":
                try:
                    # Using PowerShell for cleaner and more robust extraction
                    def run_ps(cmd):
                        try:
                            return subprocess.check_output(
                                ["powershell", "-NoProfile", "-Command", cmd],
                                text=True,
                                creationflags=subprocess.CREATE_NO_WINDOW
                            ).strip()
                        except Exception:
                            return ""

                    mfg = run_ps("(Get-CimInstance Win32_ComputerSystem).Manufacturer")
                    if mfg: info['Manufacturer'] = mfg
                    
                    mod = run_ps("(Get-CimInstance Win32_ComputerSystem).Model")
                    if mod: info['Model'] = mod
                    
                    serial = run_ps("(Get-CimInstance Win32_BIOS).SerialNumber")
                    if serial: info['Serial_Number'] = serial

                    # HD_Type (SSD, HDD, etc.)
                    hd_type = run_ps("(Get-PhysicalDisk | Select-Object -First 1).MediaType")
                    if hd_type: info['HD_Type'] = hd_type

                    # Ram_Type via SMBIOSMemoryType (24=DDR3, 26=DDR4, 34=DDR5)
                    ram_type_val = run_ps("(Get-CimInstance Win32_PhysicalMemory | Select-Object -First 1).SMBIOSMemoryType")
                    ram_map = {"20": "DDR", "21": "DDR2", "24": "DDR3", "26": "DDR4", "34": "DDR5"}
                    info['Ram_Type'] = ram_map.get(ram_type_val, ram_type_val if ram_type_val else "")

                except Exception:
                    pass
            elif platform.system() == "Linux":
                try:
                    with open('/sys/class/dmi/id/sys_vendor', 'r') as f: info['Manufacturer'] = f.read().strip()
                    with open('/sys/class/dmi/id/product_name', 'r') as f: info['Model'] = f.read().strip()
                    with open('/sys/class/dmi/id/product_serial', 'r') as f: info['Serial_Number'] = f.read().strip()
                    # Disk type on Linux (check rotational flag of main drive)
                    try:
                        with open('/sys/block/sda/queue/rotational', 'r') as f:
                            info['HD_Type'] = "HDD" if f.read().strip() == "1" else "SSD"
                    except Exception:
                        pass
                except Exception:
                    pass
            elif platform.system() == "Darwin":
                try:
                    info['Model'] = subprocess.check_output(["sysctl", "-n", "hw.model"], text=True).strip()
                    info['Manufacturer'] = "Apple"
                    out = subprocess.check_output("ioreg -l | grep IOPlatformSerialNumber", shell=True, text=True).strip()
                    if " = " in out: info['Serial_Number'] = out.split(" = ")[1].strip('"')
                    # Apple machines are mostly SSDs these days
                    info['HD_Type'] = "SSD"
                except Exception:
                    pass

            return info
        except Exception:
            return {}

    def get_ip(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            # connect() for UDP doesn't send packets
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except Exception:
            return ""

    def get_disk_space(self, kind):
        try:
            # For Windows we might want to check C:\ instead of /
            drive = 'C:\\' if platform.system() == "Windows" else '/'
            usage = psutil.disk_usage(drive)
            if kind == 'total':
                return f"{round(usage.total / (1024**3))} GB"
            elif kind == 'free':
                return f"{round(usage.free / (1024**3))} GB"
        except Exception:
            return ""

sysinfo = SysInfo()

if __name__ == "__main__":
    print(sysinfo.system_info)
