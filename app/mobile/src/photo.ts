// A photo from the camera or the library, made fit to send before it goes up (Composer.tsx): at most PHOTO_SIDE pixels
// on its long side, JPEG at PHOTO_QUALITY, drawn upright as its EXIF said and written again with no EXIF at all, so its
// GPS position never leaves the phone. A 12 MP photo is 1.8 MB as the picker gives it and ~190 KB here, which on a
// cellular uplink is seconds rather than half a minute, and more than an agent's vision reads anyway. PNGs (screenshots,
// whose text must stay sharp) and files go as they are. It takes expo-image-manipulator's native module; a bundle on a
// build made before it sends the photo as the picker gave it. Pure but for the module it is given, so it is unit-tested.

/** The long side a photo goes up at, in pixels. */
export const PHOTO_SIDE = 2048;
/** Its JPEG quality, 0 to 1. */
export const PHOTO_QUALITY = 0.8;

/** What the picker says of a photo. */
export interface PickedPhoto {
  readonly uri: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

/** expo-image-manipulator's part this takes (ImageManipulator.manipulate…saveAsync). */
export interface Manipulator {
  manipulate(uri: string): {
    resize(size: { width?: number | null; height?: number | null }): unknown;
    renderAsync(): Promise<{ saveAsync(options: { compress: number; format: "jpeg" }): Promise<{ uri: string }> }>;
  };
}

/** The resize a photo of this size takes, its long side to PHOTO_SIDE; none when it is that small already or unknown. */
export const resizeFor = (width: number | undefined, height: number | undefined): { readonly width: number } | { readonly height: number } | undefined => {
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  if (Math.max(width, height) <= PHOTO_SIDE) return undefined;
  return width >= height ? { width: PHOTO_SIDE } : { height: PHOTO_SIDE };
};

/**
 * The photo as it goes up: its file written again by `manipulator` (shrunk when larger than PHOTO_SIDE; re-encoded
 * either way, which drops its EXIF and GPS), or the picker's own when there is no manipulator or it fails.
 */
export const fitPhoto = async (photo: PickedPhoto, manipulator: Manipulator | null): Promise<string> => {
  if (manipulator === null) return photo.uri;
  try {
    const context = manipulator.manipulate(photo.uri);
    const size = resizeFor(photo.width, photo.height);
    if (size !== undefined) context.resize(size);
    const image = await context.renderAsync();
    return (await image.saveAsync({ compress: PHOTO_QUALITY, format: "jpeg" })).uri;
  } catch {
    return photo.uri;
  }
};
