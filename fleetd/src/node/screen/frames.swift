// fleetd-frames: a screen of the agents' Mac as live frames, for the node (src/node/screen/mac_frames.ts). It reads
// the screen only when it changes and sends each change as a JPEG or as H.264 from the Mac's hardware encoder
// (VideoToolbox), at most `fps` a second.
//
//   fleetd-frames sim <device set> <udid>    an iOS simulator's display: its framebuffer's IOSurface (CoreSimulator,
//                                            loaded at run time), looked at every few ms and read when its seed moves;
//                                            of a foldable's two panels, the one that changed last (the lit one)
//   fleetd-frames screen                     the Mac's main display through ScreenCaptureKit, which sends a frame only
//                                            when something on it changed
//
// Each frame on stdout: a 28-byte header, little-endian: kind (u8: 1 JPEG, 2 H.264 access unit, Annex B, 3 a word
// from the helper in UTF-8), key (u8: 1 for a keyframe or a JPEG), 2 bytes unused, the screen's own size (u32 width,
// u32 height: input coordinates are in it), the picture's size (u32, u32), the payload's length (u32), a sequence
// number (u32); then the payload.
// Commands on stdin, one a line: `jpeg` or `h264` (what frames are, from the next on; JPEG at first), `key` (the next
// H.264 frame is a keyframe), `still` (a JPEG of the screen now, changed or not), `kbps <n>` (the H.264 bit rate),
// `fps <n>`, `side <n>` (the picture's longer side at most). stdin closing ends it.
//
// A simulator also takes a person's input straight into its HID service (dtuhidd), as Simulator.app's own does: a
// word `input` says it can from then on, `noinput <why>` that it can't (the node then sends input through
// agent-device). `touch down|move|up <x> <y> <edge>` moves one finger, in the screen's pixels (`edge` 0, or 1 top, 2
// left, 3 bottom, 4 right for a touch that starts at that edge: the system's edge gestures; a down's holds until
// its finger lifts), `keyboard <usage>
// down|up` a key (a USB HID keyboard usage), `button home` presses the home button.
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import IOSurface
import ScreenCaptureKit
import VideoToolbox
import XPC

setvbuf(stdout, nil, _IOFBF, 1 << 20)

func fail(_ why: String) -> Never {
  FileHandle.standardError.write("fleetd-frames: \(why)\n".data(using: .utf8)!)
  exit(1)
}

/// What the node asked for, changed by stdin's commands.
final class Wants {
  private let lock = NSLock()
  private var _h264 = false
  private var _key = true
  private var _still = true
  private var _kbps = 2500
  private var _fps = 30.0
  private var _side = 1280
  func read<T>(_ f: (Wants) -> T) -> T { lock.lock(); defer { lock.unlock() }; return f(self) }
  var h264: Bool { read { $0._h264 } }
  var kbps: Int { read { $0._kbps } }
  var fps: Double { read { $0._fps } }
  var side: Int { read { $0._side } }
  /// Whether a still waits, without taking it (send takes it).
  var stillWaiting: Bool { read { $0._still } }
  /// Whether the next H.264 frame must be a keyframe, once.
  func takeKey() -> Bool { lock.lock(); defer { lock.unlock() }; let k = _key; _key = false; return k }
  func takeStill() -> Bool { lock.lock(); defer { lock.unlock() }; let s = _still; _still = false; return s }
  func command(_ line: String) {
    let parts = line.split(separator: " ")
    guard let word = parts.first else { return }
    let n = parts.count > 1 ? Double(parts[1]) : nil
    lock.lock(); defer { lock.unlock() }
    switch word {
    case "jpeg": _h264 = false
    case "h264": if !_h264 { _h264 = true; _key = true }
    case "key": _key = true
    case "still": _still = true
    case "kbps": if let n, n >= 50 { _kbps = Int(n) }
    case "fps": if let n, n >= 1 { _fps = min(n, 60) }
    case "side": if let n, n >= 64 { _side = Int(n) }
    default: break
    }
  }
}

let wants = Wants()
var onCommand: () -> Void = {}
/// A person's input (`touch`, `keyboard`, `button`), on the thread that reads stdin, so it goes in the order it came.
var onInput: (_ words: [Substring]) -> Void = { _ in }
Thread.detachNewThread {
  while let line = readLine() {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    let words = trimmed.split(separator: " ")
    if let first = words.first, ["touch", "keyboard", "button"].contains(first) {
      onInput(words)
      continue
    }
    wants.command(trimmed)
    onCommand()
  }
  exit(0)
}

