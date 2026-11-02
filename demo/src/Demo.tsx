import React from "react";
import {
	AbsoluteFill,
	Easing,
	Img,
	Sequence,
	interpolate,
	spring,
	staticFile,
	useCurrentFrame,
	useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import data from "../public/shots.json";

const { fontFamily } = loadFont("normal", { weights: ["400", "500", "600", "700", "800"], subsets: ["latin"] });
const { fontFamily: monoFamily } = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] });

// ---------------------------------------------------------------- data

interface Pt {
	x: number;
	y: number;
}
interface Cam {
	s: number;
	x: number;
	y: number;
}
interface Shot {
	src: string;
	dur: number;
	keys: string[] | null;
	click: boolean;
	move: boolean;
	cursor: Pt | null;
	caret: { x: number; y: number; h: number } | null;
	caption: string | null;
	scene: string;
	cam: Cam;
}

const shots = data.shots as Shot[];
const SRC_W = data.width; // CSS px of the captured Obsidian window
const SRC_H = data.height;
const starts: number[] = [];
let acc = 0;
for (const s of shots) {
	starts.push(acc);
	acc += s.dur;
}
const FOOTAGE = acc;

const INTRO = 84;
const OVERLAP = 18; // footage window slides in while the title fades
const MD = 210;
const OUTRO = 120;
const FOOT_START = INTRO - OVERLAP;
const MD_START = FOOT_START + FOOTAGE;
const OUTRO_START = MD_START + MD;
export const totalFrames = OUTRO_START + OUTRO;

// on-screen window geometry
const WIN_W = 1600;
const WIN_H = (WIN_W * SRC_H) / SRC_W;
const WIN_X = (1920 - WIN_W) / 2;
const WIN_Y = 44;
const K = WIN_W / SRC_W;

const ACCENT = "#8b6cff";
const ACCENT2 = "#c0a8ff";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = Easing.bezier(0.45, 0, 0.2, 1);

function shotAt(t: number): number {
	let lo = 0;
	let hi = shots.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= t) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

const sameCam = (a: Cam, b: Cam) => a.s === b.s && a.x === b.x && a.y === b.y;

// ---------------------------------------------------------------- background & brand

const Background: React.FC = () => {
	const f = useCurrentFrame();
	const drift = Math.sin(f / 90) * 40;
	return (
		<AbsoluteFill
			style={{
				background: `radial-gradient(1200px 700px at ${30 + drift / 20}% ${-10}%, rgba(139,108,255,0.30), transparent 60%),
					radial-gradient(900px 600px at ${85 - drift / 25}% 110%, rgba(80,160,255,0.16), transparent 60%),
					linear-gradient(180deg, #0d0c14 0%, #0a0a10 100%)`,
			}}
		/>
	);
};

const Logo: React.FC<{ size: number }> = ({ size }) => (
	<svg width={size} height={size} viewBox="0 0 100 100">
		<defs>
			<linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stopColor="#7b5cff" />
				<stop offset="1" stopColor="#b896ff" />
			</linearGradient>
		</defs>
		<rect x="2" y="2" width="96" height="96" rx="24" fill="url(#lg)" />
		<circle cx="27" cy="30" r="6" fill="#fff" />
		<rect x="40" y="26.5" width="38" height="7" rx="3.5" fill="#fff" opacity="0.95" />
		<line x1="27" y1="40" x2="27" y2="68" stroke="#fff" strokeOpacity="0.45" strokeWidth="2.5" />
		<circle cx="42" cy="51" r="5" fill="#fff" opacity="0.9" />
		<rect x="53" y="48" width="26" height="6" rx="3" fill="#fff" opacity="0.8" />
		<circle cx="42" cy="70" r="5" fill="#fff" opacity="0.9" />
		<rect x="53" y="67" width="20" height="6" rx="3" fill="#fff" opacity="0.8" />
	</svg>
);

// ---------------------------------------------------------------- intro / outro

