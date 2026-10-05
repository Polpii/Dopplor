// Shaders GLSL ES 3.00 du rendu néon.

/**
 * Segments lumineux instanciés : chaque instance est un quad orienté le long du segment,
 * le fragment shader calcule la distance au segment (SDF) → bords lissés et bouts ronds.
 * Un point est un segment de longueur nulle.
 */
export const SEGMENT_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;   // coin du quad : (±1, ±1)
layout(location = 1) in vec4 aEnds;     // a.xy, b.xy (px CSS)
layout(location = 2) in vec4 aColor;    // rgb, intensité
layout(location = 3) in float aWidth;   // épaisseur du trait (px CSS)

uniform vec2 uResolution;  // taille du canvas (px CSS)
uniform float uScale;      // devicePixelRatio

out vec2 vLocal;       // position relative au segment (px écran) : x le long, y en travers
out float vHalfLen;
out float vHalfWidth;
out vec4 vColor;

// Le quad déborde du trait pour laisser la place au petit halo local.
const float EXTENT = 2.5;

void main() {
  vec2 a = aEnds.xy * uScale;
  vec2 b = aEnds.zw * uScale;
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = max(aWidth * uScale * 0.5, 0.5);
  float pad = hw * EXTENT + 1.5;

  vec2 local = vec2(aCorner.x * (len * 0.5 + pad), aCorner.y * pad);
  vec2 pos = (a + b) * 0.5 + dir * local.x + nrm * local.y;

  vLocal = local;
  vHalfLen = len * 0.5;
  vHalfWidth = hw;
  vColor = aColor;

  vec2 clip = pos / (uResolution * uScale) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

export const SEGMENT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in float vHalfLen;
in float vHalfWidth;
in vec4 vColor;
out vec4 outColor;

void main() {
  // Distance au segment [−halfLen, +halfLen] × {0}.
  float d = length(vec2(max(abs(vLocal.x) - vHalfLen, 0.0), vLocal.y));
  float hw = vHalfWidth;
  float body = 1.0 - smoothstep(hw - 0.75, hw + 0.75, d);   // trait, bord anti-aliasé
  float hot = exp(-(d * d) / (hw * hw * 0.15));              // cœur brûlant (vire au blanc)
  float halo = exp(-(d * d) / (hw * hw * 2.0)) * 0.35;       // halo serré (le bloom fait le reste)
  vec3 c = vColor.rgb * (body + halo) + vec3(hot * 0.5);
  outColor = vec4(c * vColor.a, 1.0);  // blending additif : la lumière s'accumule
}`;

/** Triangle plein écran (pas de buffer : généré depuis gl_VertexID). */
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/** Downsample 13 taps (Jimenez, « Next Generation Post Processing in Call of Duty », 2014). */
export const DOWNSAMPLE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;  // taille d'un texel de la source
in vec2 vUv;
out vec4 outColor;

vec3 s(float x, float y) { return texture(uSrc, vUv + vec2(x, y) * uTexel).rgb; }

void main() {
  vec3 col = s(0.0, 0.0) * 0.125;
  col += (s(-2.0, 2.0) + s(2.0, 2.0) + s(-2.0, -2.0) + s(2.0, -2.0)) * 0.03125;
  col += (s(0.0, 2.0) + s(-2.0, 0.0) + s(2.0, 0.0) + s(0.0, -2.0)) * 0.0625;
  col += (s(-1.0, 1.0) + s(1.0, 1.0) + s(-1.0, -1.0) + s(1.0, -1.0)) * 0.125;
  outColor = vec4(col, 1.0);
}`;

/** Upsample « tent » 3×3, additionné au niveau supérieur. */
export const UPSAMPLE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 outColor;

vec3 s(float x, float y) { return texture(uSrc, vUv + vec2(x, y) * uTexel).rgb; }

void main() {
  vec3 col = s(0.0, 0.0) * 4.0;
  col += (s(-1.0, 0.0) + s(1.0, 0.0) + s(0.0, -1.0) + s(0.0, 1.0)) * 2.0;
  col += s(-1.0, -1.0) + s(1.0, -1.0) + s(-1.0, 1.0) + s(1.0, 1.0);
  outColor = vec4(col / 16.0, 1.0);
}`;

/** Scène + bloom → tone mapping exponentiel (les zones intenses virent au blanc, comme un néon). */
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uExposure;
in vec2 vUv;
out vec4 outColor;

const float BLACK_FLOOR = 0.012;

// Bruit de tramage : évite les bandes de couleur dans les dégradés du bloom.
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 hdr = texture(uScene, vUv).rgb + texture(uBloom, vUv).rgb * uBloomStrength;
  vec3 col = 1.0 - exp(-hdr * uExposure);
  // Plancher : la traîne la plus diffuse du bloom est coupée pour que le noir reste
  // parfaitement noir (sur un miroir sans tain, le moindre gris se voit).
  col = max(col - BLACK_FLOOR, 0.0) / (1.0 - BLACK_FLOOR);
  if (max(col.r, max(col.g, col.b)) > 0.0) col = max(col + (hash(gl_FragCoord.xy) - 0.5) / 255.0, 0.0);
  // Alpha = luminosité : par-dessus le flux caméra, la lumière s'ajoute (sortie prémultipliée).
  float a = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
  outColor = vec4(min(col, vec3(a)), a);
}`;