let out = DispatchQueue(label: "out")
var seq: UInt32 = 0
func emit(kind: UInt8, key: Bool, screen: (Int, Int), picture: (Int, Int), _ payload: Data) {
  out.sync {
    seq &+= 1
    var head = Data(count: 28)
    head.withUnsafeMutableBytes { b in
      b[0] = kind
      b[1] = key ? 1 : 0
      for (i, v) in [UInt32(screen.0), UInt32(screen.1), UInt32(picture.0), UInt32(picture.1), UInt32(payload.count), seq].enumerated() {
        b.storeBytes(of: v.littleEndian, toByteOffset: 4 + i * 4, as: UInt32.self)
      }
    }
    head.withUnsafeBytes { _ = fwrite($0.baseAddress, 1, 28, stdout) }
    payload.withUnsafeBytes { _ = fwrite($0.baseAddress, 1, payload.count, stdout) }
    fflush(stdout)
  }
}

/// A word to the node (kind 3): `input`, `noinput <why>`.
func tell(_ word: String) {
  emit(kind: 3, key: false, screen: (0, 0), picture: (0, 0), Data(word.utf8))
}

/// The picture's size for a screen of `w` x `h`: its longer side `side` at most, even numbers (H.264 needs them).
func fitted(_ w: Int, _ h: Int, _ side: Int) -> (Int, Int) {
  let s = min(1.0, Double(side) / Double(max(w, h)))
  return (max(2, Int((Double(w) * s) / 2) * 2), max(2, Int((Double(h) * s) / 2) * 2))
}

let ci = CIContext(options: [.cacheIntermediates: false])
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

func jpeg(_ image: CIImage, _ size: (Int, Int)) -> Data? {
  let scaled = image.transformed(by: CGAffineTransform(scaleX: CGFloat(size.0) / image.extent.width, y: CGFloat(size.1) / image.extent.height))
  return ci.jpegRepresentation(of: scaled, colorSpace: srgb, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.7])
}

/// H.264 from VideoToolbox: low-latency rate control, no frame reordering, a keyframe only when asked.
final class Encoder {
  private var session: VTCompressionSession?
  private var size = (0, 0)
  private var kbps = 0
  private var screen = (0, 0)
  private var scaler: VTPixelTransferSession?
  private var pool: CVPixelBufferPool?

  private func make(_ size: (Int, Int)) {
    if let s = session { VTCompressionSessionInvalidate(s) }
    session = nil
    let spec: [CFString: Any] = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true]
    var s: VTCompressionSession?
    let made = VTCompressionSessionCreate(
      allocator: nil, width: Int32(size.0), height: Int32(size.1), codecType: kCMVideoCodecType_H264,
      encoderSpecification: spec as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
      outputCallback: nil, refcon: nil, compressionSessionOut: &s)
    guard made == noErr, let s else { fail("VideoToolbox made no H.264 encoder (\(made))") }
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Main_AutoLevel)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 100_000 as CFNumber)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: wants.fps as CFNumber)
    VTCompressionSessionPrepareToEncodeFrames(s)
    session = s
    self.size = size
    kbps = 0
    pool = nil
    var p: CVPixelBufferPool?
    let attrs: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferWidthKey: size.0, kCVPixelBufferHeightKey: size.1,
      kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
    ]
    CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &p)
    pool = p
  }

  func encode(_ pixels: CVPixelBuffer, screen: (Int, Int), at: CMTime) {
    let want = fitted(CVPixelBufferGetWidth(pixels), CVPixelBufferGetHeight(pixels), wants.side)
    var key = wants.takeKey()
    if session == nil || want != size { make(want); key = true }
    guard let session, let pool else { return }
    if kbps != wants.kbps {
      kbps = wants.kbps
      VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: (kbps * 1000) as CFNumber)
    }
    // The picture at its size, in the encoder's own format, scaled by the hardware.
    if scaler == nil { VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &scaler) }
    var into: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &into)
    guard let scaler, let into, VTPixelTransferSessionTransferImage(scaler, from: pixels, to: into) == noErr else { return }
    self.screen = screen
    let props = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary : nil
    let size = self.size
    VTCompressionSessionEncodeFrame(session, imageBuffer: into, presentationTimeStamp: at, duration: .invalid, frameProperties: props, infoFlagsOut: nil) { status, _, sample in
      guard status == noErr, let sample, let data = annexB(sample) else { return }
      emit(kind: 2, key: data.key, screen: screen, picture: size, data.bytes)
    }
  }
}

