import os
import sys
import subprocess
import shutil
import time
import winreg

def run_command(cmd, ignore_errors=True):
    try:
        subprocess.run(cmd, check=not ignore_errors, shell=True, capture_output=True)
    except subprocess.CalledProcessError:
        pass

def main():
    print("====================================================")
    print(" Workforce Analytics Agent Full Uninstaller for Windows")
    print("====================================================")
    print("")

    # 1. Stop and remove the Windows Service
    service_name = "WFAMonitoringService"
    print(f"Stopping and removing Windows Service: {service_name}...")
    run_command(f'sc stop {service_name}')
    time.sleep(2)
    run_command(f'sc delete {service_name}')
    time.sleep(1)

    # 2. Kill running processes
    processes = ["WorkforceAgent.exe", "WorkforceTrack.exe", "windowstelementoryservice.exe"]
    print("Terminating agent processes if running...")
    for proc in processes:
        run_command(f'taskkill /F /IM {proc}')
    time.sleep(2)

    # 3. Run Inno Setup uninstallers if they exist
    local_app_data = os.environ.get('LOCALAPPDATA', '')
    uninstallers = [
        os.path.join(local_app_data, "Programs", "WorkforceAgent", "unins000.exe"),
        os.path.join(local_app_data, "Programs", "WorkforceTrack", "unins000.exe")
    ]

    for uninstaller in uninstallers:
        if os.path.exists(uninstaller):
            print(f"Running uninstaller: {uninstaller}...")
            run_command(f'"{uninstaller}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART')
            time.sleep(3)

    # 4. Remove Registry Run keys
    print("Removing registry autostart entries...")
    reg_keys = ["WorkforceAgent", "WorkforceTrack"]
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_ALL_ACCESS)
        for val_name in reg_keys:
            try:
                winreg.DeleteValue(key, val_name)
            except FileNotFoundError:
                pass
        winreg.CloseKey(key)
    except Exception as e:
        print(f"Could not access registry: {e}")

    # 5. Clean up application data and install directories
    print("Removing configuration, offline logs, and application files...")
    app_data = os.environ.get('APPDATA', '')
    program_files = os.environ.get('ProgramFiles', 'C:\\Program Files')
    program_files_x86 = os.environ.get('ProgramFiles(x86)', 'C:\\Program Files (x86)')

    folders = [
        os.path.join(app_data, "WorkforceAgent"),
        os.path.join(local_app_data, "Programs", "WorkforceAgent"),
        os.path.join(local_app_data, "Programs", "WorkforceTrack"),
        os.path.join(program_files, "SVCTCOM"),
        os.path.join(program_files_x86, "SVCTCOM")
    ]

    for folder in folders:
        if os.path.exists(folder):
            print(f"Deleting {folder}...")
            try:
                shutil.rmtree(folder, ignore_errors=True)
            except Exception:
                pass

    print("\n====================================================")
    print(" Uninstallation complete! You may now close this window.")
    print("====================================================\n")
    
    # Pause so user can read the output if double-clicked
    os.system("pause")

if __name__ == "__main__":
    # Request admin privileges if not admin
    try:
        import ctypes
        if not ctypes.windll.shell32.IsUserAnAdmin():
            ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable, " ".join(sys.argv), None, 1)
            sys.exit()
    except Exception:
        pass
        
    main()
