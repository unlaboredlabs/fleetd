// pdf.js's image decoders the app ships (scripts/pdfjsDecoders.ts copies them, screens/files/pdfOptions.ts points
// pdf.js at them): JBIG2 and CCITT fax, and JPEG 2000, in their plain-module builds. Named as pdf.js imports them.
export const PDFJS_DECODERS = ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js"] as const;
