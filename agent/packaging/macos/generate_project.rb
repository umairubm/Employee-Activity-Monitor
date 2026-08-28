require 'xcodeproj'

# Create the project
project_path = '/Users/ubmtechnologies/Desktop/Employee_monitor - Copy/agent/packaging/macos/WorkforceAgentMac/WorkforceAgentMac.xcodeproj'
project = Xcodeproj::Project.new(project_path)

# Add a target for a macOS app
app_target = project.new_target(:application, 'WorkforceAgentMac', :osx)

# Create a group for the source files
main_group = project.main_group.new_group('WorkforceAgentMac', 'Sources/WorkforceAgentMac')

# Add AppDelegate.swift to the project
file_ref = main_group.new_file('AppDelegate.swift')
app_target.source_build_phase.add_file_reference(file_ref)

# Configure build settings
app_target.build_configurations.each do |config|
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.workforce.agent'
  config.build_settings['INFOPLIST_FILE'] = 'Sources/WorkforceAgentMac/Info.plist'
  config.build_settings['SWIFT_VERSION'] = '5.0'
  config.build_settings['MACOSX_DEPLOYMENT_TARGET'] = '11.0'
  config.build_settings['SDKROOT'] = 'macosx'
end

# Save the project
project.save
puts "Xcode project created at #{project_path}"
