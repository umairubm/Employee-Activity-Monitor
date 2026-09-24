import http.server
import threading
import json
import time
import subprocess
import os
import sqlite3
import tempfile
import sys
from pathlib import Path

class FaultyServer(http.server.HTTPServer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.scenario = 'normal'
        self.heartbeat_count = 0
        self.upload_count = 0
        self.uploaded_segments = []
        self.lock = threading.Lock()

class FaultyHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_POST(self):
        content_len = int(self.headers.get('Content-Length', 0))
        post_body = self.rfile.read(content_len)
        try:
            data = json.loads(post_body)
        except:
            data = {}

        if 'heartbeat' in self.path:
            with self.server.lock:
                self.server.heartbeat_count += 1
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"isLocked": false, "commands": []}')
            return
            
        if 'screenshot' in self.path:
            self.send_response(201)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"status": "ok"}')
            return
        
        if 'activity' in self.path or 'sync' in self.path:
            with self.server.lock:
                self.server.upload_count += 1
                if data:
                    items = data.get('logs') or data.get('segments') or []
                    if items:
                        self.server.uploaded_segments.append(items)
            
            if self.server.scenario == 'stall':
                time.sleep(25)
                self.send_response(201)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"acceptedSegmentIds": []}')
            
            elif self.server.scenario == '413':
                items = data.get('logs') or data.get('segments') or []
                if len(items) > 1:
                    self.send_response(413)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(b'{"error": "Too large"}')
                else:
                    self.send_response(201)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    acc = [items[0]['segmentId']] if items else []
                    self.wfile.write(json.dumps({"batchId": data.get("batchId"), "acceptedSegmentIds": acc}).encode())
            
            elif self.server.scenario == 'mixed':
                items = data.get('logs') or data.get('segments') or []
                if len(items) >= 2:
                    acc = [items[0]['segmentId']]
                    rej = [{"segmentId": items[1]['segmentId'], "reason": "invalid"}]
                    self.send_response(201)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"batchId": data.get("batchId"), "acceptedSegmentIds": acc, "rejected": rej}).encode())
                else:
                    self.send_response(201)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    acc = [s['segmentId'] for s in items]
                    self.wfile.write(json.dumps({"batchId": data.get("batchId"), "acceptedSegmentIds": acc}).encode())
            else:
                self.send_response(201)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                items = data.get('logs') or data.get('segments') or [] if data else []
                acc = [s['segmentId'] for s in items]
                self.wfile.write(json.dumps({"batchId": data.get("batchId"), "acceptedSegmentIds": acc}).encode())

        else:
            self.send_response(404)
            self.end_headers()


def create_agent_env(temp_home, port):
    # Determine python config dir
    if sys.platform == "darwin":
        py_conf_dir = Path(temp_home) / "Library" / "Application Support" / "WorkforceAgent"
    else:
        py_conf_dir = Path(temp_home) / ".config" / "WorkforceAgent"
    
    node_conf_dir = Path(temp_home) / ".active-tracker"

    py_conf_dir.mkdir(parents=True, exist_ok=True)
    node_conf_dir.mkdir(parents=True, exist_ok=True)

    # Configs using BOTH snake_case and camelCase
    config = {
        "server_url": f"http://127.0.0.1:{port}",
        "apiUrl": f"http://127.0.0.1:{port}",
        "device_secret": "test-secret",
        "deviceSecret": "test-secret",
        "device_id": "test-device",
        "deviceId": "test-device",
        "sync_interval_seconds": 2,
        "syncIntervalSeconds": 2,
        "idle_threshold_seconds": 60,
        "idleThresholdSeconds": 60,
        "monitoring_enabled": True,
        "monitoringEnabled": True
    }
    with open(py_conf_dir / "config.json", "w") as f:
        json.dump(config, f)
    with open(node_conf_dir / "credentials.json", "w") as f:
        json.dump(config, f)
        
    return py_conf_dir, node_conf_dir


