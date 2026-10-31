"""The Rounds in glass, rendered with Blender Cycles.

Run headless: blender -b --factory-startup --python scene.py -- jobs.json
jobs.json: {"jobs": [{"being": "mo", "color": {"field": "#2E69CC"}, "size": 400, "samples": 128, "out": "a1.png"}]}

The scene, front on (the camera looks down -z at the icon; +y is up in the picture):
- a disc of radius 1 (the icon's round field), a soft diagonal gradient in the colour with faint silk bands, so the
  glass has something to bend;
- the body: the Rounds' silhouette as a slab with fully rounded edges, frosted glass under a clear coat, floating just
  above the disc so it casts a soft contact shadow and throws a little light through itself onto the disc;
- the face: dark ink shapes sunk inside the slab, under the coat;
- a studio: a bright soft key from the upper left in front, two low grazing strips that draw the rim, and a
  gradient environment for the glass to reflect.
"""

import colorsys
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy

HERE = Path(__file__).resolve().parent
SPEC = json.loads((HERE / "beings.json").read_text())
UNIT = 0.02  # one unit of the 100×100 box, in scene units: the disc's radius is 1
SCALE = 1.2  # the being drawn this much larger than in the box: about 70% of the disc across

# The slab: edges rounded with this radius, a flat top this far above the middle plane.
EDGE = 0.2
FLAT = 0.05
LIFT = 0.02
DOME = 0.035  # how much the top swells toward the middle: thicker there, a lens  # the gap between the disc and the slab's underside
BOWL = 0.05  # how deep an eye is cut into the slab's top
INK_GAP = 0.005  # the ink lies this far under a cut's surface


def dome(x, y):
    """How far the top has swelled at a scene point: most in the body's middle, nothing at its edge."""
    cx, cy = to_scene(50, 53)
    d = ((x - cx) / (29 * UNIT * SCALE)) ** 2 + ((y - cy) / (27 * UNIT * SCALE)) ** 2
    return DOME * max(0.0, 1 - d) ** 1.5


def to_scene(x, y):
    """A point of the box in the scene, scaled about the body's middle and set a touch low, so it sits."""
    return ((x - 50) * UNIT * SCALE, (52 - y) * UNIT * SCALE - 0.02)


def cubic(p0, p1, p2, p3, n):
    pts = []
    for i in range(n):
        t = i / n
        u = 1 - t
        pts.append(
            tuple(u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d for a, b, c, d in zip(p0, p1, p2, p3))
        )
    return pts


def quad(p0, p1, p2, n):
    pts = []
    for i in range(n):
        t = i / n
        u = 1 - t
        pts.append(tuple(u * u * a + 2 * u * t * b + t * t * c for a, b, c in zip(p0, p1, p2)))
    return pts


def body_outline():
    start, *segments = SPEC["body"]
    pts, here = [], tuple(start)
    for c1, c2, end in segments:
        pts += cubic(here, tuple(c1), tuple(c2), tuple(end), 48)
        here = tuple(end)
    return [to_scene(x, y) for x, y in pts]


def inset(pts, d):
    """Moves each point of a counter-clockwise or clockwise closed outline inward by d."""
    n = len(pts)
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    sign = 1 if area > 0 else -1
    out = []
    for i in range(n):
        (ax, ay), (bx, by) = pts[i - 1], pts[(i + 1) % n]
        tx, ty = bx - ax, by - ay
        length = math.hypot(tx, ty) or 1
        nx, ny = -ty / length * sign, tx / length * sign
        out.append((pts[i][0] + nx * d, pts[i][1] + ny * d))
    return out


def ellipse(x, y, w, h, tilt, n=64):
    a = math.radians(-tilt)  # the box's y runs down, so its clockwise is the scene's counter-clockwise
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        ex, ey = w * math.cos(t), h * math.sin(t)
        pts.append((x + ex * math.cos(a) + ey * math.sin(a), y - ex * math.sin(a) + ey * math.cos(a)))
    return pts


