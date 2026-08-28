import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    var pythonProcess: Process?

    func applicationDidFinishLaunching(_ aNotification: Notification) {
        // First check permissions
        checkPermissions()
        
        // Launch the agent
        launchAgent()
    }
    
    func checkPermissions() {
        // Request Screen Recording Permission
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            // Note: In a production app, you would check CGPreflightScreenCaptureAccess()
            print("Checking Screen Recording permission...")
        }
        
        // Request Accessibility Permission
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
        let accessEnabled = AXIsProcessTrustedWithOptions(options as CFDictionary)
        if !accessEnabled {
            print("Accessibility permission not granted yet.")
        }
    }

    func launchAgent() {
        guard let agentPath = Bundle.main.path(forResource: "WorkforceAgent", ofType: nil) else {
            print("Could not find WorkforceAgent binary in bundle.")
            return
        }
        
        let process = Process()
        process.executableURL = URL(fileURLWithPath: agentPath)
        
        do {
            try process.run()
            self.pythonProcess = process
            print("Agent launched with PID: \(process.processIdentifier)")
        } catch {
            print("Failed to launch agent: \(error)")
        }
    }

    func applicationWillTerminate(_ aNotification: Notification) {
        // Terminate the agent when the app quits
        pythonProcess?.terminate()
    }
}
