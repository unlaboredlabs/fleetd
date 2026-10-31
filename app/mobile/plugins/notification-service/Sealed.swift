// libsodium's crypto_box_seal_open, for the Notification Service Extension (D218): the hub seals
// each notification with crypto_box_seal to this phone's X25519 key. X25519 is CryptoKit's; XSalsa20-Poly1305 and
// BLAKE2b, which CryptoKit lacks, are written out here (NaCl's crypto_box, RFC 7693), so the extension needs no pod.
// The app opens the same boxes in JavaScript (src/seal.ts); test.swift checks this against the hub's own fixture.
import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

enum Sealed {
  /// X25519(secret key, their public key): the shared secret, or nil.
  typealias Agree = (_ theirs: [UInt8]) -> [UInt8]?

  #if canImport(CryptoKit)
  /// Opens a box sealed to `secretKey`'s public key; nil when it isn't one.
  static func open(_ sealed: [UInt8], secretKey: [UInt8]) -> [UInt8]? {
    guard let mine = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secretKey) else { return nil }
    return open(sealed, publicKey: [UInt8](mine.publicKey.rawRepresentation)) { theirs in
      guard let key = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: theirs),
            let shared = try? mine.sharedSecretFromKeyAgreement(with: key) else { return nil }
      return shared.withUnsafeBytes { [UInt8]($0) }
    }
  }
  #endif

  /// ephemeral public key (32) ‖ Poly1305 tag (16) ‖ ciphertext, the nonce BLAKE2b-192(ephemeral ‖ recipient).
  static func open(_ sealed: [UInt8], publicKey: [UInt8], agree: Agree) -> [UInt8]? {
    guard sealed.count >= 48, publicKey.count == 32 else { return nil }
    let ephemeral = Array(sealed[0..<32])
    guard let shared = agree(ephemeral) else { return nil }
    let nonce = blake2b(ephemeral + publicKey, outLength: 24)
    // crypto_box_beforenm, then crypto_secretbox_open.
    let key = hsalsa20(key: shared, input: [UInt8](repeating: 0, count: 16))
    let subkey = hsalsa20(key: key, input: Array(nonce[0..<16]))
    let tag = Array(sealed[32..<48])
    let ciphertext = Array(sealed[48...])
    let stream = salsa20(key: subkey, nonce: Array(nonce[16..<24]), count: 32 + ciphertext.count)
    guard equal(poly1305(ciphertext, key: Array(stream[0..<32])), tag) else { return nil }
    return zip(ciphertext, stream[32...]).map { $0 ^ $1 }
  }

  private static func equal(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    guard a.count == b.count else { return false }
    var d: UInt8 = 0
    for i in 0..<a.count { d |= a[i] ^ b[i] }
    return d == 0
  }

  private static func le32(_ b: [UInt8], _ i: Int) -> UInt32 {
    UInt32(b[i]) | UInt32(b[i + 1]) << 8 | UInt32(b[i + 2]) << 16 | UInt32(b[i + 3]) << 24
  }

  private static func put32(_ out: inout [UInt8], _ i: Int, _ v: UInt32) {
    for k in 0..<4 { out[i + k] = UInt8(truncatingIfNeeded: v >> (8 * UInt32(k))) }
  }

  // MARK: Salsa20

  private static let sigma: [UInt32] = [0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574]

  private static func rotl(_ v: UInt32, _ n: UInt32) -> UInt32 { (v << n) | (v >> (32 - n)) }

  /// The 20 rounds over a state of the key, the constants and a 16-byte input.
  private static func rounds(key: [UInt8], input: [UInt8]) -> (start: [UInt32], end: [UInt32]) {
    var x = [UInt32](repeating: 0, count: 16)
    for i in 0..<4 {
      x[5 * i] = sigma[i]
      x[1 + i] = le32(key, 4 * i)
      x[11 + i] = le32(key, 16 + 4 * i)
      x[6 + i] = le32(input, 4 * i)
    }
    let start = x
    func qr(_ a: Int, _ b: Int, _ c: Int, _ d: Int) {
      x[b] ^= rotl(x[a] &+ x[d], 7)
      x[c] ^= rotl(x[b] &+ x[a], 9)
      x[d] ^= rotl(x[c] &+ x[b], 13)
      x[a] ^= rotl(x[d] &+ x[c], 18)
    }
    for _ in 0..<10 {
      qr(0, 4, 8, 12); qr(5, 9, 13, 1); qr(10, 14, 2, 6); qr(15, 3, 7, 11)
      qr(0, 1, 2, 3); qr(5, 6, 7, 4); qr(10, 11, 8, 9); qr(15, 12, 13, 14)
    }
    return (start, x)
  }

  static func hsalsa20(key: [UInt8], input: [UInt8]) -> [UInt8] {
    let x = rounds(key: key, input: input).end
    var out = [UInt8](repeating: 0, count: 32)
    for (i, w) in [0, 5, 10, 15, 6, 7, 8, 9].enumerated() { put32(&out, 4 * i, x[w]) }
    return out
  }

  /// `count` bytes of Salsa20's key stream under an 8-byte nonce, from block 0.
  static func salsa20(key: [UInt8], nonce: [UInt8], count: Int) -> [UInt8] {
    var out = [UInt8]()
    out.reserveCapacity(count + 64)
    var block: UInt64 = 0
    while out.count < count {
      var input = nonce
      for k in 0..<8 { input.append(UInt8(truncatingIfNeeded: block >> (8 * UInt64(k)))) }
      let (start, end) = rounds(key: key, input: input)
      var bytes = [UInt8](repeating: 0, count: 64)
      for i in 0..<16 { put32(&bytes, 4 * i, end[i] &+ start[i]) }
      out += bytes
      block += 1
    }
    return Array(out[0..<count])
  }

  // MARK: Poly1305 (26-bit limbs, as poly1305-donna)

  static func poly1305(_ m: [UInt8], key: [UInt8]) -> [UInt8] {
    let mask: UInt32 = 0x3ff_ffff
    let r0 = le32(key, 0) & 0x3ff_ffff
    let r1 = (le32(key, 3) >> 2) & 0x3ff_ff03
    let r2 = (le32(key, 6) >> 4) & 0x3ff_c0ff
    let r3 = (le32(key, 9) >> 6) & 0x3f0_3fff
    let r4 = (le32(key, 12) >> 8) & 0x00f_ffff
    let (s1, s2, s3, s4) = (r1 * 5, r2 * 5, r3 * 5, r4 * 5)
    var (h0, h1, h2, h3, h4): (UInt32, UInt32, UInt32, UInt32, UInt32) = (0, 0, 0, 0, 0)
    var at = 0
    while at < m.count {
      var block = [UInt8](repeating: 0, count: 17)
      let n = min(16, m.count - at)
      for i in 0..<n { block[i] = m[at + i] }
      // A full block's 2^128 bit; a short one ends in a 1 byte instead.
      let hibit: UInt32 = n == 16 ? 1 << 24 : 0
      if n < 16 { block[n] = 1 }
      at += n
      h0 &+= le32(block, 0) & mask
      h1 &+= (le32(block, 3) >> 2) & mask
      h2 &+= (le32(block, 6) >> 4) & mask
      h3 &+= (le32(block, 9) >> 6) & mask
      h4 &+= (le32(block, 12) >> 8) | hibit
      func mul(_ a: UInt32, _ b: UInt32) -> UInt64 { UInt64(a) * UInt64(b) }
      let d0 = mul(h0, r0) + mul(h1, s4) + mul(h2, s3) + mul(h3, s2) + mul(h4, s1)
      var d1 = mul(h0, r1) + mul(h1, r0) + mul(h2, s4) + mul(h3, s3) + mul(h4, s2)
      var d2 = mul(h0, r2) + mul(h1, r1) + mul(h2, r0) + mul(h3, s4) + mul(h4, s3)
      var d3 = mul(h0, r3) + mul(h1, r2) + mul(h2, r1) + mul(h3, r0) + mul(h4, s4)
      var d4 = mul(h0, r4) + mul(h1, r3) + mul(h2, r2) + mul(h3, r1) + mul(h4, r0)
      var c = d0 >> 26; h0 = UInt32(d0 & UInt64(mask))
      d1 += c; c = d1 >> 26; h1 = UInt32(d1 & UInt64(mask))
      d2 += c; c = d2 >> 26; h2 = UInt32(d2 & UInt64(mask))
      d3 += c; c = d3 >> 26; h3 = UInt32(d3 & UInt64(mask))
      d4 += c; c = d4 >> 26; h4 = UInt32(d4 & UInt64(mask))
      h0 &+= UInt32(truncatingIfNeeded: c) &* 5; let c0 = h0 >> 26; h0 &= mask
      h1 &+= c0
    }
    var c = h1 >> 26; h1 &= mask
    h2 &+= c; c = h2 >> 26; h2 &= mask
    h3 &+= c; c = h3 >> 26; h3 &= mask
    h4 &+= c; c = h4 >> 26; h4 &= mask
    h0 &+= c * 5; c = h0 >> 26; h0 &= mask
    h1 &+= c
    // h - p, kept when h ≥ p.
    var g0 = h0 &+ 5; c = g0 >> 26; g0 &= mask
    var g1 = h1 &+ c; c = g1 >> 26; g1 &= mask
    var g2 = h2 &+ c; c = g2 >> 26; g2 &= mask
    var g3 = h3 &+ c; c = g3 >> 26; g3 &= mask
    var g4 = h4 &+ c &- (1 << 26)
    var keep = (g4 >> 31) &- 1
    g0 &= keep; g1 &= keep; g2 &= keep; g3 &= keep; g4 &= keep
    keep = ~keep
    h0 = (h0 & keep) | g0; h1 = (h1 & keep) | g1; h2 = (h2 & keep) | g2; h3 = (h3 & keep) | g3; h4 = (h4 & keep) | g4
    let w0 = h0 | h1 << 26
    let w1 = h1 >> 6 | h2 << 20
    let w2 = h2 >> 12 | h3 << 14
    let w3 = h3 >> 18 | h4 << 8
    var f = UInt64(w0) + UInt64(le32(key, 16))
    var out = [UInt8](repeating: 0, count: 16)
    put32(&out, 0, UInt32(truncatingIfNeeded: f))
    f = UInt64(w1) + UInt64(le32(key, 20)) + (f >> 32); put32(&out, 4, UInt32(truncatingIfNeeded: f))
    f = UInt64(w2) + UInt64(le32(key, 24)) + (f >> 32); put32(&out, 8, UInt32(truncatingIfNeeded: f))
    f = UInt64(w3) + UInt64(le32(key, 28)) + (f >> 32); put32(&out, 12, UInt32(truncatingIfNeeded: f))
    return out
  }

  // MARK: BLAKE2b (RFC 7693, unkeyed)

  private static let iv: [UInt64] = [
    0x6a09_e667_f3bc_c908, 0xbb67_ae85_84ca_a73b, 0x3c6e_f372_fe94_f82b, 0xa54f_f53a_5f1d_36f1,
    0x510e_527f_ade6_82d1, 0x9b05_688c_2b3e_6c1f, 0x1f83_d9ab_fb41_bd6b, 0x5be0_cd19_137e_2179,
  ]

  private static let schedule: [[Int]] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  ]

  static func blake2b(_ input: [UInt8], outLength: Int) -> [UInt8] {
    var h = iv
    h[0] ^= 0x0101_0000 ^ UInt64(outLength)
    func rotr(_ v: UInt64, _ n: UInt64) -> UInt64 { (v >> n) | (v << (64 - n)) }
    func compress(_ block: [UInt8], _ t: UInt64, last: Bool) {
      var m = [UInt64](repeating: 0, count: 16)
      for i in 0..<16 {
        for k in 0..<8 { m[i] |= UInt64(block[8 * i + k]) << (8 * UInt64(k)) }
      }
      var v = h + iv
      v[12] ^= t
      if last { v[14] = ~v[14] }
      func g(_ a: Int, _ b: Int, _ c: Int, _ d: Int, _ x: UInt64, _ y: UInt64) {
        v[a] = v[a] &+ v[b] &+ x; v[d] = rotr(v[d] ^ v[a], 32)
        v[c] = v[c] &+ v[d]; v[b] = rotr(v[b] ^ v[c], 24)
        v[a] = v[a] &+ v[b] &+ y; v[d] = rotr(v[d] ^ v[a], 16)
        v[c] = v[c] &+ v[d]; v[b] = rotr(v[b] ^ v[c], 63)
      }
      for round in 0..<12 {
        let s = schedule[round % 10]
        g(0, 4, 8, 12, m[s[0]], m[s[1]]); g(1, 5, 9, 13, m[s[2]], m[s[3]])
        g(2, 6, 10, 14, m[s[4]], m[s[5]]); g(3, 7, 11, 15, m[s[6]], m[s[7]])
        g(0, 5, 10, 15, m[s[8]], m[s[9]]); g(1, 6, 11, 12, m[s[10]], m[s[11]])
        g(2, 7, 8, 13, m[s[12]], m[s[13]]); g(3, 4, 9, 14, m[s[14]], m[s[15]])
      }
      for i in 0..<8 { h[i] ^= v[i] ^ v[i + 8] }
    }
    var at = 0
    while input.count - at > 128 {
      compress(Array(input[at..<at + 128]), UInt64(at + 128), last: false)
      at += 128
    }
    var block = Array(input[at...])
    block += [UInt8](repeating: 0, count: 128 - block.count)
    compress(block, UInt64(input.count), last: true)
    var out = [UInt8]()
    for i in 0..<outLength { out.append(UInt8(truncatingIfNeeded: h[i / 8] >> (8 * UInt64(i % 8)))) }
    return out
  }
}