def face_parts(face):
    """Each face part as a closed outline in the box."""
    for kind, *v in face:
        if kind == "eye":
            yield ellipse(*v)
        elif kind == "oval":
            x, y, rx, ry = v
            yield ellipse(x, y, rx, ry, 0)
        elif kind == "lid":
            x1, x2, y, depth, thick = v
            m = (x1 + x2) / 2
            inner = y + depth - 2 * thick if depth > 0 else y + depth + 2 * thick
            yield quad((x1, y), (m, y + depth), (x2, y), 32) + quad((x2, y), (m, inner), (x1, y), 32)
        elif kind == "lidded":
            x, y, w, h, x1, y1, x2, y2 = v
            # The eye below the line from (x1, y1) to (x2, y2).
            keep = [p for p in ellipse(x, y, w, h, 0, 128) if (x2 - x1) * (p[1] - y1) - (y2 - y1) * (p[0] - x1) > 0]
            yield keep


def slab(name, outline, flat, edge, z, material, resolution=10):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "2D"
    curve.fill_mode = "BOTH"
    curve.extrude = flat
    curve.bevel_depth = edge
    curve.bevel_resolution = resolution
    curve.resolution_u = 1
    spline = curve.splines.new("POLY")
    spline.points.add(len(outline) - 1)
    for point, (x, y) in zip(spline.points, outline):
        point.co = (x, y, 0, 1)
    spline.use_cyclic_u = True
    spline.use_smooth = True
    obj = bpy.data.objects.new(name, curve)
    obj.location.z = z
    obj.data.materials.append(material)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def hex_rgb(h):
    return tuple(int(h[i : i + 2], 16) / 255 for i in (1, 3, 5))


def linear(c):
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def hls(c, l=None, s=None, dl=0, ds=0):
    h, ll, ss = colorsys.rgb_to_hls(*c)
    ll = l if l is not None else ll
    ss = s if s is not None else ss
    return colorsys.hls_to_rgb(h, min(max(ll + dl, 0), 1), min(max(ss + ds, 0), 1))


def tones(field_hex):
    """The disc's two ends, the glass's tint and the face's ink, from a palette field. Pale fields are taken deeper
    on the disc, so the pale glass stands off them even at 24px."""
    field = hex_rgb(field_hex)
    _, l, s = colorsys.rgb_to_hls(*field)
    mid = hls(field, l=min(l, 0.47), ds=0.08 if s > 0.15 else 0)
    h = colorsys.rgb_to_hls(*mid)[0]
    turn = lambda c, dh: colorsys.hls_to_rgb((colorsys.rgb_to_hls(*c)[0] + dh) % 1, *colorsys.rgb_to_hls(*c)[1:])
    return {
        "light": linear(hls(mid, dl=0.1)),
        "deep": linear(hls(mid, dl=-0.08, ds=0.05)),
        # The blobs in the disc: a lighter neighbour hue at the upper left, a deeper one at the lower right and a
        # pale third at the upper right, for the glass to bend.
        "blobs": [
            linear(hls(turn(mid, 0.03), dl=0.12)),
            linear(hls(turn(mid, -0.025), dl=-0.08, ds=0.05)),
            linear(hls(turn(mid, 0.06), dl=0.1, ds=-0.05)),
        ],
        "glass": linear(hls(field, l=0.95, s=min(s + 0.1, 0.8))),
        "edge": linear(hls(field, l=0.74, s=min(s + 0.25, 1.0))),
        "ink": linear(hls(field, l=0.07, s=min(s + 0.2, 0.9))),
    }


def rgba(c):
    return (*c, 1)


def node(tree, kind, **inputs):
    n = tree.nodes.new(kind)
    for k, v in inputs.items():
        n.inputs[k].default_value = v
    return n


