# Workforce Analytics & IT Management — User Manual

A practical, step-by-step guide for administrators who operate the platform and
for the people whose devices are enrolled.

> **What this platform is.** A **transparent, consent-based** workforce analytics
> and IT management tool. It records foreground-app activity, idle time, and
> periodic screenshots from enrolled devices — **only after the user explicitly
> consents** — and lets admins issue authorized IT actions (lock screen, sign
> out). There is **no covert mode**: the agent shows a visible tray icon, a
> first-run consent dialog, and a notice before every screenshot.
>
> **What is never captured:** keystrokes, mouse movement, microphone, camera,
> screen recording / video, or live streaming.

---

## 1. Who uses what

| Role | Tool | How they sign in |
| --- | --- | --- |
| **Administrator / Super user** | Web dashboard | Username + password |
| **Monitored user** | Desktop agent (their PC/Mac/Linux) | Consent once at install/first run — no login |

The dashboard is **admin-only**. Monitored users never log in; they only run the
agent on their own machine and consent to it.

---

## 2. Getting started as an administrator

### 2.1 Sign in
1. Open the dashboard (production: `https://activitymonitor.replit.app`).
2. Enter your **username** and **password** on the Login screen.
3. You land on the **Overview** page.

> Lost access / need the first admin account? An admin account is created with the
> `create-admin` script (see the technical documentation). Logins are
> rate-limited to deter brute-force attempts.

### 2.2 The navigation
The left sidebar groups everything:

| Menu item | What it's for |
| --- | --- |
| **Overview** | At-a-glance KPIs and productivity distribution |
| **Devices** | Every enrolled machine; open one for full detail |
| **Activity Logs** | Foreground-app history across the org |
| **Screenshots** | Gallery of captured screens, with flagging |
| **Attendance** | Daily / ranged presence derived from activity |
| **Timesheets** | Worked-time rollups per user/device |
| **Projects & Tasks** | Lightweight project and task tracking |
| **Shifts** | Define working shifts |
| **Leave** | Leave requests and balances |
| **App Categories** | Classify apps as productive/unproductive/neutral |
| **Enrollment Tokens** | Create the tokens used to add new devices |
| **Agent Settings** | Global capture configuration |
| **Download Agent** | Get the Windows / macOS / Linux agent |

---

## 3. Enrolling a device (the core workflow)

Enrolling always requires **two things**: an **enrollment token** (created by an
admin) and the **explicit consent** of the person using the device.

### Step 1 — Create an enrollment token
1. Go to **Enrollment Tokens** → **Create token**.
2. Set:
   - **Label** — a human name, e.g. "Jane's laptop".
   - **Max uses** — how many devices may enroll with it (1–1000; use **1** for a
     single machine).
   - **Expires in** — days until it stops working (1–365).
3. Copy the generated token string. You'll give it to the person installing the
   agent (or paste it into the installer).

> Tokens are credentials. Revoke any token you no longer need with **Revoke**.

### Step 2 — Download the agent
Go to **Download Agent** and pick the platform:
- **Windows** — `.exe` installer (installs without admin rights for the signed-in
  user).
- **macOS** — `.dmg` disk image (drag-and-drop install).
- **Linux** — a binary. Download it, then make it executable (`chmod +x`) and run
  it.

If a platform shows "not published yet", no build has been released for it yet.

### Step 3 — Install + consent (on the user's machine)
The consent step is **mandatory and cannot be skipped**:

