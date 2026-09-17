import os
import json
import shutil
import sys
from pathlib import Path

# Add agent directory to sys.path so we can import consent
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import our consent module
from agent import consent

def main():
    config_dir = consent.get_config_dir()
    print(f"Config directory path: {config_dir}")
    
    # Ensure directory exists
    config_dir.mkdir(parents=True, exist_ok=True)
    
    # Create mock config.json
    mock_config = {
        "server_url": "https://test-server.example.com",
        "device_id": "test_device_123",
        "device_secret": "test_secret_abc",
        "consent_name": "John Doe",
        "enrolled_at": "2026-07-17T12:00:00Z"
    }
    
    config_path = config_dir / "config.json"
    seed_path = config_dir / "enroll_seed.json"
    
    config_path.write_text(json.dumps(mock_config, indent=2), encoding="utf-8")
    seed_path.write_text(json.dumps({"token": "mock_token"}, indent=2), encoding="utf-8")
    
    print("Created mock config.json and enroll_seed.json.")
    print("Launching consent dialog...")
    
    result = consent.show_consent_dialog()
    print(f"Result returned from dialog: {result}")
    
    # Check if files were kept or deleted
    print("\nPost-dialog status:")
    print(f"Config dir exists: {config_dir.exists()}")
    if config_dir.exists():
        print(f"config.json exists: {config_path.exists()}")
        print(f"enroll_seed.json exists: {seed_path.exists()}")

if __name__ == "__main__":
    main()
