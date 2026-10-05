import type { Scene } from "../scene";
import { FigureBuilder } from "./figures";
import { SEGMENT_FLOATS, SegmentBuffer } from "./segments";
import { COMPOSITE_FS, DOWNSAMPLE_FS, FULLSCREEN_VS, SEGMENT_FS, SEGMENT_VS, UPSAMPLE_FS } from "./shaders";

const MAX_BLOOM_LEVELS = 7;
const BLOOM_STRENGTH = 2.6;
const EXPOSURE = 1.6;
const MAX_DPR = 2;

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
}

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

/**
 * Rendu néon WebGL2 : segments SDF instanciés dans une cible HDR, bloom à mip-chain
 * (downsample 13 taps + upsample tent), puis tone mapping vers l'écran.
 */
export class NeonRenderer {
  private gl: WebGL2RenderingContext;
  private segments = new SegmentBuffer();
  private figures = new FigureBuilder();
  private lost = false;

  private segmentProgram!: Program;
  private downProgram!: Program;
  private upProgram!: Program;
  private compositeProgram!: Program;
  private segmentVao!: WebGLVertexArrayObject;
  private instanceBuffer!: WebGLBuffer;
  private emptyVao!: WebGLVertexArrayObject;
  private hdr = false;

  private scene: Target | null = null;
  private mips: Target[] = [];
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false, // l'anti-aliasing est fait dans le shader (SDF)
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 indisponible dans ce navigateur");
    this.gl = gl;
    this.init();

    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.init();
      this.lost = false;
    });
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  render(scene: Scene, now: number, videoWidth: number, videoHeight: number): void {
    if (this.lost || !this.scene) return;
    const { gl } = this;

    // Même cadrage que la vidéo en `object-fit: cover`, inversée comme un reflet.
    this.segments.clear();
    if (videoWidth && videoHeight) {
      const scale = Math.max(this.cssWidth / videoWidth, this.cssHeight / videoHeight);
      const dw = videoWidth * scale;
      const dh = videoHeight * scale;
      const view = { sx: -dw, tx: (this.cssWidth - dw) / 2 + dw, sy: dh, ty: (this.cssHeight - dh) / 2 };
      this.figures.build(scene, now, view, this.segments);
    }

    // 1. Segments → cible HDR, en blending additif.
    this.bindTarget(this.scene);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.segments.count > 0) {
      const p = this.use(this.segmentProgram);
      gl.uniform2f(p.uniforms.uResolution, this.cssWidth, this.cssHeight);
      gl.uniform1f(p.uniforms.uScale, this.dpr);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(this.segmentVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.segments.data.subarray(0, this.segments.count * SEGMENT_FLOATS), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.segments.count);
      gl.disable(gl.BLEND);
    }

    // 2. Bloom : descente de la chaîne de mips…
    gl.bindVertexArray(this.emptyVao);
    const down = this.use(this.downProgram);
    let src = this.scene;
    for (const mip of this.mips) {
      this.bindTarget(mip);
      gl.uniform2f(down.uniforms.uTexel, 1 / src.width, 1 / src.height);
      this.bindTexture(0, src.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      src = mip;
    }
    // … puis remontée, chaque niveau flouté s'additionnant au niveau supérieur.
    const up = this.use(this.upProgram);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.mips.length - 1; i > 0; i--) {
      this.bindTarget(this.mips[i - 1]);
      gl.uniform2f(up.uniforms.uTexel, 1 / this.mips[i].width, 1 / this.mips[i].height);
      this.bindTexture(0, this.mips[i].tex);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);

    // 3. Composition + tone mapping vers l'écran.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const comp = this.use(this.compositeProgram);
    gl.uniform1i(comp.uniforms.uScene, 0);
    gl.uniform1i(comp.uniforms.uBloom, 1);
    gl.uniform1f(comp.uniforms.uBloomStrength, BLOOM_STRENGTH / Math.max(1, this.mips.length));
    gl.uniform1f(comp.uniforms.uExposure, EXPOSURE);
    this.bindTexture(0, this.scene.tex);
    this.bindTexture(1, this.mips.length ? this.mips[0].tex : this.scene.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // --- Initialisation des ressources GPU ---------------------------------------------

  private init(): void {
    const { gl } = this;
    // Cibles flottantes (HDR) si le GPU sait y dessiner, sinon 8 bits.
    this.hdr = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));

    this.segmentProgram = this.program(SEGMENT_VS, SEGMENT_FS, ["uResolution", "uScale"]);
    this.downProgram = this.program(FULLSCREEN_VS, DOWNSAMPLE_FS, ["uSrc", "uTexel"]);
    this.upProgram = this.program(FULLSCREEN_VS, UPSAMPLE_FS, ["uSrc", "uTexel"]);
    this.compositeProgram = this.program(FULLSCREEN_VS, COMPOSITE_FS, ["uScene", "uBloom", "uBloomStrength", "uExposure"]);

    this.segmentVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.segmentVao);
    const corners = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const stride = SEGMENT_FLOATS * 4;
    const attr = (loc: number, size: number, offset: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 4, 0); // ax, ay, bx, by
    attr(2, 4, 16); // r, g, b, intensité
    attr(3, 1, 32); // épaisseur
    gl.bindVertexArray(null);

    this.emptyVao = gl.createVertexArray()!;
    this.scene = null;
    this.mips = [];
    this.resize();
  }

  private resize(): void {
    if (this.lost) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    this.cssWidth = this.canvas.clientWidth;
    this.cssHeight = this.canvas.clientHeight;
    const width = Math.max(1, Math.round(this.cssWidth * this.dpr));
    const height = Math.max(1, Math.round(this.cssHeight * this.dpr));
    this.canvas.width = width;
    this.canvas.height = height;

    for (const t of [this.scene, ...this.mips]) if (t) this.deleteTarget(t);
    this.scene = this.target(width, height);
    this.mips = [];
    let w = width >> 1;
    let h = height >> 1;
    while (this.mips.length < MAX_BLOOM_LEVELS && w >= 2 && h >= 2) {
      this.mips.push(this.target(w, h));
      w >>= 1;
      h >>= 1;
    }
  }

  private target(width: number, height: number): Target {
    const { gl } = this;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (this.hdr && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      // Cible flottante refusée par le pilote : on repasse tout en 8 bits.
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      this.hdr = false;
      return this.target(width, height);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, width, height };
  }

  private deleteTarget(t: Target): void {
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  private program(vsSource: string, fsSource: string, uniforms: string[]): Program {
    const { gl } = this;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`Shader : ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Programme : ${gl.getProgramInfoLog(program)}`);
    return { program, uniforms: Object.fromEntries(uniforms.map((u) => [u, gl.getUniformLocation(program, u)])) };
  }

  private use(p: Program): Program {
    this.gl.useProgram(p.program);
    return p;
  }

  private bindTarget(t: Target): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, t.fbo);
    this.gl.viewport(0, 0, t.width, t.height);
  }

  private bindTexture(unit: number, tex: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
  }
}