def disc_material():
    mat = bpy.data.materials.new("disc")
    mat.use_nodes = True
    t = mat.node_tree
    t.nodes.clear()
    out = t.nodes.new("ShaderNodeOutputMaterial")
    coord = t.nodes.new("ShaderNodeTexCoord")
    # A diagonal gradient, light at the upper left.
    along = node(t, "ShaderNodeVectorMath")
    along.operation = "DOT_PRODUCT"
    along.inputs[1].default_value = (-0.55, 0.83, 0)
    t.links.new(coord.outputs["Object"], along.inputs[0])
    ramp_in = node(t, "ShaderNodeMapRange", **{"From Min": -1.0, "From Max": 1.0})
    t.links.new(along.outputs["Value"], ramp_in.inputs["Value"])
    ramp = t.nodes.new("ShaderNodeValToRGB")
    ramp.name = "tone"
    t.links.new(ramp_in.outputs["Result"], ramp.inputs["Fac"])
    # A soft mesh of colour: three blobs over the gradient, and faint rings of light about the middle, so the glass
    # has something to magnify and warp.
    under = ramp
    for i, (at, reach, weight) in enumerate((((-0.6, 0.65, 0), 1.0, 0.75), ((0.7, -0.6, 0), 1.0, 0.7), ((0.65, 0.55, 0), 0.7, 0.5))):
        far = node(t, "ShaderNodeVectorMath")
        far.operation = "DISTANCE"
        far.inputs[1].default_value = at
        t.links.new(coord.outputs["Object"], far.inputs[0])
        near = node(t, "ShaderNodeMapRange", **{"From Min": 0.0, "From Max": reach, "To Min": weight, "To Max": 0.0})
        near.interpolation_type = "SMOOTHSTEP"
        t.links.new(far.outputs["Value"], near.inputs["Value"])
        blob = node(t, "ShaderNodeMix")
        blob.data_type = "RGBA"
        blob.name = f"blob{i}"
        t.links.new(near.outputs["Result"], blob.inputs["Factor"])
        t.links.new(under.outputs[2 if under is not ramp else "Color"], blob.inputs[6])
        under = blob
    rings = node(t, "ShaderNodeTexWave", Scale=1.7, Distortion=0.0)
    rings.wave_type = "RINGS"
    rings.rings_direction = "SPHERICAL"
    t.links.new(coord.outputs["Object"], rings.inputs["Vector"])
    silk = node(t, "ShaderNodeMix", Factor=0.035)
    silk.data_type = "RGBA"
    silk.blend_type = "SOFT_LIGHT"
    t.links.new(under.outputs[2], silk.inputs[6])
    t.links.new(rings.outputs["Color"], silk.inputs[7])
    clouds = node(t, "ShaderNodeTexNoise", Scale=2.2, Detail=3.0, Roughness=0.5)
    t.links.new(coord.outputs["Object"], clouds.inputs["Vector"])
    cloud = node(t, "ShaderNodeMix", Factor=0.04)
    cloud.data_type = "RGBA"
    cloud.blend_type = "OVERLAY"
    t.links.new(silk.outputs[2], cloud.inputs[6])
    t.links.new(clouds.outputs["Color"], cloud.inputs[7])
    # Part glow, part lit, so the colour holds and the shadow and the light through the glass still land on it.
    diffuse = node(t, "ShaderNodeBsdfDiffuse")
    glow = node(t, "ShaderNodeEmission", Strength=0.4)
    t.links.new(cloud.outputs[2], diffuse.inputs["Color"])
    t.links.new(cloud.outputs[2], glow.inputs["Color"])
    add = t.nodes.new("ShaderNodeAddShader")
    t.links.new(diffuse.outputs[0], add.inputs[0])
    t.links.new(glow.outputs[0], add.inputs[1])
    t.links.new(add.outputs[0], out.inputs["Surface"])
    return mat


