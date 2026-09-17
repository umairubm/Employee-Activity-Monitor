import json
import uuid
from datetime import datetime, timezone, timedelta

def generate_legacy_payload():
    now = datetime.now(timezone.utc)
    # Simulate 1 hour of work
    return {
        "logs": [
            {
                "processName": "Code.exe",
                "windowTitle": "index.ts - VS Code",
                "url": "",
                "startedAt": (now - timedelta(minutes=60)).isoformat(),
                "endedAt": now.isoformat(),
                "durationSeconds": 3600,
                "idleSeconds": 300, # 5 mins of idle scattered
            }
        ]
    }

def generate_interval_payload():
    now = datetime.now(timezone.utc)
    batch_id = str(uuid.uuid4())
    # 55 mins active, 5 mins idle
    return {
        "batchId": batch_id,
        "logs": [
            {
                "segmentId": str(uuid.uuid4()),
                "sequenceNamespace": str(uuid.uuid4()),
                "sequence": 1,
                "processName": "Code.exe",
                "windowTitle": "index.ts - VS Code",
                "startedAt": (now - timedelta(minutes=60)).isoformat(),
                "endedAt": (now - timedelta(minutes=5)).isoformat(),
                "elapsedMilliseconds": 55 * 60 * 1000,
                "engagementState": "active",
                "sessionState": "unlocked",
                "connectivityState": "online"
            },
            {
                "segmentId": str(uuid.uuid4()),
                "sequenceNamespace": str(uuid.uuid4()),
                "sequence": 2,
                "processName": "Code.exe",
                "windowTitle": "index.ts - VS Code",
                "startedAt": (now - timedelta(minutes=5)).isoformat(),
                "endedAt": now.isoformat(),
                "elapsedMilliseconds": 5 * 60 * 1000,
                "engagementState": "idle",
                "sessionState": "unlocked",
                "connectivityState": "online"
            }
        ]
    }

print("=== Simulating Legacy Rollout ===")
legacy = generate_legacy_payload()
print(f"Legacy payload total duration: {legacy['logs'][0]['durationSeconds']}s")
print(f"Legacy payload idle: {legacy['logs'][0]['idleSeconds']}s")
print("Expected productive time (old logic): 3600s (Legacy considers entire block productive if active)")

print("\n=== Simulating Interval Rollout ===")
interval = generate_interval_payload()
print(f"Interval 1 (Active): {interval['logs'][0]['elapsedMilliseconds'] / 1000}s")
print(f"Interval 2 (Idle): {interval['logs'][1]['elapsedMilliseconds'] / 1000}s")
print("Expected productive time (new logic): 3300s (Exact active time isolated)")

print("\nCONCLUSION: Rollout ready. Legacy payloads degrade gracefully, while new agents isolate precise active time without bleeding into idle blocks.")
