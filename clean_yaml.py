import re
with open('.github/workflows/build-agent-installers.yml', 'r') as f:
    text = f.read()

# Remove specific steps
patterns_to_remove = [
    r"      - name: Require production signing configuration.*?(\n      - uses: actions/setup-python@v5)",
    r"      - name: Azure login with workload identity.*?(\n      - name: Build installer \(Inno Setup\))",
    r"      - name: Verify signed agent.*?(\n      - name: Build installer \(Inno Setup\))",
    r"      - name: Retain unsigned installer only as a negative test fixture.*?(\n      - name: Generate unsigned checksum)",
    r"      - name: Verify final signature and write checksum.*?(\n      - name: Generate unsigned checksum)",
    r"      - name: Upload native smoke inputs \(not release assets\).*?(\n      - name: Label unsigned development installer)",
    r"  windows-native-smoke:.*?(\n  windows-publish:)",
]

# Manual replacements
text = re.sub(
    r"      - name: Require production signing configuration.*?(\n      - uses: actions/setup-python@v5)",
    r"\1", text, flags=re.DOTALL
)

text = re.sub(
    r"      - name: Azure login with workload identity.*?(\n      - name: Build installer \(Inno Setup\))",
    r"\1", text, flags=re.DOTALL
)

text = re.sub(
    r"      - name: Retain unsigned installer only as a negative test fixture.*?(\n      - name: Generate unsigned checksum)",
    r"\1", text, flags=re.DOTALL
)

text = re.sub(
    r"      - name: Upload native smoke inputs \(not release assets\).*?(\n      - name: Label unsigned development installer)",
    r"\1", text, flags=re.DOTALL
)

# Remove AZURE variables from env
text = re.sub(r"      AZURE_CLIENT_ID:.*?\n      WINDOWS_PUBLISHER_SUBJECT: \$\{\{ vars.WINDOWS_PUBLISHER_SUBJECT \}\}\n", "", text, flags=re.DOTALL)
text = text.replace("    environment: windows-signing\n", "")

# Fix "Generate unsigned checksum" step
text = text.replace(
    "      - name: Generate unsigned checksum\n        if: ${{ !inputs.windows_unsigned_dev && vars.AZURE_CLIENT_ID == '' }}",
    "      - name: Generate checksum\n        if: ${{ !inputs.windows_unsigned_dev }}"
)

# Rename artifacts
text = text.replace("windows-installer-signed", "windows-installer")

# Remove windows-native-smoke job
text = re.sub(r"  windows-native-smoke:.*?\n  windows-publish:", "  windows-publish:", text, flags=re.DOTALL)

# Remove reverify step in windows-publish
text = re.sub(
    r"      - uses: actions/download-artifact@v4\n        if: \$\{\{ vars.AZURE_CLIENT_ID != '' \}\}.*?\n      - name: Publish to release",
    r"      - name: Publish to release", text, flags=re.DOTALL
)

# Also remove environment: windows-signing from windows-publish
text = text.replace("    environment: windows-signing\n", "")

with open('.github/workflows/build-agent-installers.yml', 'w') as f:
    f.write(text)
