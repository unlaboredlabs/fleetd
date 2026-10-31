Pod::Spec.new do |s|
  s.name           = 'FleetdToolbar'
  s.version        = '0.1.0'
  s.summary        = "iOS 26's bottom toolbar: a filters menu beside the search field"
  s.license        = 'MIT'
  s.author         = 'fleetd'
  s.homepage       = 'https://fleetd.sh'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: 'https://github.com/unlaboredlabs/fleetd.git' }
  s.dependency 'ExpoModulesCore'
  s.static_framework = true
  s.source_files = "**/*.swift"
end