- **Windows installer:** the setup wizard shows the full disclosure (what is and
  isn't recorded), an explicit **consent checkbox**, and a field for the token and
  the consenting person's name. After install, the agent enrolls itself silently
  from that one-time consent and then runs visibly.
- **macOS / Linux / manual runs:** on first launch the agent shows a **consent
  dialog** with the same disclosure. The user enters their name + the token and
  clicks Agree. Enrollment only proceeds after consent.

Once enrolled, the device appears under **Devices**, and the agent runs with a
visible tray icon.

### What the user sees at all times
- A **tray icon** while the agent is running.
- A **notification before every screenshot** ("a screenshot is being taken").
- The consent disclosure they agreed to.

---

## 4. Day-to-day administration

### 4.1 Overview
KPIs such as total devices, how many are online now, screenshots captured, and a
productivity distribution (productive / unproductive / neutral / unclassified).
Use the shared **date range** and **group** filters at the top of date-aware
pages — they're remembered across pages.

### 4.2 Devices
- See every machine, its **online/offline** status, OS, assigned user, and group.
- Open a device to see its **detail page**: live config, recent activity, command
  history, and per-device overrides.
- **Group devices** (e.g. "Sales", "Engineering") and rename groups to filter and
  compare across the dashboard.

### 4.3 Activity Logs
A feed of foreground-app usage (app + window title + duration + idle), each
classified productive / unproductive / neutral / unclassified. Filter by device,
user, or group. Daily views aggregate a day's logs in your browser's local time
zone.

### 4.4 Screenshots
A gallery of captured screens. Click any thumbnail to open the **viewer**
(arrow-key navigation). **Flag** anything that needs review; filter by device,
group, or flagged-only. Images are streamed only to authenticated admins.

### 4.5 App Categories
Whenever the agent reports an app the system hasn't seen, it's auto-added as
**unclassified**. On **App Categories**, set each app to **productive**,
**unproductive**, or **neutral** (and give it a friendly display name). These
classifications drive every productivity number on the dashboard.

### 4.6 Issuing IT actions (lock / sign out)
From a device's detail page you can issue an authorized command:
- **Lock screen** — locks the workstation.
- **Sign out user** — logs the user out.

The command is delivered on the device's next heartbeat. The agent shows an
**on-screen notice before executing**, then reports back the status
(acknowledged → completed / failed). You can **cancel** a command while it's
still pending, and you can review the full command history per device.

### 4.7 Agent Settings (capture configuration)
Tune how the agent behaves — globally or per device:
- **Monitoring enabled** — master on/off.
- **Screenshot interval** — min/max minutes (the agent picks a random time in the
  window, so captures aren't perfectly predictable).
- **Idle threshold** — seconds of no input before time counts as idle.
- **Sync interval** — how often the agent checks in (heartbeat).

Changes propagate to each device on its next heartbeat.

---

## 5. Workforce-management features

These optional modules turn raw activity into HR-friendly views:

- **Attendance** — presence per day or across a date range, derived from activity;
  configurable globally and overridable per device or group.
- **Timesheets** — worked-time rollups you can review per user/device.
- **Shifts** — define the working shifts the org runs on.
- **Leave** — submit, review (approve/reject), and track **leave requests**, and
  manage per-person **leave balances**.
- **Projects & Tasks** — create projects, add tasks under them, and track status.

---

## 6. Privacy & consent commitments

- **Consent is required and recorded.** A device cannot send data until consent is
  acknowledged; the consenting person's name and timestamp are stored on the
  device record. The server rejects any un-consented device.
- **The agent is always visible** (tray icon) and **announces every screenshot**.
- **Captured data is admin-only.** There is no public or unauthenticated way to
  read activity, screenshots, or reports. Screenshot image bytes are served only
  to signed-in admins.
- **Removing a device.** Revoke its enrollment token and stop/uninstall the agent
  on the machine.

---

## 7. Troubleshooting

| Symptom | Check |
| --- | --- |
| Device doesn't appear after install | Token expired/exhausted/revoked? Consent completed? Network reachable? |
| "Not published yet" on Download Agent | No release exists for that platform yet. |
| No new activity from a device | Agent running (tray icon)? Monitoring enabled in Agent Settings? Device online? |
| Productivity numbers look wrong | Classify any **unclassified** apps under App Categories. |
| Command not executing | It runs on the next heartbeat; check the device is online and the command isn't cancelled. |

For API details and architecture, see [`DOCUMENTATION.md`](./DOCUMENTATION.md) and
[`API.md`](./API.md).
