"use client"

// Halftone Wordmark Footer — supplied 21st component. React + Canvas 2D only.
import * as React from "react"

export interface HalftonePalette {
  background: string
  ink: string
  warm: string
}
export type HalftonePreset = "night" | "paper" | "ember" | "cobalt"
export interface FooterLink { label: string; href?: string }
export interface FooterColumn { title: string; links: FooterLink[] }
export interface HalftoneWordmarkFooterProps {
  wordmark?: string
  label?: string
  meta?: string
  columns?: FooterColumn[]
  backToTop?: boolean
  preset?: HalftonePreset
  palette?: { background?: string; ink?: string; warm?: string }
  dotGap?: number
  radius?: number
  crop?: number
  grain?: number
  interactive?: boolean
  fontFamily?: string
  fontWeight?: number
  monoFamily?: string
  height?: string
  className?: string
}
const PRESETS: { [K in HalftonePreset]: HalftonePalette } = {
  night: { background: "#0c0c0b", ink: "#e9e4da", warm: "#e9762b" },
  paper: { background: "#efebe3", ink: "#17150f", warm: "#c2361c" },
  ember: { background: "#160a06", ink: "#f2c48c", warm: "#ff5a1f" },
  cobalt: { background: "#0d1b4d", ink: "#dfe7ff", warm: "#ffcd3c" },
}
const DEFAULT_COLUMNS: FooterColumn[] = [
  { title: "Explore", links: [{ label: "Market", href: "/market" }, { label: "Home", href: "/" }] },
  { title: "Wallet", links: [{ label: "Local wallet", href: "http://127.0.0.1:4101/" }] },
  { title: "Learn", links: [{ label: "RGB Protocol", href: "https://docs.rgb.info/" }, { label: "QVAC", href: "https://docs.qvac.tether.io/quickstart/" }] },
]
const SANS_STACK = '"Inter Tight", "Inter Variable", "Inter", "Helvetica Neue", Arial, system-ui, sans-serif'
const MONO_STACK = '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace'

/** Hex to RGB in 0–255, or null for unsupported syntax. */
export function hwfHex(hex: string) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || "").trim())
  if (!m) return null
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
export function hwfRadius(coverage: number, gap: number) {
  const c = coverage < 0 ? 0 : coverage > 1 ? 1 : coverage
  return Math.sqrt(c) * gap * 0.56
}
export function hwfStep(x: number, y: number, vx: number, vy: number, hx: number, hy: number, px: number, py: number, r: number) {
  const dx = x - px
  const dy = y - py
  const d2 = dx * dx + dy * dy
  if (r > 0 && d2 < r * r) {
    const d = Math.sqrt(d2) + 0.001
    const f = (1 - d / r) * 2.6
    vx += (dx / d) * f
    vy += (dy / d) * f
  }
  vx = (vx + (hx - x) * 0.05) * 0.84
  vy = (vy + (hy - y) * 0.05) * 0.84
  return [x + vx, y + vy, vx, vy]
}
export function hwfWarmth(x: number, y: number, hx: number, hy: number, span: number) {
  const d = Math.hypot(x - hx, y - hy)
  return span > 0 ? Math.min(1, d / span) : 0
}
export function hwfFitSize(measured: number, width: number) {
  return measured > 0 ? (width / measured) * 100 : 0
}