/// A sample's access unit as Annex B, its parameter sets first on a keyframe.
func annexB(_ sample: CMSampleBuffer) -> (bytes: Data, key: Bool)? {
  guard let block = CMSampleBufferGetDataBuffer(sample), let format = CMSampleBufferGetFormatDescription(sample) else { return nil }
  let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
  let key = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
  let start: [UInt8] = [0, 0, 0, 1]
  var out = Data()
  if key {
    var count = 0
    CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
    for i in 0..<count {
      var p: UnsafePointer<UInt8>?
      var n = 0
      CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i, parameterSetPointerOut: &p, parameterSetSizeOut: &n, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
      if let p { out.append(contentsOf: start); out.append(p, count: n) }
    }
  }
  var length = 0
  var base: UnsafeMutablePointer<CChar>?
  guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &base) == noErr, let base else { return nil }
  var at = 0
  while at + 4 <= length {
    let raw = UnsafeRawPointer(base + at)
    let n = Int(UInt32(bigEndian: raw.loadUnaligned(as: UInt32.self)))
    at += 4
    guard at + n <= length else { break }
    out.append(contentsOf: start)
    out.append(Data(bytes: raw + 4, count: n))
    at += n
  }
  return (out, key)
}

let encoder = Encoder()
let clock = Date()
var lastSent = 0.0

let sending = NSLock()

/// One look at the screen: a frame of it if one is due (the fps) or a still is asked for; false if it wasn't due, for
/// the caller to look again then.
@discardableResult
func send(_ pixels: CVPixelBuffer, screen: (Int, Int)) -> Bool {
  sending.lock()
  defer { sending.unlock() }
  let now = Date().timeIntervalSince(clock)
  if !wants.stillWaiting && now - lastSent < 1.0 / wants.fps - 0.002 { return false }
  let still = wants.takeStill()
  lastSent = now
  if wants.h264 && !still {
    encoder.encode(pixels, screen: screen, at: CMTime(seconds: now, preferredTimescale: 1000))
  } else {
    let image = CIImage(cvPixelBuffer: pixels)
    let size = fitted(Int(image.extent.width), Int(image.extent.height), wants.side)
    if let data = jpeg(image, size) { emit(kind: 1, key: true, screen: screen, picture: size, data) }
    // A still asked for during H.264 leaves the next H.264 frame to be a keyframe, so a new watcher's decoder starts.
    if still && wants.h264 { wants.command("key") }
  }
  return true
}

/// How long until a frame is due again.
func untilDue() -> Double { max(0, lastSent + 1.0 / wants.fps - Date().timeIntervalSince(clock)) }

// MARK: an iOS simulator's framebuffer

