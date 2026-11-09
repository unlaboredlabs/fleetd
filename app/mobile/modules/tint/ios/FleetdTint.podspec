Pod::Spec.new do |s|
  s.name           = 'FleetdTint'
  s.version        = '0.1.0'
  s.summary        = "The app's neutral accent as iOS's tint color"
  s.license        = 'MIT'
  s.author         = 'fleetd'
  s.homepage       = 'https://fleetd.sh'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: 'https://github.com/unlaboredlabs/fleetd.git' }
  s.dependency 'ExpoModulesCore'
  s.static_framework = true
  s.source_files = "**/*.swift"
end
