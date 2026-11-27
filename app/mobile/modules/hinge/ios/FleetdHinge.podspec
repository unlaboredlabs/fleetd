Pod::Spec.new do |s|
  s.name           = 'FleetdHinge'
  s.version        = '0.1.0'
  s.summary        = "Where a foldable iPhone's fold runs across the app's window"
  s.license        = 'MIT'
  s.author         = 'fleetd'
  s.homepage       = 'https://fleetd.sh'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: 'https://github.com/unlaboredlabs/fleetd.git' }
  s.dependency 'ExpoModulesCore'
  s.static_framework = true
  s.source_files = "**/*.swift"
end
