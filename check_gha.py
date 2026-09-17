import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

req = urllib.request.Request("https://api.github.com/repos/umairubm/Employee-Activity-Monitor/actions/runs?per_page=1", headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, context=ctx) as response:
    data = json.loads(response.read().decode())
    run = data['workflow_runs'][0]
    print(f"{run['name']} - {run['status']} - {run['conclusion']}")