def glass_material():
    """Frosted glass under a clear coat, split into red, green and blue with slightly different indices (dispersion:
    colour fringes where it bends the most), with a share of diffuse transmission (frost) so it lightens what it covers."""
    mat = bpy.data.materials.new("glass")
    mat.use_nodes = True
    t = mat.node_tree
    t.nodes.clear()
    out = t.nodes.new("ShaderNodeOutputMaterial")
    tint = t.nodes.new("ShaderNodeRGB")
    tint.name = "tint"
    # Thin at the edge, thick in the middle: the edge takes a clearer, more saturated tint.
    edge = t.nodes.new("ShaderNodeRGB")
    edge.name = "edge"
    thin = node(t, "ShaderNodeLayerWeight", Blend=0.25)
    tinted = node(t, "ShaderNodeMix")
    tinted.data_type = "RGBA"
    t.links.new(thin.outputs["Facing"], tinted.inputs["Factor"])
    t.links.new(tint.outputs[0], tinted.inputs[6])
    t.links.new(edge.outputs[0], tinted.inputs[7])
    split = t.nodes.new("ShaderNodeSeparateColor")
    t.links.new(tinted.outputs[2], split.inputs[0])
    total = None
    for channel, ior in enumerate((1.46, 1.5, 1.54)):
        colour = t.nodes.new("ShaderNodeCombineColor")
        t.links.new(split.outputs[channel], colour.inputs[channel])
        glass = node(t, "ShaderNodeBsdfGlass", Roughness=0.06, IOR=ior)
        glass.distribution = "MULTI_GGX"
        t.links.new(colour.outputs[0], glass.inputs["Color"])
        if total is None:
            total = glass
        else:
            add = t.nodes.new("ShaderNodeAddShader")
            t.links.new(total.outputs[0], add.inputs[0])
            t.links.new(glass.outputs[0], add.inputs[1])
            total = add
    # Frost lies on the flat face, a share of the light going through it diffusely and a share bouncing straight
    # back (what makes frosted glass read white, not grey). Toward the rounded edge the glass clears, so the edge
    # stays crisp and bends the colour behind it.
    face_on = node(t, "ShaderNodeLayerWeight", Blend=0.3)
    through_frost = node(t, "ShaderNodeMapRange", **{"From Min": 0.0, "From Max": 0.8, "To Min": 0.16, "To Max": 0.0})
    back_frost = node(t, "ShaderNodeMapRange", **{"From Min": 0.0, "From Max": 0.8, "To Min": 0.26, "To Max": 0.0})
    t.links.new(face_on.outputs["Facing"], through_frost.inputs["Value"])
    t.links.new(face_on.outputs["Facing"], back_frost.inputs["Value"])
    frost = t.nodes.new("ShaderNodeBsdfTranslucent")
    t.links.new(tint.outputs[0], frost.inputs["Color"])
    frosted = t.nodes.new("ShaderNodeMixShader")
    t.links.new(through_frost.outputs["Result"], frosted.inputs[0])
    t.links.new(total.outputs[0], frosted.inputs[1])
    t.links.new(frost.outputs[0], frosted.inputs[2])
    milk = t.nodes.new("ShaderNodeBsdfDiffuse")
    t.links.new(tint.outputs[0], milk.inputs["Color"])
    milky = t.nodes.new("ShaderNodeMixShader")
    t.links.new(back_frost.outputs["Result"], milky.inputs[0])
    t.links.new(frosted.outputs[0], milky.inputs[1])
    t.links.new(milk.outputs[0], milky.inputs[2])
    total = milky
    coat = node(t, "ShaderNodeBsdfGlossy", Roughness=0.05)
    fresnel = node(t, "ShaderNodeFresnel", IOR=1.5)
    layer = t.nodes.new("ShaderNodeMixShader")
    t.links.new(fresnel.outputs[0], layer.inputs[0])
    t.links.new(total.outputs[0], layer.inputs[1])
    t.links.new(coat.outputs[0], layer.inputs[2])
    # Light through glass: a shadow ray passes where it meets the glass square on and is held back where it grazes,
    # so the glass casts a dark rim around a bright middle onto the disc, as real glass focuses light.
    path = t.nodes.new("ShaderNodeLightPath")
    facing = node(t, "ShaderNodeLayerWeight", Blend=0.5)
    passes = node(t, "ShaderNodeMath", Value=0.0)
    passes.operation = "POWER"
    passes.inputs[1].default_value = 3.0
    inv = node(t, "ShaderNodeMath")
    inv.operation = "SUBTRACT"
    inv.inputs[0].default_value = 1.0
    t.links.new(facing.outputs["Facing"], inv.inputs[1])
    t.links.new(inv.outputs[0], passes.inputs[0])
    gate = node(t, "ShaderNodeMath")
    gate.operation = "MULTIPLY"
    t.links.new(path.outputs["Is Shadow Ray"], gate.inputs[0])
    t.links.new(passes.outputs[0], gate.inputs[1])
    # More light comes out under the middle than went in there: the glass gathers what its edges turn away (the
    # caustic), so the disc glows under it.
    clear = t.nodes.new("ShaderNodeBsdfTransparent")
    gather = node(t, "ShaderNodeMix", Factor=1.0)
    gather.data_type = "RGBA"
    gather.blend_type = "MULTIPLY"
    gather.inputs[7].default_value = (1.4, 1.4, 1.4, 1)
    t.links.new(tinted.outputs[2], gather.inputs[6])
    t.links.new(gather.outputs[2], clear.inputs["Color"])
    through = t.nodes.new("ShaderNodeMixShader")
    t.links.new(gate.outputs[0], through.inputs[0])
    t.links.new(layer.outputs[0], through.inputs[1])
    t.links.new(clear.outputs[0], through.inputs[2])
    t.links.new(through.outputs[0], out.inputs["Surface"])
    return mat


