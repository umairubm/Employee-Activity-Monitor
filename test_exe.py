import sys, os
print("argv[0]:", os.path.abspath(sys.argv[0]))
print("executable:", sys.executable)
try:
    print("proc/self/exe:", os.path.realpath("/proc/self/exe"))
except: pass