func simulator(set: String, udid: String) -> Never {
  guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil else { fail("no CoreSimulator") }
  let developer = xcodeDeveloperDir()
  guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else { fail("CoreSimulator has no SimServiceContext") }
  let shared = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
  guard let context = contextClass.perform(shared, with: developer, with: nil)?.takeUnretainedValue() as? NSObject else { fail("no simulator service") }
  guard let deviceSet = context.perform(NSSelectorFromString("deviceSetWithPath:error:"), with: set, with: nil)?.takeUnretainedValue() as? NSObject else { fail("no device set at \(set)") }
  guard let devices = deviceSet.value(forKey: "devices") as? [NSObject],
    let device = devices.first(where: { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid.uppercased() })
  else { fail("no simulator \(udid) in \(set)") }
  let renderable = NSProtocolFromString("SimDisplayIOSurfaceRenderable")
  let hid = Hid(device: device)
  onInput = { hid.input($0) }
  Thread.detachNewThread { hid.connect() }

  /// The device's display framebuffers now: a rotation or a restart of the display may replace one. A foldable phone
  /// has two panels, only one lit at a time.
  func surfaces() -> [IOSurfaceRef] {
    guard let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject,
      let ports = io.value(forKey: "ioPorts") as? [NSObject]
    else { return [] }
    var found: [IOSurfaceRef] = []
    for port in ports {
      guard let d = port.perform(NSSelectorFromString("descriptor"))?.takeUnretainedValue() as? NSObject else { continue }
      if let renderable, !d.conforms(to: renderable) { continue }
      for name in ["framebufferSurface", "ioSurface"] where d.responds(to: NSSelectorFromString(name)) {
        guard let s = d.perform(NSSelectorFromString(name))?.takeUnretainedValue() else { continue }
        found.append(unsafeBitCast(s, to: IOSurfaceRef.self))
        break
      }
    }
    return found
  }

  // Each panel's seed as last seen; the one shown is the one that changed last (the lit one: a dark panel never
  // changes), the largest until any has.
  var seeds: [UInt32] = []
  var all: [IOSurfaceRef] = []
  var shown: IOSurfaceRef?
  var shownSeed: UInt32 = 0
  var lastLook = 0.0
  let wake = DispatchSemaphore(value: 0)
  onCommand = { wake.signal() }
  while true {
    // Every second, the framebuffers again, in case one was replaced; between, only their seeds.
    let now = Date().timeIntervalSince(clock)
    if all.isEmpty || now - lastLook > 1 {
      let next = surfaces()
      if next.map({ IOSurfaceGetID($0) }) != all.map({ IOSurfaceGetID($0) }) {
        all = next
        seeds = all.map { IOSurfaceGetSeed($0) }
        shown = all.max { IOSurfaceGetWidth($0) * IOSurfaceGetHeight($0) < IOSurfaceGetWidth($1) * IOSurfaceGetHeight($1) }
        shownSeed = 0
      }
      lastLook = now
    }
    for (i, s) in all.enumerated() {
      let seed = IOSurfaceGetSeed(s)
      if seed != seeds[i] {
        seeds[i] = seed
        if shown.map({ IOSurfaceGetID($0) }) != IOSurfaceGetID(s) { shown = s; shownSeed = 0 }
      }
    }
    if let s = shown {
      let seed = IOSurfaceGetSeed(s)
      // A change that isn't due yet waits for its time: seen only once it is sent, so the last one always goes.
      if seed != shownSeed || wants.stillWaiting {
        var pixels: Unmanaged<CVPixelBuffer>?
        hid.screen = (IOSurfaceGetWidth(s), IOSurfaceGetHeight(s))
        if CVPixelBufferCreateWithIOSurface(nil, s, nil, &pixels) == kCVReturnSuccess, let p = pixels?.takeRetainedValue(),
          send(p, screen: (IOSurfaceGetWidth(s), IOSurfaceGetHeight(s)))
        {
          shownSeed = seed
        }
      }
    }
    _ = wake.wait(timeout: .now() + .milliseconds(8))
  }
}

/// A person's input, straight into the simulator's HID service: dtuhidd's digitizer, which Xcode 27's CoreSimulator
/// starts in each device (it drops the older Indigo messages), over the XPC connection CoreSimulator vends into the
/// device, as Simulator.app and idb do. A tap lands within a frame or two of the touch, where agent-device takes a
/// process and an XCTest round trip (0.4-0.9 s).
final class Hid {
  static let service = "com.apple.coredevice.feature.remote.hid.digitizer"
  private let device: NSObject
  private let lock = NSLock()
  private var connection: xpc_connection_t?
  private var _screen = (0, 0)
  /// Whether a finger is down, as dtuhidd knows it: a connection it dropped loses the finger.
  private var down = false
  /// The edge the finger down started at: every contact of an edge gesture carries it, or iOS ignores it.
  private var edge: UInt64 = 0

  init(device: NSObject) { self.device = device }

  /// The shown panel's size: touches come in its pixels.
  var screen: (Int, Int) {
    get { lock.lock(); defer { lock.unlock() }; return _screen }
    set { lock.lock(); _screen = newValue; lock.unlock() }
  }