def ink_material():
    mat = bpy.data.materials.new("ink")
    mat.use_nodes = True
    p = mat.node_tree.nodes["Principled BSDF"]
    p.inputs["Roughness"].default_value = 0.1
    p.inputs["Specular IOR Level"].default_value = 0.3
    p.inputs["Coat Weight"].default_value = 0.7
    p.inputs["Coat Roughness"].default_value = 0.03
    return mat


def area(name, location, size, energy, target=(0, 0, 0), shape="RECTANGLE", size_y=None):
    light = bpy.data.lights.new(name, "AREA")
    light.shape = shape
    light.size = size
    if size_y:
        light.size_y = size_y
    light.energy = energy
    obj = bpy.data.objects.new(name, light)
    obj.location = location
    direction = [t - l for t, l in zip(target, location)]
    obj.rotation_euler = _look(direction)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def rim_ring():
    """A ring of light around the icon at about the slab's height: the rounded edge reflects it as one thin line
    that follows the curve, brightest at the upper left, fainter at the lower right, seen only in reflections."""
    bpy.ops.mesh.primitive_torus_add(major_radius=4.0, minor_radius=0.9, major_segments=192, minor_segments=12, location=(0, 0, 0.9))
    ring = bpy.context.active_object
    ring.name = "rim"
    for flag in ("visible_camera", "visible_diffuse", "visible_transmission", "visible_volume_scatter", "visible_shadow"):
        setattr(ring, flag, False)
    mat = bpy.data.materials.new("rim")
    mat.use_nodes = True
    t = mat.node_tree
    t.nodes.clear()
    out = t.nodes.new("ShaderNodeOutputMaterial")
    coord = t.nodes.new("ShaderNodeTexCoord")
    norm = node(t, "ShaderNodeVectorMath")
    norm.operation = "NORMALIZE"
    t.links.new(coord.outputs["Object"], norm.inputs[0])
    toward = node(t, "ShaderNodeVectorMath")
    toward.operation = "DOT_PRODUCT"
    toward.inputs[1].default_value = (-0.6, 0.8, 0)
    t.links.new(norm.outputs["Vector"], toward.inputs[0])
    curve = node(t, "ShaderNodeMapRange", **{"From Min": -1.0, "From Max": 1.0, "To Min": 0.0, "To Max": 1.0})
    t.links.new(toward.outputs["Value"], curve.inputs["Value"])
    ramp = t.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (0.4, 0.4, 0.4, 1)
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    for at in (0.3, 0.62):
        ramp.color_ramp.elements.new(at).color = (0.004, 0.004, 0.004, 1)
    t.links.new(curve.outputs["Result"], ramp.inputs["Fac"])
    glow = node(t, "ShaderNodeEmission", Strength=16.0)
    t.links.new(ramp.outputs["Color"], glow.inputs["Color"])
    t.links.new(glow.outputs[0], out.inputs["Surface"])
    ring.data.materials.append(mat)