const HWF_CSS = `
.hwf-root {
  position: relative; width: 100%; overflow: hidden; isolation: isolate;
  min-height: var(--hwf-height); padding-bottom: clamp(150px, 32vw, 700px);
  background: var(--hwf-bg); color: var(--hwf-ink); -webkit-font-smoothing: antialiased;
}
.hwf-root canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; max-width: none; z-index: 0; }
.hwf-fallback { position: absolute; z-index: 0; left: 0; right: 0; bottom: -0.12em; display: block;
  color: var(--hwf-ink); font: 800 clamp(90px, 20vw, 350px) var(--hwf-face); letter-spacing: -.09em;
  line-height: .8; text-align: center; white-space: nowrap; pointer-events: none; overflow: hidden; }
.hwf-root[data-canvas-ready='true'] .hwf-fallback { display: none; }
.hwf-top {
  position: relative; z-index: 1; display: grid; grid-template-columns: minmax(0, 1.25fr) repeat(3, minmax(0, 1fr));
  gap: 24px; padding: clamp(22px, 3.4vw, 40px) clamp(20px, 3.4vw, 44px) 0;
  font-family: var(--hwf-mono); font-size: 10.5px; letter-spacing: .18em; text-transform: uppercase; line-height: 1.75;
}
.hwf-brand strong { display: block; font-weight: 500; }
.hwf-brand span { opacity: .72; }
.hwf-col h3 { margin: 0; font: inherit; opacity: .68; font-weight: 500; }
.hwf-col ul { list-style: none; margin: 0; padding: 0; }
.hwf-col a, .hwf-up {
  display: inline-flex; align-items: center; min-height: 28px;
  color: inherit; text-decoration: none; opacity: .78; background: none; border: 0; padding: 0;
  font: inherit; letter-spacing: inherit; text-transform: inherit; cursor: pointer;
  background-image: linear-gradient(currentColor, currentColor); background-size: 0% 1px;
  background-repeat: no-repeat; background-position: 0 100%; transition: opacity .25s ease, background-size .35s cubic-bezier(.2,.7,.1,1);
}
.hwf-col a:hover, .hwf-up:hover { opacity: 1; background-size: 100% 1px; }
.hwf-col a:focus-visible, .hwf-up:focus-visible { outline: 1px solid currentColor; outline-offset: 3px; opacity: 1; }
.hwf-rule {
  position: relative; z-index: 1; display: flex; justify-content: flex-end; align-items: center; gap: 16px;
  margin: clamp(18px, 2.6vw, 30px) clamp(20px, 3.4vw, 44px) 0; padding-top: 12px;
  border-top: 0.5px solid color-mix(in srgb, var(--hwf-ink) 16%, transparent);
  font-family: var(--hwf-mono); font-size: 10.5px; letter-spacing: .18em; text-transform: uppercase;
}
.hwf-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 720px) {
  .hwf-root { padding-bottom: clamp(120px, 34vw, 180px); }
  .hwf-top { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); row-gap: 24px; }
  .hwf-brand { grid-column: 1 / -1; }
  .hwf-fallback { font-size: clamp(85px, 27vw, 190px); }
}
@media (prefers-reduced-motion: reduce) {
  .hwf-col a, .hwf-up { transition: none; }
}
`

