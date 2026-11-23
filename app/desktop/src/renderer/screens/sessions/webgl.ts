// What WebGL this window has, read once from a throwaway context, before any device shows: drawn on a graphics card,
// on the CPU (SwiftShader, llvmpipe), or none. A device stage starts in the mode that fits (DeviceStage), so a machine
// without a graphics card never loads three.js or builds a 3D stage just to find it should show the device flat.

export type Webgl = "gpu" | "software" | "none";

let known: Webgl | undefined;

/** This window's WebGL, probed at its first ask. */
export function webgl(): Webgl {
  known ??= probe();
  return known;
}

function probe(): Webgl {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (gl === null) return "none";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = info === null ? "" : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return /swiftshader|llvmpipe|software|softpipe/iu.test(name) ? "software" : "gpu";
  } catch {
    return "none";
  }
}