def _look(direction):
    from mathutils import Vector

    return Vector(direction).to_track_quat("-Z", "Y").to_euler()


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 2
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.cycles.max_bounces = 16
    scene.cycles.transmission_bounces = 12
    scene.cycles.glossy_bounces = 8
    scene.cycles.caustics_refractive = True
    scene.cycles.caustics_reflective = True
    scene.cycles.blur_glossy = 0.4
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"

    cam = bpy.data.cameras.new("camera")
    cam.type = "ORTHO"
    cam.ortho_scale = 2.0
    cam_obj = bpy.data.objects.new("camera", cam)
    cam_obj.location = (0, 0, 10)
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj

    world = bpy.data.worlds.new("studio")
    scene.world = world
    world.use_nodes = True
    w = world.node_tree
    bg = w.nodes["Background"]
    coord = w.nodes.new("ShaderNodeTexCoord")
    toward = w.nodes.new("ShaderNodeVectorMath")
    toward.operation = "DOT_PRODUCT"
    toward.inputs[1].default_value = (-0.25, 0.55, 0.8)
    w.links.new(coord.outputs["Generated"], toward.inputs[0])
    span = w.nodes.new("ShaderNodeMapRange")
    span.inputs["From Min"].default_value = -0.3
    span.inputs["From Max"].default_value = 1.0
    w.links.new(toward.outputs["Value"], span.inputs["Value"])
    ramp = w.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.16, 0.16, 0.17, 1)
    ramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    w.links.new(span.outputs["Result"], ramp.inputs["Fac"])
    w.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 1.2

    # The key: soft, from above in front and a little left; it lights the disc and casts the contact shadow, but
    # never shows in the glass, so the glass's only highlights are the rim.
    key = area("key", (-1.5, 3.6, 3.6), 3.0, 120)
    key.visible_glossy = False
    key.visible_transmission = False
    rim_ring()
    # A small bright light that only the ink sees: a wet glint in each eye.
    inks = bpy.data.collections.new("inks")
    glint = bpy.data.lights.new("glint", "POINT")
    glint.shadow_soft_size = 0.12
    glint.energy = 900
    glint_obj = bpy.data.objects.new("glint", glint)
    glint_obj.location = (-2.0, 3.0, 5.5)
    glint_obj.visible_diffuse = False
    scene.collection.objects.link(glint_obj)
    glint_obj.light_linking.receiver_collection = inks
    disc = bpy.data.meshes.new("disc")
    bpy.ops.mesh.primitive_cylinder_add(vertices=256, radius=1.0, depth=0.02, location=(0, 0, -0.01))
    disc_obj = bpy.context.active_object
    disc_obj.name = "disc"
    disc_obj.data.materials.append(disc_material())

    glass = glass_material()
    z = LIFT + EDGE + FLAT
    body = solid(slab("body", inset(body_outline(), EDGE), FLAT, EDGE, z, glass, resolution=12))
    # Even quads all over (a curve's cap is one big face), so the top can swell and be cut cleanly.
    even = body.modifiers.new("even", "REMESH")
    even.mode = "VOXEL"
    even.voxel_size = 0.006
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.modifier_apply(modifier="even")
    for poly in body.data.polygons:
        poly.use_smooth = True
    for v in body.data.vertices:
        if v.co.z > 0:
            v.co.z += dome(v.co.x, v.co.y) * min(v.co.z / (FLAT + EDGE), 1) ** 0.5
    body.hide_render = True
    return {"disc": disc_obj, "blank": body, "glass": glass, "ink": ink_material(), "top": z + FLAT + EDGE}


def solid(curve_obj):
    """A curve slab as a mesh object, so it can be cut."""
    deps = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(curve_obj.evaluated_get(deps))
    # A curve's caps come out unjoined to its sides: weld them into one closed surface, or nothing can cut it.
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(curve_obj.name, mesh)
    obj.location = curve_obj.location
    bpy.context.scene.collection.objects.link(obj)
    bpy.data.objects.remove(curve_obj)
    return obj


def set_colour(parts, field_hex):
    t = tones(field_hex)
    ramp = parts["disc"].data.materials[0].node_tree.nodes["tone"].color_ramp
    ramp.elements[0].color = rgba(t["deep"])
    ramp.elements[1].color = rgba(t["light"])
    nodes = parts["glass"].node_tree.nodes
    nodes["tint"].outputs[0].default_value = rgba(t["glass"])
    nodes["edge"].outputs[0].default_value = rgba(t["edge"])
    disc_nodes = parts["disc"].data.materials[0].node_tree.nodes
    for i, c in enumerate(t["blobs"]):
        disc_nodes[f"blob{i}"].inputs[7].default_value = rgba(c)
    parts["ink"].node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = rgba(t["ink"])