export default function HalftoneWordmarkFooter({
  wordmark = "palka", label = "palka P2P Exchange", meta = "Regtest demo · Matching only · No BTC/RGB settlement",
  columns = DEFAULT_COLUMNS, backToTop = true, preset = "night", palette,
  dotGap = 6, radius = 80, crop = 0.2, grain = 0.5, interactive = true,
  fontFamily = SANS_STACK, fontWeight = 800, monoFamily = MONO_STACK, height = "560px", className = "",
}: HalftoneWordmarkFooterProps) {
  const colors = { ...(PRESETS[preset] || PRESETS.night), ...(palette || {}) }
  const rootRef = React.useRef(null as HTMLElement | null)
  const canvasRef = React.useRef(null as HTMLCanvasElement | null)
  const opts = React.useRef({ colors, dotGap, radius, crop, grain, interactive, fontFamily, fontWeight, wordmark })
  opts.current = { colors, dotGap, radius, crop, grain, interactive, fontFamily, fontWeight, wordmark }
  const key = [wordmark, dotGap, crop, grain, fontFamily, fontWeight, colors.background, colors.ink, colors.warm].join("|")

  React.useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    if (!root || !canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    let reduced = motionQuery.matches
    let w = 0
    let h = 0
    let dpr = 1
    let px = -1e5
    let py = -1e5
    let raf = 0
    let visible = !document.hidden
    let inView = true
    let awake = true
    let ring = { x: 0, y: 0, t: -1 }
    // Flat arrays: x, y, vx, vy, hx, hy, r per dot.
    let dots = new Float32Array(0)
    let count = 0
    let grainTile = null as HTMLCanvasElement | null
    const ink = hwfHex(opts.current.colors.ink) || [233, 228, 218]
    const warm = hwfHex(opts.current.colors.warm) || [233, 118, 43]

    const layout = () => {
      const o = opts.current
      const rect = root.getBoundingClientRect()
      w = Math.max(1, Math.round(rect.width))
      h = Math.max(1, Math.round(rect.height))
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      const mask = document.createElement("canvas")
      mask.width = w
      mask.height = h
      const m = mask.getContext("2d", { willReadFrequently: true })
      if (!m) return
      const face = o.fontWeight + " 100px " + o.fontFamily
      m.font = face
      const word = o.wordmark || " "
      const fit = hwfFitSize(m.measureText(word).width, w * 1.02)
      m.font = o.fontWeight + " " + fit + "px " + o.fontFamily
      const box = m.measureText(word)
      const cap = box.actualBoundingBoxAscent || fit * 0.72
      const c = Math.max(0, Math.min(0.6, o.crop))
      m.fillStyle = "#000"
      m.textBaseline = "alphabetic"
      m.fillText(word, (w - box.width) / 2, h + cap * c)
      const img = m.getImageData(0, 0, w, h).data
      const gap = Math.max(3, o.dotGap)
      const cols = Math.ceil(w / gap)
      const rows = Math.ceil(h / gap)
      const tmp = []
      for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          let sum = 0
          for (let sy = 0; sy < 3; sy++) {
            for (let sx = 0; sx < 3; sx++) {
              const x = Math.min(w - 1, Math.floor(gx * gap + ((sx + 0.5) * gap) / 3))
              const y = Math.min(h - 1, Math.floor(gy * gap + ((sy + 0.5) * gap) / 3))
              sum += img[(y * w + x) * 4 + 3]
            }
          }
          const cov = sum / (9 * 255)
          if (cov < 0.06) continue
          const hx = gx * gap + gap / 2
          const hy = gy * gap + gap / 2
          tmp.push(hx, hy, 0, 0, hx, hy, hwfRadius(cov, gap))
        }
      }
      dots = new Float32Array(tmp)
      count = tmp.length / 7
      grainTile = document.createElement("canvas")
      grainTile.width = 256
      grainTile.height = 256
      const g = grainTile.getContext("2d")
      if (g) {
        const id = g.createImageData(256, 256)
        for (let i = 0; i < id.data.length; i += 4) {
          const v = Math.random() * 255
          id.data[i] = id.data[i + 1] = id.data[i + 2] = v
          id.data[i + 3] = Math.random() < 0.5 ? 0 : 255
        }
        g.putImageData(id, 0, 0)
      }
      awake = true
    }
    const draw = (now: number) => {
      const o = opts.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = o.colors.background
      ctx.fillRect(0, 0, w, h)
      const r = o.interactive && !reduced ? Math.max(0, o.radius) : 0
      const ringAge = ring.t < 0 ? 1e9 : now - ring.t
      const ringR = ringAge * 0.9
      let moving = false
      for (let i = 0; i < count; i++) {
        const j = i * 7
        let x = dots[j]
        let y = dots[j + 1]
        let vx = dots[j + 2]
        let vy = dots[j + 3]
        const hx = dots[j + 4]
        const hy = dots[j + 5]
        if (!reduced) {
          if (ringAge < 900) {
            const dx = hx - ring.x
            const dy = hy - ring.y
            const d = Math.sqrt(dx * dx + dy * dy) + 0.001
            const band = 1 - Math.min(1, Math.abs(d - ringR) / 26)
            if (band > 0) {
              const f = band * 3.2 * (1 - ringAge / 900)
              vx += (dx / d) * f
              vy += (dy / d) * f
            }
          }
          const s = hwfStep(x, y, vx, vy, hx, hy, px, py, r)
          x = s[0]; y = s[1]; vx = s[2]; vy = s[3]
          if (Math.abs(vx) + Math.abs(vy) > 0.02 || Math.abs(x - hx) + Math.abs(y - hy) > 0.05) moving = true
          else { x = hx; y = hy; vx = 0; vy = 0 }
          dots[j] = x; dots[j + 1] = y; dots[j + 2] = vx; dots[j + 3] = vy
        }
        const k = hwfWarmth(x, y, hx, hy, 28)
        ctx.fillStyle = k > 0.02
          ? "rgb(" + Math.round(ink[0] + (warm[0] - ink[0]) * k) + "," + Math.round(ink[1] + (warm[1] - ink[1]) * k) + "," + Math.round(ink[2] + (warm[2] - ink[2]) * k) + ")"
          : o.colors.ink
        ctx.beginPath()
        ctx.arc(x, y, dots[j + 6], 0, 6.2832)
        ctx.fill()
      }
      if (grainTile && o.grain > 0) {
        ctx.globalAlpha = Math.min(1, o.grain) * 0.09
        ctx.globalCompositeOperation = "overlay"
        const pattern = ctx.createPattern(grainTile, "repeat")
        if (pattern) { ctx.fillStyle = pattern; ctx.fillRect(0, 0, w, h) }
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = "source-over"
      }
      awake = !reduced && (moving || ringAge < 900 || px > -1e4)
    }
    const loop = (now: number) => {
      raf = 0
      if (!visible || document.hidden) return
      draw(now)
      root.dataset.canvasReady = "true"
      if (awake) raf = requestAnimationFrame(loop)
    }
    const wake = () => {
      awake = true
      if (!raf && visible) raf = requestAnimationFrame(loop)
    }
    const toLocal = (e: PointerEvent) => {
      const b = canvas.getBoundingClientRect()
      return [e.clientX - b.left, e.clientY - b.top]
    }
    const onMove = (e: PointerEvent) => {
      if (!opts.current.interactive || reduced) return
      const p = toLocal(e)
      px = p[0]; py = p[1]
      wake()
    }
    const onLeave = () => { if (reduced) return; px = -1e5; py = -1e5; wake() }
    const onDown = (e: PointerEvent) => {
      if (!opts.current.interactive || reduced) return
      if ((e.target as HTMLElement).closest("a,button")) return
      const p = toLocal(e)
      ring = { x: p[0], y: p[1], t: performance.now() }
      wake()
    }
    const onMotionChange = (event: MediaQueryListEvent) => {
      reduced = event.matches
      if (reduced) {
        px = py = -1e5
        ring = { x: 0, y: 0, t: -1 }
        for (let i = 0; i < count; i++) {
          const j = i * 7
          dots[j] = dots[j + 4]; dots[j + 1] = dots[j + 5]
          dots[j + 2] = dots[j + 3] = 0
        }
        cancelAnimationFrame(raf)
        raf = 0
        awake = false
        if (visible) draw(performance.now())
      } else wake()
    }
    layout()
    draw(performance.now())
    root.dataset.canvasReady = "true"
    if (!reduced) wake()
    root.addEventListener("pointermove", onMove)
    root.addEventListener("pointerleave", onLeave)
    root.addEventListener("pointerdown", onDown)
    motionQuery.addEventListener("change", onMotionChange)
    const ro = new ResizeObserver(() => { layout(); wake() })
    ro.observe(root)
    const io = new IntersectionObserver((entries) => {
      inView = entries[0] ? entries[0].isIntersecting : true
      visible = inView && !document.hidden
      if (visible) wake()
    })
    io.observe(root)
    const onVisibility = () => { visible = inView && !document.hidden; if (visible) wake() }
    document.addEventListener("visibilitychange", onVisibility)
    let alive = true
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { if (!alive) return; layout(); wake() })
    }
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      delete root.dataset.canvasReady
      root.removeEventListener("pointermove", onMove)
      root.removeEventListener("pointerleave", onLeave)
      root.removeEventListener("pointerdown", onDown)
      motionQuery.removeEventListener("change", onMotionChange)
    }
  }, [key])

  const toTop = () => { window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }) }
  return (
    <footer ref={rootRef} className={"hwf-root " + className} style={{ "--hwf-height": height, "--hwf-bg": colors.background, "--hwf-ink": colors.ink, "--hwf-mono": monoFamily, "--hwf-face": fontFamily } as React.CSSProperties}>
      <style>{HWF_CSS}</style>
      <canvas ref={canvasRef} aria-hidden="true" />
      <span className="hwf-fallback" aria-hidden="true">{wordmark}</span>
      <span className="hwf-sr">{wordmark}</span>
      <div className="hwf-top">
        <div className="hwf-brand"><strong>{label}</strong><span>{meta}</span></div>
        {columns.map((col) => (
          <nav className="hwf-col" key={col.title} aria-label={col.title}>
            <h3>{col.title}</h3>
            <ul>{col.links.filter((l) => l.href).map((l) => <li key={l.label}><a href={l.href} target={l.href?.startsWith("http") ? "_blank" : undefined} rel={l.href?.startsWith("http") ? "noopener noreferrer" : undefined}>{l.label}</a></li>)}</ul>
          </nav>
        ))}
      </div>
      <div className="hwf-rule">{backToTop ? <button type="button" className="hwf-up" onClick={toTop}>Back to top ↑</button> : null}</div>
    </footer>
  )
}
