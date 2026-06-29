import platform
import socket
import psutil
import sys
import subprocess

class SysInfo:
    @property
    def sysInfo(self):
        # Basic System Info
        info = {
            'Processor': platform.processor() or "Unknown",
            'CPU': psutil.cpu_count(logical=True),
            'CPU_Core': str(psutil.cpu_count(logical=False)),
            'Ip': self.get_ip(),
            'OS Version': platform.version(),
            'Operating System': platform.system() + " " + platform.release(),
            'Host Name': socket.gethostname(),
            'Total Disk Space': self.get_disk_space('total'),
            'Available Space': self.get_disk_space('free'),
            'HD Size': self.get_disk_space('total'),
            'Ram_Size': f"{round(psutil.virtual_memory().total / (1024**3))} GB",
            'Manufacturer': 'Unknown',
            'Model': 'Unknown',
            'Serial_Number': 'Unknown',
            'Ram_Type': 'Unknown',
            'HD_Type': 'Unknown'
        }
        
        # OS Specific Hardware Details
        if sys.platform.startswith('win'):
            try:
                # Manufacturer and Model
                sys_output = subprocess.check_output("wmic csproduct get vendor,name,identifyingnumber", shell=True, text=True, stderr=subprocess.DEVNULL).strip().split('\n')
                if len(sys_output) > 1:
                    parts = sys_output[1].split()
                    if len(parts) >= 3:
                        info['Serial_Number'] = parts[-1]
                        info['Manufacturer'] = parts[0]
                        info['Model'] = " ".join(parts[1:-1])

                # CPU Processor Name
                cpu_output = subprocess.check_output("wmic cpu get name", shell=True, text=True, stderr=subprocess.DEVNULL).strip().split('\n')
                if len(cpu_output) > 1:
                    info['Processor'] = cpu_output[1].strip()

                # RAM Type
                mem_output = subprocess.check_output("wmic memorychip get memorytype", shell=True, text=True, stderr=subprocess.DEVNULL).strip().split('\n')
                if len(mem_output) > 1:
                    mem_type = mem_output[1].strip()
                    type_map = {'20': 'DDR', '21': 'DDR2', '24': 'DDR3', '26': 'DDR4', '34': 'DDR5'}
                    info['Ram_Type'] = type_map.get(mem_type, mem_type)
            except Exception:
                pass
                
        elif sys.platform == 'darwin':
            try:
                sys_output = subprocess.check_output(["system_profiler", "SPHardwareDataType"], text=True, stderr=subprocess.DEVNULL)
                for line in sys_output.split('\n'):
                    if 'Serial Number' in line:
                        info['Serial_Number'] = line.split(':')[-1].strip()
                    elif 'Model Name' in line:
                        info['Model'] = line.split(':')[-1].strip()
                    elif 'Processor Name' in line:
                        info['Processor'] = line.split(':')[-1].strip()
                info['Manufacturer'] = 'Apple'
            except Exception:
                pass
                
        elif sys.platform.startswith('linux'):
            try:
                with open('/sys/class/dmi/id/sys_vendor', 'r') as f:
                    info['Manufacturer'] = f.read().strip()
                with open('/sys/class/dmi/id/product_name', 'r') as f:
                    info['Model'] = f.read().strip()
                with open('/sys/class/dmi/id/product_serial', 'r') as f:
                    info['Serial_Number'] = f.read().strip()
                
                # CPU Processor Name
                with open('/proc/cpuinfo', 'r') as f:
                    for line in f:
                        if 'model name' in line:
                            info['Processor'] = line.split(':')[1].strip()
                            break
            except Exception:
                pass
                
        return info

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
    print(sysinfo.sysInfo)