def bowl(name, x, y, w, h, tilt, z, depth, keep_below=None):
    """An ellipsoid with semi-axes w, h (box units) and depth (scene units), centred at height z; with keep_below,
    a line (x1, y1, x2, y2) in the box, only the part below that line."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=64, v_segments=32, radius=1.0)
    bmesh.ops.scale(bm, vec=(w * UNIT * SCALE, h * UNIT * SCALE, depth), verts=bm.verts)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=__import__("mathutils").Matrix.Rotation(math.radians(-tilt), 3, "Z"))
    cx, cy = to_scene(x, y)
    bmesh.ops.translate(bm, vec=(cx, cy, z), verts=bm.verts)
    if keep_below:
        x1, y1, x2, y2 = keep_below
        (ax, ay), (bx, by) = to_scene(x1, y1), to_scene(x2, y2)
        # The plane through the line, upright; its normal points up the picture, toward what's cut away.
        nx, ny = -(by - ay), bx - ax
        if ny < 0:
            nx, ny = -nx, -ny
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        cut = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(ax, ay, z), plane_no=(nx, ny, 0), clear_outer=True)
        edges = [e for e in cut["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        bmesh.ops.holes_fill(bm, edges=edges)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def groove(name, x1, x2, y, depth, thick, z, scale):
    """A tube along a lid's crescent, thickest at the middle and tapering toward the ends."""
    m = (x1 + x2) / 2
    mid = y + depth - thick if depth > 0 else y + depth + thick
    path = quad((x1, y), (m, mid), (x2, y), 40) + [(x2, y)]
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = thick / 2 * UNIT * SCALE * scale
    curve.bevel_resolution = 6
    curve.use_fill_caps = True
    spline = curve.splines.new("POLY")
    spline.points.add(len(path) - 1)
    for i, (point, (px, py)) in enumerate(zip(spline.points, path)):
        t = i / (len(path) - 1)
        point.co = (*to_scene(px, py), z, 1)
        point.radius = max(math.sin(math.pi * t) ** 0.7, 0.3)
    spline.use_smooth = True
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    return solid(obj)


def set_face(parts, being):
    """Carves the face into the glass, as you would cut it: eyes are smooth bowls, shut eyes are tapered round
    grooves, each lined with ink just under its surface, so the face sits in the glass rather than on it."""
    for obj in [o for o in bpy.data.objects if o.name.startswith(("face", "cut", "being"))]:
        bpy.data.objects.remove(obj)
    cutters = bpy.data.collections.get("cutters") or bpy.data.collections.new("cutters")
    body = bpy.data.objects.new("being", parts["blank"].data.copy())
    body.location = parts["blank"].location
    bpy.context.scene.collection.objects.link(body)
    top = parts["top"]
    for i, (kind, *v) in enumerate(being["face"]):
        if kind in ("eye", "oval", "lidded"):
            x, y, w, h = v[:4]
            tilt = v[4] if kind == "eye" else 0
            line = v[4:8] if kind == "lidded" else None
            at = top + dome(*to_scene(x, y))
            cut = bowl(f"cut{i}", x, y, w, h, tilt, at, BOWL, line)
            ink = bowl(f"face{i}", x, y, w * 0.97, h * 0.97, tilt, at - INK_GAP, BOWL, line)
        else:
            x1, x2, y, depth, thick = v
            at = top + dome(*to_scene((x1 + x2) / 2, y))
            cut = groove(f"cut{i}", x1, x2, y, depth, thick, at, 1.0)
            ink = groove(f"face{i}", x1, x2, y, depth, thick, at - INK_GAP, 0.92)
        ink.data.materials.append(parts["ink"])
        bpy.data.collections["inks"].objects.link(ink)
        cut.hide_render = True
        cutters.objects.link(cut)
        bpy.context.scene.collection.objects.unlink(cut)
    carve = body.modifiers.new("face", "BOOLEAN")
    carve.operation = "DIFFERENCE"
    carve.operand_type = "COLLECTION"
    carve.collection = cutters
    carve.solver = "EXACT"
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.modifier_apply(modifier="face")
    for cut in list(cutters.objects):
        bpy.data.objects.remove(cut)
    for poly in body.data.polygons:
        poly.use_smooth = True
    body.data.set_sharp_from_angle(angle=math.radians(40))
    # Each cut's lip is rounded off a little, so it catches the light as a soft sheen, not a drawn line.
    lip = body.modifiers.new("lip", "BEVEL")
    lip.limit_method = "ANGLE"
    lip.angle_limit = math.radians(35)
    lip.width = 0.007
    lip.segments = 4
    lip.harden_normals = False
    for ink in [o for o in bpy.data.objects if o.name.startswith("face")]:
        for poly in ink.data.polygons:
            poly.use_smooth = True


def main():
    jobs = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())["jobs"]
    beings = {b["id"]: b for b in SPEC["beings"]}
    parts = build()
    scene = bpy.context.scene
    for job in jobs:
        set_colour(parts, job["color"]["field"])
        set_face(parts, beings[job["being"]])
        scene.render.resolution_x = scene.render.resolution_y = job["size"]
        scene.cycles.samples = job.get("samples", 128)
        scene.render.filepath = job["out"]
        bpy.ops.render.render(write_still=True)
        print("rendered", job["out"], flush=True)
    bpy.ops.wm.quit_blender()


main()
