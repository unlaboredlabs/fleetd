//! An image's preview (attachment_get's maxSide): what a chat bubble shows on the phone or the desktop, rather than the
//! photo or screenshot itself, which the full-screen viewer reads. A png, jpeg or webp larger than the side asked for
//! is decoded, turned upright as its EXIF says, shrunk to fit and encoded as a JPEG, or as a PNG where any pixel is
//! clear. One already that small, one whose shrunk copy isn't smaller than the file, one that won't decode, and anything
//! else (a GIF, which may move) come as themselves. Nothing is kept on the hub: the apps keep what they read.
use std::io::Cursor;

use fleetd_contracts::mcp::AttachmentMime;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};

/// A picture wider or taller than this isn't decoded for a preview.
const SOURCE_MAX_PX: u32 = 12_000;
/// The most memory decoding one picture may take.
const SOURCE_MAX_ALLOC: u64 = 512 * 1024 * 1024;
/// A preview's JPEG quality: a bubble's photo or screenshot, its text still crisp.
const QUALITY: u8 = 82;
/// Pictures decoded for previews at once: each may take up to SOURCE_MAX_ALLOC, and a chat's bubbles all ask together,
/// so the rest wait their turn rather than hold gigabytes on a small hub.
pub static TURNS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// The picture in `bytes` shrunk to at most `side` pixels a side, and its type; None when the file itself is the
/// better answer.
pub fn shrink(bytes: &[u8], mime: AttachmentMime, side: u32) -> Option<(Vec<u8>, AttachmentMime)> {
    let format = match mime {
        AttachmentMime::Png => ImageFormat::Png,
        AttachmentMime::Jpeg => ImageFormat::Jpeg,
        AttachmentMime::Webp => ImageFormat::WebP,
        _ => return None,
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(SOURCE_MAX_PX);
    limits.max_image_height = Some(SOURCE_MAX_PX);
    limits.max_alloc = Some(SOURCE_MAX_ALLOC);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().ok()?;
    let (w, h) = decoder.dimensions();
    if w <= side && h <= side {
        return None;
    }
    let orientation = decoder.orientation().ok()?;
    let mut picture = DynamicImage::from_decoder(decoder).ok()?;
    picture.apply_orientation(orientation);
    let small = picture.thumbnail(side, side);
    let clear = small.color().has_alpha() && small.to_rgba8().pixels().any(|p| p.0[3] < 255);
    let mut out = Vec::new();
    let as_mime = if clear {
        small
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .ok()?;
        AttachmentMime::Png
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, QUALITY)
            .encode_image(&small.to_rgb8())
            .ok()?;
        AttachmentMime::Jpeg
    };
    (out.len() < bytes.len()).then_some((out, as_mime))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, Rgb, RgbImage, Rgba, RgbaImage};

    fn png(picture: DynamicImage) -> Vec<u8> {
        let mut out = Vec::new();
        picture
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    /// Noise, so neither the PNG nor the JPEG of it is tiny.
    fn noisy(w: u32, h: u32) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| {
            let n = x.wrapping_mul(2_654_435_761) ^ y.wrapping_mul(40_503);
            Rgb([n as u8, (n >> 8) as u8, (x + y) as u8])
        })
    }

    #[test]
    fn a_large_screenshot_comes_as_a_jpeg_that_fits_the_side() {
        let file = png(DynamicImage::ImageRgb8(noisy(2560, 1600)));
        let (small, mime) = shrink(&file, AttachmentMime::Png, 1024).unwrap();
        assert_eq!(mime, AttachmentMime::Jpeg);
        assert!(small.len() < file.len());
        let read = image::load_from_memory(&small).unwrap();
        assert_eq!(read.dimensions(), (1024, 640));
    }

    #[test]
    fn a_picture_with_clear_pixels_stays_a_png() {
        let clear = RgbaImage::from_fn(2000, 400, |x, y| {
            let n = x.wrapping_mul(2_654_435_761) ^ y.wrapping_mul(40_503);
            Rgba([n as u8, (n >> 8) as u8, 9, if x < 100 { 0 } else { 255 }])
        });
        let file = png(DynamicImage::ImageRgba8(clear));
        let (small, mime) = shrink(&file, AttachmentMime::Png, 500).unwrap();
        assert_eq!(mime, AttachmentMime::Png);
        assert_eq!(
            image::load_from_memory(&small).unwrap().dimensions(),
            (500, 100)
        );
    }

    #[test]
    fn a_small_picture_a_gif_and_junk_come_as_themselves() {
        let file = png(DynamicImage::ImageRgb8(noisy(800, 600)));
        assert!(shrink(&file, AttachmentMime::Png, 1024).is_none());
        assert!(shrink(b"GIF89a....", AttachmentMime::Gif, 64).is_none());
        assert!(shrink(b"\x89PNG\r\n\x1a\nnot really", AttachmentMime::Png, 64).is_none());
        assert!(shrink(b"%PDF-1.7", AttachmentMime::Pdf, 64).is_none());
    }

    #[test]
    fn a_photo_turned_by_its_exif_comes_upright() {
        // A 3000 × 1000 JPEG whose EXIF says it was taken turned 90°: shown, it stands 1000 × 3000.
        let mut jpeg = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80);
        let exif = [
            b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0,
            0,
        ];
        image::ImageEncoder::set_exif_metadata(&mut encoder, exif.to_vec()).unwrap();
        encoder.encode_image(&noisy(3000, 1000)).unwrap();
        let (small, _) = shrink(&jpeg, AttachmentMime::Jpeg, 900).unwrap();
        assert_eq!(
            image::load_from_memory(&small).unwrap().dimensions(),
            (300, 900)
        );
    }
}