def run_test_scenario(server, agent_cmd, scenario_name, setup_db_fn=None, duration=15):
    with tempfile.TemporaryDirectory() as td:
        py_conf, node_conf = create_agent_env(td, server.server_address[1])
        
        is_node = "node" in agent_cmd[0]
        config_dir = node_conf if is_node else py_conf
        
        if setup_db_fn:
            setup_db_fn(config_dir)
            if not is_node:
                try:
                    conn = sqlite3.connect(Path(config_dir) / "activity_intervals.sqlite3")
                    cnt = conn.execute("SELECT COUNT(*) FROM activity_segments").fetchone()[0]
                    conn.close()
                    print(f"DEBUG: Before agent starts, DB has {cnt} rows")
                except Exception as e:
                    print(f"DEBUG: Error checking DB: {e}")

        print(f"\n--- Running Scenario: {scenario_name} [{'Node' if is_node else 'Python'}] ---")
        server.scenario = scenario_name
        server.heartbeat_count = 0
        server.upload_count = 0
        server.uploaded_segments = []

        env = os.environ.copy()
        env["HOME"] = td
        env["XDG_CONFIG_HOME"] = str(Path(td) / ".config")
        env["TRACKER_SERVER_URL"] = f"http://127.0.0.1:{server.server_address[1]}"
        env["AGENT_SERVER_URL"] = f"http://127.0.0.1:{server.server_address[1]}"
        
        proc = subprocess.Popen(agent_cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        
        time.sleep(duration)
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except:
            proc.kill()
            
        stdout, stderr = proc.communicate()
        if server.heartbeat_count == 0 and server.upload_count == 0:
            print("WARNING: Agent sent no requests! Output:")
            print("STDOUT:", stdout)
            print("STDERR:", stderr)
            if not is_node:
                try:
                    log_file = Path(config_dir) / "agent.log"
                    if log_file.exists():
                        print("AGENT.LOG:")
                        print(log_file.read_text())
                except:
                    pass
        # It's better to do the checks inside here by taking a callback, but we can just return the data we need.
        # For simplicity, we just copy the SQLite/JSON out to a global temp dir if needed, but since we are just checking...
        # Wait, the best is to return the parsed DB contents!
        
        remaining, rejected = [], []
        if is_node:
            try:
                with open(Path(config_dir) / "offline-queue.json") as f:
                    q = json.load(f)
                remaining = [l['segmentId'] for l in q.get('logs', [])]
            except:
                pass
        else:
            try:
                conn = sqlite3.connect(Path(config_dir) / "activity_intervals.sqlite3")
                remaining = [r[0] for r in conn.execute("SELECT segment_id FROM activity_segments").fetchall()]
                rejected = conn.execute("SELECT segment_id, rejection_reason FROM rejected_segments").fetchall()
                conn.close()
            except:
                pass
                
        agent_log = ""
        if not is_node:
            try:
                log_file = Path(config_dir) / "agent.log"
                if log_file.exists():
                    agent_log = log_file.read_text()
            except:
                pass
                
        return server.heartbeat_count, server.upload_count, server.uploaded_segments, remaining, rejected, stdout, stderr, agent_log

def setup_python_db(config_dir, num_segments=5):
    db_path = Path(config_dir) / "activity_intervals.sqlite3"
    print(f"DEBUG: setup_python_db path is {db_path.absolute()}")
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE IF NOT EXISTS activity_segments (segment_id TEXT PRIMARY KEY, payload TEXT, created_at REAL)")
    conn.execute("CREATE TABLE IF NOT EXISTS rejected_segments (segment_id TEXT PRIMARY KEY, payload TEXT, created_at REAL, rejection_reason TEXT, rejected_at REAL)")
    for i in range(num_segments):
        sid = f"seg-{i}"
        payload = json.dumps({"segmentId": sid})
        conn.execute("INSERT INTO activity_segments VALUES (?, ?, ?)", (sid, payload, time.time()))
    conn.commit()
    conn.close()

def setup_node_queue(config_dir, num_segments=5):
    queue_path = Path(config_dir) / "offline-queue.json"
    logs = [{"segmentId": f"seg-{i}"} for i in range(num_segments)]
    with open(queue_path, "w") as f:
        json.dump({"sequenceNamespace": "test", "sequenceCounter": 1, "logs": logs}, f)

def main():
    server = FaultyServer(('127.0.0.1', 0), FaultyHandler)
    port = server.server_address[1]
    print(f"Test server listening on port {port}")
    
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    py_cmd = [sys.executable, "-m", "agent.agent"]
    node_cmd = ["node", "agent-node/tracker-client.mjs"]

    # 1. Stall Test - Python
    h, u, _, rem, rej, stdout, stderr, alog = run_test_scenario(server, py_cmd, "stall", lambda d: setup_python_db(d, 1), duration=35)
    print(f"Python Stall Test: Heartbeats={h}, Uploads={u}")
    if h >= 2 and u >= 1:
        print("  ✓ PASS: Heartbeats continued while upload was stalled.")
    else:
        print("  ✗ FAIL: Heartbeats were delayed by upload stall.")
        print("STDERR:", stderr)
        print("AGENT.LOG:", alog)

    # 2. Stall Test - Node
    h, u, _, rem, rej, stdout, stderr, alog = run_test_scenario(server, node_cmd, "stall", lambda d: setup_node_queue(d, 1), duration=35)
    print(f"Node Stall Test: Heartbeats={h}, Uploads={u}")
    if h >= 1 and u >= 1:
        print("  ✓ PASS: Heartbeats continued while upload was stalled.")
    else:
        print("  ✗ FAIL: Heartbeats were delayed by upload stall.")
        print("STDERR:", stderr)

    # 3. 413 Test - Python
    h, u, segs, rem, rej, stdout, stderr, alog = run_test_scenario(server, py_cmd, "413", lambda d: setup_python_db(d, 5), duration=45)
    lens = [len(s) for s in segs]
    print(f"Python 413 Test: Batch sizes sent: {lens}")
    if any(l == 1 for l in lens) and u >= 3:
        print("  ✓ PASS: Batch split down to 1 record.")
    else:
        print("  ✗ FAIL: Batch did not split correctly.")
        
    print("STDOUT:", stdout)
    print("STDERR:", stderr)
    print("AGENT.LOG:", alog)

    # 4. Mixed Batch Test - Python
    h, u, _, rem, rej, stdout, stderr, alog = run_test_scenario(server, py_cmd, "mixed", lambda d: setup_python_db(d, 2), duration=15)
    print(f"Python Mixed Test: Remaining={rem}, Rejected={rej}")
    if len(rem) == 0 and len(rej) == 1 and rej[0][0] == "seg-1":
        print("  ✓ PASS: Accepted record deleted, rejected record quarantined.")
    else:
        print("  ✗ FAIL: Records not handled correctly.")
    print("STDERR:", stderr)
    print("AGENT.LOG:", alog)
        
    # 5. Mixed Batch Test - Node
    h, u, _, rem, rej, stdout, stderr, _ = run_test_scenario(server, node_cmd, "mixed", lambda d: setup_node_queue(d, 2), duration=15)
    print(f"Node Mixed Test: Remaining={rem}")
    if len(rem) == 0:
        print("  ✓ PASS: Valid records sent.")
    else:
        print("  ✗ FAIL: Records not handled correctly.")
        print("STDERR:", stderr)

if __name__ == "__main__":
    main()