const Intro: React.FC = () => {
	const f = useCurrentFrame();
	const { fps } = useVideoConfig();
	const a = spring({ frame: f, fps, config: { damping: 200 }, durationInFrames: 26 });
	const b = spring({ frame: f - 10, fps, config: { damping: 200 }, durationInFrames: 26 });
	const out = interpolate(f, [INTRO - OVERLAP - 6, INTRO], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
	return (
		<AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: out, fontFamily }}>
			<div style={{ transform: `translateY(${(1 - a) * 24}px) scale(${0.94 + 0.06 * a})`, opacity: a }}>
				<Logo size={132} />
			</div>
			<div
				style={{
					marginTop: 34,
					fontSize: 108,
					fontWeight: 800,
					letterSpacing: -3,
					color: "white",
					opacity: a,
					transform: `translateY(${(1 - a) * 30}px)`,
				}}
			>
				Flow Outliner
			</div>
			<div
				style={{
					marginTop: 14,
					fontSize: 38,
					fontWeight: 500,
					color: "rgba(255,255,255,0.62)",
					opacity: b,
					transform: `translateY(${(1 - b) * 20}px)`,
				}}
			>
				Workflowy-style outlining, inside Obsidian
			</div>
		</AbsoluteFill>
	);
};

const Outro: React.FC = () => {
	const f = useCurrentFrame();
	const { fps } = useVideoConfig();
	const a = spring({ frame: f, fps, config: { damping: 200 }, durationInFrames: 28 });
	const b = spring({ frame: f - 12, fps, config: { damping: 200 }, durationInFrames: 28 });
	const bullets = ["Zoom into any bullet", "Keyboard-first", "Plain Markdown"];
	return (
		<AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontFamily }}>
			<div style={{ display: "flex", alignItems: "center", gap: 30, opacity: a, transform: `scale(${0.95 + 0.05 * a})` }}>
				<Logo size={104} />
				<div style={{ fontSize: 92, fontWeight: 800, color: "white", letterSpacing: -2.5 }}>Flow Outliner</div>
			</div>
			<div style={{ display: "flex", gap: 18, marginTop: 40, opacity: b, transform: `translateY(${(1 - b) * 16}px)` }}>
				{bullets.map((t) => (
					<div
						key={t}
						style={{
							padding: "12px 24px",
							borderRadius: 999,
							border: "1px solid rgba(255,255,255,0.14)",
							background: "rgba(255,255,255,0.05)",
							color: "rgba(255,255,255,0.8)",
							fontSize: 28,
							fontWeight: 500,
						}}
					>
						{t}
					</div>
				))}
			</div>
			<div
				style={{
					marginTop: 54,
					fontFamily: monoFamily,
					fontSize: 30,
					color: ACCENT2,
					opacity: b,
				}}
			>
				github.com/NgrimaldiN/workflowy-in-obsidian
			</div>
		</AbsoluteFill>
	);
};

// ---------------------------------------------------------------- footage overlays

const Cursor: React.FC<{ pressed: number }> = ({ pressed }) => (
	<svg width={26} height={34} viewBox="0 0 26 34" style={{ transform: `scale(${1 - 0.14 * pressed})`, transformOrigin: "2px 2px" }}>
		<path
			d="M2 2 L2 27 L8.5 21 L13 31.5 L17.5 29.5 L13 19.5 L22 19.5 Z"
			fill="#111"
			stroke="white"
			strokeWidth="2"
			strokeLinejoin="round"
		/>
	</svg>
);

const Keycaps: React.FC<{ keys: string[]; p: number }> = ({ keys, p }) => (
	<div style={{ display: "flex", gap: 10, transform: `translateY(${(1 - p) * 18}px) scale(${0.9 + 0.1 * p})`, opacity: p }}>
		{keys.map((k, i) => (
			<div
				key={i}
				style={{
					minWidth: 84,
					height: 84,
					padding: "0 22px",
					borderRadius: 18,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					fontFamily,
					fontSize: k.length > 1 ? 32 : 42,
					fontWeight: 600,
					color: "white",
					background: "linear-gradient(180deg, rgba(60,56,80,0.96), rgba(32,30,44,0.96))",
					border: "1px solid rgba(255,255,255,0.18)",
					boxShadow: "0 4px 0 rgba(0,0,0,0.45), 0 14px 30px rgba(0,0,0,0.35)",
				}}
			>
				{k}
			</div>
		))}
	</div>
);