  /// Connects and waits for dtuhidd to answer, then says `input`. It starts on demand, and one that started before the
  /// device's display was up dies and is held back by launchd for a few seconds: so a few tries.
  func connect() {
    var why = "dtuhidd did not answer"
    for attempt in 0..<5 {
      if attempt > 0 { Thread.sleep(forTimeInterval: 3) }
      guard let c = open(&why) else { continue }
      let answered = DispatchSemaphore(value: 0)
      var ok = false
      xpc_connection_send_message_with_reply(c, message("IndigoKeyboardButtonEvent", barrier: true) { p in
        // Usage 0 is no key: the guest sees nothing.
        xpc_dictionary_set_uint64(p, "usageCode", 0)
        xpc_dictionary_set_uint64(p, "state", 2)
      }, DispatchQueue.global()) { reply in
        ok = xpc_get_type(reply) != XPC_TYPE_ERROR
        answered.signal()
      }
      if answered.wait(timeout: .now() + 4) == .success, ok {
        // The device opens for it just after its answer.
        Thread.sleep(forTimeInterval: 0.2)
        lock.lock(); connection = c; lock.unlock()
        return tell("input")
      }
      xpc_connection_cancel(c)
      why = "dtuhidd did not answer"
    }
    tell("noinput \(why)")
  }

  /// The connection to the device's dtuhidd, made from the service's port in the device's own namespace.
  private func open(_ why: inout String) -> xpc_connection_t? {
    typealias Lookup = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> mach_port_t
    typealias EndpointFromPort = @convention(c) (mach_port_t, UInt64, UInt64) -> Unmanaged<AnyObject>?
    typealias ConnectionFromEndpoint = @convention(c) (xpc_object_t) -> Unmanaged<AnyObject>?
    typealias EnableSim2Host = @convention(c) (xpc_connection_t) -> Void
    let lookup = NSSelectorFromString("lookup:error:")
    guard device.responds(to: lookup) else { why = "CoreSimulator has no service lookup"; return nil }
    let here = dlopen(nil, RTLD_NOW)
    guard let fromPort = dlsym(here, "xpc_endpoint_create_mach_port_4sim"), let fromEndpoint = dlsym(here, "xpc_connection_create_from_endpoint"),
      let sim2host = dlsym(here, "xpc_connection_enable_sim2host_4sim")
    else { why = "no simulator XPC in this macOS"; return nil }
    var error: NSError?
    let port = unsafeBitCast(device.method(for: lookup), to: Lookup.self)(device, lookup, Hid.service as NSString, &error)
    guard port != MACH_PORT_NULL else { why = "no \(Hid.service) in the simulator (\(error?.localizedDescription ?? "no port"))"; return nil }
    guard let endpoint = unsafeBitCast(fromPort, to: EndpointFromPort.self)(port, 0, 0)?.takeRetainedValue() as? xpc_object_t,
      let c = unsafeBitCast(fromEndpoint, to: ConnectionFromEndpoint.self)(endpoint)?.takeRetainedValue() as? xpc_connection_t
    else { why = "no connection to dtuhidd"; return nil }
    // Without it dtuhidd sees the connection but never a message.
    unsafeBitCast(sim2host, to: EnableSim2Host.self)(c)
    xpc_connection_set_target_queue(c, DispatchQueue(label: "hid"))
    xpc_connection_set_event_handler(c) { [weak self] event in
      guard let self, xpc_get_type(event) == XPC_TYPE_ERROR else { return }
      self.lock.lock()
      // Interrupted: the next message reconnects, but the finger is gone. Invalid: no more input this way.
      self.down = false
      let lost = event === XPC_ERROR_CONNECTION_INVALID && self.connection != nil
      if lost { self.connection = nil }
      self.lock.unlock()
      if lost { tell("noinput dtuhidd's connection ended") }
    }
    xpc_connection_resume(c)
    return c
  }

  private func message(_ type: String, barrier: Bool = false, _ fill: (xpc_object_t) -> Void) -> xpc_object_t {
    let m = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_string(m, "messageType", type)
    xpc_dictionary_set_bool(m, "isBarrier", barrier)
    xpc_dictionary_set_string(m, "featureIdentifier", Hid.service)
    let payload = xpc_dictionary_create(nil, nil, 0)
    fill(payload)
    xpc_dictionary_set_value(m, "payload", payload)
    return m
  }

