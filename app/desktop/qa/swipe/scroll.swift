// Posts a trackpad's scroll events at the screen, as macOS's own driver does (qa/swipe.spec.ts): each with its scroll
// phase (the fingers: may begin, began, changed, ended) or its momentum phase (after they lift: begin, continue, end),
// its deltas in pixels, continuous. Usage: scroll <x> <y> <steps.json>, steps a list of
// {"dx": n, "dy": n, "phase": n, "momentum": n, "wait": ms} (hubSwipe.samples.ts), phase and momentum as CGScrollPhase
// and CGMomentumScrollPhase number them, dx and dy as the page reads them. The pointer is put at (x, y) once, in
// global display points, and never moved again.
import CoreGraphics
import Foundation

struct Step: Decodable {
  let dx: Double
  let dy: Double
  let phase: Int64
  let momentum: Int64
  let wait: Double
}

let args = CommandLine.arguments
guard args.count == 4, let x = Double(args[1]), let y = Double(args[2]) else {
  FileHandle.standardError.write("usage: scroll <x> <y> <steps.json>\n".data(using: .utf8)!)
  exit(2)
}
let steps = try JSONDecoder().decode([Step].self, from: Data(contentsOf: URL(fileURLWithPath: args[3])))
let at = CGPoint(x: x, y: y)
let source = CGEventSource(stateID: .hidSystemState)
if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: at, mouseButton: .left) {
  move.post(tap: .cghidEventTap)
}
usleep(200_000)
for s in steps {
  // wheel1 is vertical, wheel2 horizontal; a trackpad's positive delta scrolls content toward the top and the left.
  guard let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(-s.dy), wheel2: Int32(-s.dx), wheel3: 0) else {
    continue
  }
  e.location = at
  e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
  e.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: Int64(-s.dy))
  e.setIntegerValueField(.scrollWheelEventPointDeltaAxis2, value: Int64(-s.dx))
  e.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: -s.dy)
  e.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: -s.dx)
  e.setIntegerValueField(.scrollWheelEventScrollPhase, value: s.phase)
  e.setIntegerValueField(.scrollWheelEventMomentumPhase, value: s.momentum)
  e.post(tap: .cghidEventTap)
  usleep(useconds_t(s.wait * 1000))
}
