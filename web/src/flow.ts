/**
 * Agentflow embed (viewer contract v1.1.0). Messages are accepted only from the viewer's origin,
 * and nothing is sent before flow:ready (anything sent earlier would be lost).
 *
 * The viewer is loaded lazily, on the first thing to show. A replay is sized first (see fit.ts)
 * so the viewer's document is created at its final width: resizing a cross-origin frame after it
 * has loaded is asynchronous and could race the replay message. The viewer lays a run out once,
 * at the size it has when the run arrives, so entering or leaving full screen reloads it at the
 * new size and sends the run again (a replay restarts).
 */
import { fitScale, requiredWidth, type FitNode } from './fit';

type Msg = Record<string, unknown>;
type Terminal = { status: 'ok' | 'failed'; summary: string };
type ReplayData = { duration: number; compression: number; realDurationS: number; nodes: unknown[] };

export interface FlowHandle {
  live(title: string, subtitle: string, nodes: unknown[]): void;
  replay(title: string, subtitle: string, replay: ReplayData | null, terminal: Terminal | null): void;
  /** A run watched live has finished: final snapshot plus flow:terminal (no replay). */
  finish(title: string, subtitle: string, nodes: unknown[], terminal: Terminal): void;
  destroy(): void;
}

export function mountFlow(iframe: HTMLIFrameElement, viewerUrl: string, note: (s: string) => void): FlowHandle {
  const origin = new URL(viewerUrl).origin;
  const wrap = iframe.parentElement;
  let loaded = false;
  let ready = false;
  let initDone = false;
  let pending: Msg[] = [];
  let lastInit = '';
  let terminalSent = false;
  let replayed = false;
  let fixedWidth = 0;
  // The latest thing shown, so a reload can show it again.
  let last: { kind: 'live' | 'finish'; title: string; subtitle: string; nodes: unknown[]; terminal?: Terminal } | { kind: 'replay'; title: string; subtitle: string; replay: ReplayData | null; terminal: Terminal | null } | null = null;

  const load = () => {
    if (loaded) return;
    loaded = true;
    iframe.src = viewerUrl;
  };
  const post = (m: Msg) => {
    load();
    if (!ready) {
      pending.push(m);
      return;
    }
    iframe.contentWindow?.postMessage(m, origin);
  };
  const onMessage = (ev: MessageEvent) => {
    if (ev.origin !== origin || ev.source !== iframe.contentWindow) return;
    const data = ev.data as Msg | null;
    if (data && data.type === 'flow:ready') {
      ready = true;
      const q = pending;
      pending = [];
      for (const m of q) iframe.contentWindow?.postMessage(m, origin);
    }
  };
  /** Keep a fixed-width (scaled) frame fitted to its panel as the window changes size. */
  const rescale = (): number => {
    if (!fixedWidth || !wrap) return 1;
    const s = Math.min(1, fitScale(fixedWidth, wrap.clientWidth));
    iframe.style.width = `${fixedWidth}px`;
    iframe.style.height = `${wrap.clientHeight / s}px`;
    iframe.style.transform = s < 1 ? `scale(${s})` : '';
    return s;
  };
  /** Size the frame for this replay before the viewer loads; returns the scale applied. */
  const fit = (nodes: FitNode[]): number => {
    if (loaded || !wrap) return 1;
    const required = requiredWidth(nodes);
    if (required <= wrap.clientWidth) return 1;
    fixedWidth = required;
    return rescale();
  };
  const init = (title: string, subtitle: string) => {
    const key = `${title}|${subtitle}`;
    if (initDone && key === lastInit) return;
    initDone = true;
    lastInit = key;
    post({ type: 'flow:init', title, subtitle });
  };

  const handle: FlowHandle = {
    live(title, subtitle, nodes) {
      last = { kind: 'live', title, subtitle, nodes };
      init(title, subtitle);
      post({ type: 'flow:sync', nodes });
      note('Live: the graph mirrors the run’s events as they happen.');
    },
    replay(title, subtitle, replay, terminal) {
      last = { kind: 'replay', title, subtitle, replay, terminal };
      const s = replay && !replayed ? fit(replay.nodes as FitNode[]) : 1;
      init(title, subtitle);
      if (replay && !replayed) {
        replayed = true;
        post({ type: 'flow:replay', duration: replay.duration, nodes: replay.nodes });
        const scaled = s < 1 ? ` Shown at ${Math.round(s * 100)}% so every label fits its column.` : '';
        note(
          (replay.compression > 1
            ? `Replay compressed ×${replay.compression} (real duration ${replay.realDurationS} s), built from recorded event timestamps.`
            : `Replay at real speed (${replay.realDurationS} s), built from recorded event timestamps.`) + scaled,
        );
      }
      if (terminal && !terminalSent) {
        terminalSent = true;
        post({ type: 'flow:terminal', status: terminal.status, summary: terminal.summary.slice(0, 300) });
      }
    },
    finish(title, subtitle, nodes, terminal) {
      last = { kind: 'finish', title, subtitle, nodes, terminal };
      init(title, subtitle);
      post({ type: 'flow:sync', nodes });
      if (!terminalSent) {
        terminalSent = true;
        post({ type: 'flow:terminal', status: terminal.status, summary: terminal.summary.slice(0, 300) });
      }
      note('Finished.');
    },
    destroy() {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('resize', rescale);
      document.removeEventListener('fullscreenchange', onFullscreen);
    },
  };

  /** Reload the viewer at the panel's current size and show the latest run again. */
  const reload = () => {
    loaded = ready = initDone = terminalSent = replayed = false;
    pending = [];
    lastInit = '';
    fixedWidth = 0;
    iframe.style.width = iframe.style.height = iframe.style.transform = '';
    const l = last;
    if (!l) return;
    if (l.kind === 'replay') handle.replay(l.title, l.subtitle, l.replay, l.terminal);
    else if (l.kind === 'finish') handle.finish(l.title, l.subtitle, l.nodes, l.terminal!);
    else handle.live(l.title, l.subtitle, l.nodes);
  };

  let fullscreen = false;
  const button = document.createElement('button');
  function onFullscreen() {
    const now = document.fullscreenElement === wrap;
    if (now === fullscreen) return;
    fullscreen = now;
    button.textContent = now ? 'Exit full screen' : 'Full screen';
    // Let the new size settle, then lay the run out again at that size.
    if (loaded) requestAnimationFrame(() => setTimeout(reload, 60));
  }
  if (wrap && document.fullscreenEnabled) {
    button.type = 'button';
    button.className = 'flow-fs';
    button.textContent = 'Full screen';
    button.title = 'Show the graph full screen. A replay restarts at the new size; Esc exits.';
    button.onclick = () => void (document.fullscreenElement ? document.exitFullscreen() : wrap.requestFullscreen()).catch(() => undefined);
    wrap.appendChild(button);
    document.addEventListener('fullscreenchange', onFullscreen);
  }
  window.addEventListener('message', onMessage);
  window.addEventListener('resize', rescale);
  return handle;
}