  /// One input command, its words as the node wrote them.
  func input(_ words: [Substring]) {
    lock.lock()
    guard let c = connection else { lock.unlock(); return }
    var m: xpc_object_t?
    switch (words.first ?? "", words.count) {
    case ("touch", 5):
      let (w, h) = _screen
      guard w > 0, h > 0, let x = Double(words[2]), let y = Double(words[3]) else { break }
      // A move with no finger down (dtuhidd lost it) starts one; an up with none is nothing.
      let phase: UInt64
      switch words[1] {
      case "down": phase = 0; down = true; edge = UInt64(words[4]) ?? 0
      case "move": phase = down ? 1 : 0; if !down { edge = 0 }; down = true
      case "up" where down: phase = 2; down = false
      default: lock.unlock(); return
      }
      let edge = self.edge
      m = message("IndigoDigitizerEvent") { p in
        let point = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_double(point, "x", min(max(x / Double(w), 0), 1))
        xpc_dictionary_set_double(point, "y", min(max(y / Double(h), 0), 1))
        xpc_dictionary_set_value(p, "pointOne", point)
        xpc_dictionary_set_uint64(p, "eventType", phase)
        xpc_dictionary_set_uint64(p, "edge", edge)
        xpc_dictionary_set_uint64(p, "target", 0)
      }
    case ("keyboard", 3):
      guard let usage = UInt64(words[1]) else { break }
      m = message("IndigoKeyboardButtonEvent") { p in
        xpc_dictionary_set_uint64(p, "usageCode", usage)
        xpc_dictionary_set_uint64(p, "state", words[2] == "down" ? 1 : 2)
      }
    case ("button", 2) where words[1] == "home":
      // The consumer page's Menu usage: Home. Down then up.
      for state: UInt64 in [1, 2] {
        xpc_connection_send_message(c, message("IndigoButtonEvent") { p in
          xpc_dictionary_set_uint64(p, "usagePage", 0x0C)
          xpc_dictionary_set_uint64(p, "usageCode", 0x40)
          xpc_dictionary_set_uint64(p, "state", state)
        })
      }
    default: break
    }
    lock.unlock()
    if let m { xpc_connection_send_message(c, m) }
  }
}

func xcodeDeveloperDir() -> String {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
  p.arguments = ["-p"]
  let pipe = Pipe()
  p.standardOutput = pipe
  try? p.run()
  p.waitUntilExit()
  let s = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return s.isEmpty ? "/Applications/Xcode.app/Contents/Developer" : s
}

// MARK: the Mac's main display

final class Display: NSObject, SCStreamOutput, SCStreamDelegate {
  var stream: SCStream?
  var last: CVPixelBuffer?
  var screen = (0, 0)

  func start() {
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
      guard let content else { fail("macOS refused the screen's content: \(error?.localizedDescription ?? "no answer")") }
      let main = CGMainDisplayID()
      guard let display = content.displays.first(where: { $0.displayID == main }) ?? content.displays.first else { fail("no display") }
      // Frames at the display's points: CGEvent's coordinates.
      self.screen = (display.width, display.height)
      let config = SCStreamConfiguration()
      config.width = display.width
      config.height = display.height
      config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
      config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      config.showsCursor = true
      config.queueDepth = 4
      let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: self)
      do {
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames"))
      } catch { fail("no stream output: \(error.localizedDescription)") }
      stream.startCapture { error in if let error { fail("the screen is not captured: \(error.localizedDescription)") } }
      self.stream = stream
    }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sample.isValid,
      let info = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let raw = info.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
      let pixels = CMSampleBufferGetImageBuffer(sample)
    else { return }
    last = pixels
    if !send(pixels, screen: screen) { later(pixels) }
  }

  /// A frame that wasn't due goes when it is, unless a newer one came meanwhile: the screen's last change always shows.
  func later(_ pixels: CVPixelBuffer) {
    DispatchQueue.global().asyncAfter(deadline: .now() + untilDue()) {
      guard self.last === pixels else { return }
      if !send(pixels, screen: self.screen) { self.later(pixels) }
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail("the screen's capture stopped: \(error.localizedDescription)")
  }
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "sim" where args.count == 4:
  simulator(set: args[2], udid: args[3])
case "screen":
  let display = Display()
  // A still asked for on a screen that isn't changing: the newest frame again.
  onCommand = {
    guard wants.stillWaiting, let p = display.last else { return }
    DispatchQueue.global().async { send(p, screen: display.screen) }
  }
  display.start()
  dispatchMain()
default:
  fail("usage: fleetd-frames sim <device set> <udid> | fleetd-frames screen")
}
