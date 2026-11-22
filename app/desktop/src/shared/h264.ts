// The live view's H.264 as the apps decode it (renderer/screens/sessions/video.ts), shared with the web app's check
// of whether its browser can (web/hub.ts).

/** High profile, level 4: the node's encoders make Main or High (Annex B, so no description); its decoder takes both. */
export const H264_CODEC = "avc1.640028";

/** The decoder's configuration. */
export const H264_CONFIG = { codec: H264_CODEC, optimizeForLatency: true } as const;
