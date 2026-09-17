require 'xcodeproj'

workspace_path = '/Users/ubmtechnologies/Desktop/Employee_monitor - Copy/agent/packaging/macos/WorkforceAgentMac/WorkforceAgentMac.xcworkspace'
project_path = 'WorkforceAgentMac.xcodeproj'

workspace = Xcodeproj::Workspace.new(project_path)
workspace.save_as(workspace_path)
puts "Xcode workspace created at #{workspace_path}"
