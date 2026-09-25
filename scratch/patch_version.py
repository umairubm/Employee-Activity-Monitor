import os
import glob

# Bump agent.py
with open('agent/agent.py', 'r') as f:
    content = f.read()
content = content.replace('AGENT_VERSION = "1.2.90"', 'AGENT_VERSION = "1.2.91"')
with open('agent/agent.py', 'w') as f:
    f.write(content)

# Bump .iss files
for iss_file in glob.glob('agent/packaging/windows/*.iss'):
    with open(iss_file, 'r') as f:
        content = f.read()
    content = content.replace('#define AppVersion "1.2.90"', '#define AppVersion "1.2.91"')
    with open(iss_file, 'w') as f:
        f.write(content)