/** The captured Obsidian window, with a smooth camera and cursor/caret/keys overlays. */
const Footage: React.FC<{ hold?: boolean }> = () => {
	const t = useCurrentFrame();
	const { fps } = useVideoConfig();
	const i = shotAt(Math.min(t, FOOTAGE - 1));
	const shot = shots[i];
	const local = t - starts[i];
	const prev = i > 0 ? shots[i - 1] : null;

	// camera: spring between the scene cameras
	let j = i;
	while (j > 0 && sameCam(shots[j - 1].cam, shots[j].cam)) j--;
	const from = j > 0 ? shots[j - 1].cam : shots[0].cam;
	const to = shots[j].cam;
	const cp = j > 0 ? spring({ frame: t - starts[j], fps, config: { damping: 200 }, durationInFrames: 34 }) : 1;
	const cam = { s: lerp(from.s, to.s, cp), x: lerp(from.x, to.x, cp), y: lerp(from.y, to.y, cp) };
	const vw = SRC_W / cam.s;
	const vh = SRC_H / cam.s;
	const left = Math.max(0, Math.min(SRC_W - vw, cam.x - vw / 2));
	const top = Math.max(0, Math.min(SRC_H - vh, cam.y - vh / 2));

	// image: hard cuts, short cross-fade after clicks (page changes)
	const fadeIn = shot.click && prev ? interpolate(local, [0, 6], [0, 1], { extrapolateRight: "clamp" }) : 1;

	// cursor
	let cursor: Pt | null = shot.cursor;
	if (cursor && prev?.cursor && (prev.cursor.x !== cursor.x || prev.cursor.y !== cursor.y)) {
		const d = shot.move ? Math.min(14, shot.dur) : shot.dur;
		const p = ease(Math.min(1, local / d));
		cursor = { x: lerp(prev.cursor.x, cursor.x, p), y: lerp(prev.cursor.y, cursor.y, p) };
	}
	// like macOS: the pointer hides while you type, and comes back when the mouse moves
	let cursorOpacity = 1;
	{
		let m = i;
		while (m > 0 && !shots[m].move && !shots[m].click) m--;
		const isInput = (k: number) =>
			!!shots[k].keys ||
			(shots[k].dur <= 5 && !shots[k].move && !shots[k].click && JSON.stringify(shots[k].cursor) === JSON.stringify(shots[k - 1]?.cursor));
		for (let k = m + 1; k <= i; k++) {
			if (isInput(k)) {
				cursorOpacity = interpolate(t, [starts[k], starts[k] + 6], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
				break;
			}
		}
	}
	const pressed = shot.click ? interpolate(local, [0, 3, 8], [1, 1, 0], { extrapolateRight: "clamp" }) : 0;
	const ripple = shot.click ? local / 16 : 2;

	// caret: solid while typing, blinks when idle
	const caretOn = shot.caret && (local < 12 || Math.floor((local - 12) / 16) % 2 === 1);

	return (
		<div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
			<div
				style={{
					position: "absolute",
					width: SRC_W,
					height: SRC_H,
					transformOrigin: "0 0",
					transform: `scale(${K * cam.s}) translate(${-left}px, ${-top}px)`,
				}}
			>
				{prev && fadeIn < 1 && <Img src={staticFile(prev.src)} style={{ position: "absolute", width: SRC_W, height: SRC_H }} />}
				<Img src={staticFile(shot.src)} style={{ position: "absolute", width: SRC_W, height: SRC_H, opacity: fadeIn }} />
				{caretOn && shot.caret && (
					<div
						style={{
							position: "absolute",
							left: shot.caret.x - 0.5,
							top: shot.caret.y,
							width: 2,
							height: shot.caret.h,
							borderRadius: 1,
							background: ACCENT,
						}}
					/>
				)}
				{shot.click && shot.cursor && ripple < 1 && (
					<div
						style={{
							position: "absolute",
							left: shot.cursor.x - 22 * (0.4 + ripple),
							top: shot.cursor.y - 22 * (0.4 + ripple),
							width: 44 * (0.4 + ripple),
							height: 44 * (0.4 + ripple),
							borderRadius: "50%",
							border: `2.5px solid ${ACCENT2}`,
							opacity: 0.9 * (1 - ripple),
						}}
					/>
				)}
				{cursor && (
					<div
						style={{
							position: "absolute",
							left: cursor.x - 2,
							top: cursor.y - 2,
							opacity: cursorOpacity,
							transform: `scale(${1 / cam.s + 0.2})`,
							transformOrigin: "2px 2px",
						}}
					>
						<Cursor pressed={pressed} />
					</div>
				)}
			</div>
		</div>
	);
};

/** Keycaps + caption, positioned in video space (unaffected by the camera). */
const FootageChrome: React.FC = () => {
	const t = useCurrentFrame();
	const { fps } = useVideoConfig();
	const i = shotAt(Math.min(t, FOOTAGE - 1));

	// keys: most recent shot with keys, held at least ~0.9s
	let keys: string[] | null = null;
	let kp = 0;
	for (let k = i; k >= Math.max(0, i - 12); k--) {
		const s = shots[k];
		if (s.keys && t < starts[k] + Math.max(s.dur, 26)) {
			keys = s.keys;
			const end = starts[k] + Math.max(s.dur, 26);
			kp = Math.min(
				spring({ frame: t - starts[k], fps, config: { damping: 15, stiffness: 220 }, durationInFrames: 14 }),
				interpolate(t, [end - 6, end], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
			);
			break;
		}
	}

	// caption: springs in whenever it changes
	const caption = shots[i].caption;
	let c = i;
	while (c > 0 && shots[c - 1].caption === caption) c--;
	const cpIn = spring({ frame: t - starts[c], fps, config: { damping: 200 }, durationInFrames: 20 });
	const sceneEnd = (() => {
		let e = i;
		while (e < shots.length - 1 && shots[e + 1].caption === caption) e++;
		return starts[e] + shots[e].dur;
	})();
	const cpOut = interpolate(t, [sceneEnd - 6, sceneEnd], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

	return (
		<>
			{keys && (
				<div style={{ position: "absolute", left: 0, right: 0, top: WIN_Y + WIN_H - 128, display: "flex", justifyContent: "center" }}>
					<Keycaps keys={keys} p={kp} />
				</div>
			)}
			{caption && (
				<div
					style={{
						position: "absolute",
						left: 0,
						right: 0,
						top: WIN_Y + WIN_H + 28,
						textAlign: "center",
						fontFamily,
						fontSize: 44,
						fontWeight: 650,
						letterSpacing: -0.6,
						color: "white",
						opacity: Math.min(cpIn, cpOut),
						transform: `translateY(${(1 - cpIn) * 14}px)`,
					}}
				>
					{caption}
				</div>
			)}
		</>
	);
};

const WindowFrame: React.FC<{ children: React.ReactNode; enter: number; style?: React.CSSProperties }> = ({ children, enter, style }) => (
	<div
		style={{
			position: "absolute",
			left: WIN_X,
			top: WIN_Y,
			width: WIN_W,
			height: WIN_H,
			borderRadius: 18,
			overflow: "hidden",
			background: "#1e1e1e",
			boxShadow: "0 0 0 1px rgba(255,255,255,0.10), 0 40px 120px rgba(0,0,0,0.6), 0 0 160px rgba(139,108,255,0.12)",
			opacity: enter,
			transform: `translateY(${(1 - enter) * 60}px) scale(${0.97 + 0.03 * enter})`,
			...style,
		}}
	>
		{children}
	</div>
);

const FootageScene: React.FC = () => {
	const f = useCurrentFrame();
	const { fps } = useVideoConfig();
	const enter = spring({ frame: f, fps, config: { damping: 200 }, durationInFrames: 30 });
	return (
		<AbsoluteFill>
			<WindowFrame enter={enter}>
				<Footage />
			</WindowFrame>
			<FootageChrome />
		</AbsoluteFill>
	);
};

// ---------------------------------------------------------------- "it's just Markdown"

function mdLine(line: string, key: number) {
	const m = /^(\t*)- (\[[ xX]\] )?(.*)$/.exec(line);
	if (!m) return <div key={key} style={{ paddingLeft: 0 }}>{line}</div>;
	const depth = m[1].length;
	const parts: React.ReactNode[] = [];
	const re = /(\[\[[^\]]+\]\]|#[\w/-]+)/g;
	let last = 0;
	let mm: RegExpExecArray | null;
	while ((mm = re.exec(m[3]))) {
		if (mm.index > last) parts.push(m[3].slice(last, mm.index));
		const tok = mm[0];
		parts.push(
			<span key={mm.index} style={{ color: tok.startsWith("#") ? "#c9a7ff" : "#7cc4ff" }}>
				{tok}
			</span>,
		);
		last = mm.index + tok.length;
	}
	if (last < m[3].length) parts.push(m[3].slice(last));
	return (
		<div key={key} style={{ display: "flex", whiteSpace: "pre" }}>
			{Array.from({ length: depth }).map((_, d) => (
				<span key={d} style={{ width: 34, borderLeft: "1.5px solid rgba(255,255,255,0.10)", marginLeft: d === 0 ? 4 : 0 }} />
			))}
			<span style={{ color: ACCENT, marginLeft: depth ? 2 : 0 }}>-&nbsp;</span>
			{m[2] && <span style={{ color: "#5bd69a" }}>{m[2]}</span>}
			<span style={{ color: "rgba(255,255,255,0.88)" }}>{parts}</span>
		</div>
	);
}

const MarkdownScene: React.FC = () => {
	const f = useCurrentFrame();
	const { fps } = useVideoConfig();
	const p = spring({ frame: f, fps, config: { damping: 200 }, durationInFrames: 36 });
	const last = shots[shots.length - 1];
	const lines = (data.markdown as string).replace(/\n$/, "").split("\n");
	const shrink = lerp(1, 0.56, p);
	const capIn = spring({ frame: f - 14, fps, config: { damping: 200 }, durationInFrames: 22 });
	const out = interpolate(f, [MD - 10, MD], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
	return (
		<AbsoluteFill style={{ opacity: out }}>
			<WindowFrame
				enter={1}
				style={{
					transformOrigin: "0 0",
					transform: `translate(${lerp(0, 70 - WIN_X, p)}px, ${lerp(0, 150 - WIN_Y, p)}px) scale(${shrink})`,
				}}
			>
				<Img src={staticFile(last.src)} style={{ width: WIN_W, height: WIN_H }} />
			</WindowFrame>
			<div
				style={{
					position: "absolute",
					left: 1010,
					top: 96,
					width: 850,
					height: 840,
					borderRadius: 18,
					background: "rgba(18,17,26,0.92)",
					boxShadow: "0 0 0 1px rgba(255,255,255,0.10), 0 40px 120px rgba(0,0,0,0.55)",
					opacity: p,
					transform: `translateX(${(1 - p) * 80}px)`,
					overflow: "hidden",
				}}
			>
				<div
					style={{
						height: 52,
						display: "flex",
						alignItems: "center",
						padding: "0 22px",
						gap: 10,
						borderBottom: "1px solid rgba(255,255,255,0.08)",
						fontFamily: monoFamily,
						fontSize: 20,
						color: "rgba(255,255,255,0.55)",
					}}
				>
					{["#ff5f57", "#febc2e", "#28c840"].map((c) => (
						<span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c, opacity: 0.85 }} />
					))}
					<span style={{ marginLeft: 12 }}>Outline.md</span>
				</div>
				<div style={{ padding: "16px 26px", fontFamily: monoFamily, fontSize: 20, lineHeight: 1.55 }}>
					{lines.map((l, k) => {
						const lp = interpolate(f, [16 + k * 2.2, 26 + k * 2.2], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
						return (
							<div key={k} style={{ opacity: lp, transform: `translateX(${(1 - lp) * 12}px)` }}>
								{mdLine(l, k)}
							</div>
						);
					})}
				</div>
			</div>
			<div
				style={{
					position: "absolute",
					left: 70,
					width: 880,
					top: 150 + WIN_H * 0.56 + 56,
					fontFamily,
					color: "white",
					opacity: capIn,
					transform: `translateY(${(1 - capIn) * 14}px)`,
				}}
			>
				<div style={{ fontSize: 50, fontWeight: 750, letterSpacing: -1.2, lineHeight: 1.1 }}>It's just a Markdown list.</div>
				<div style={{ marginTop: 16, fontSize: 28, fontWeight: 450, color: "rgba(255,255,255,0.62)", lineHeight: 1.4 }}>
					Links, backlinks, search, sync and Git keep working. Open it as a normal note any time.
				</div>
			</div>
		</AbsoluteFill>
	);
};

// ---------------------------------------------------------------- composition

export const Demo: React.FC = () => (
	<AbsoluteFill style={{ backgroundColor: "#0a0a10" }}>
		<Background />
		<Sequence durationInFrames={INTRO}>
			<Intro />
		</Sequence>
		<Sequence from={FOOT_START} durationInFrames={FOOTAGE}>
			<FootageScene />
		</Sequence>
		<Sequence from={MD_START} durationInFrames={MD}>
			<MarkdownScene />
		</Sequence>
		<Sequence from={OUTRO_START} durationInFrames={OUTRO}>
			<Outro />
		</Sequence>
	</AbsoluteFill>
);
