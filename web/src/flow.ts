/**
 * Agentflow embed (viewer contract v1.1.0). Messages are accepted only from the viewer's origin,
 * and nothing is sent before flow:ready (anything sent earlier would be lost).
 *
 * The viewer is loaded lazily, on the first thing to show. A replay is sized first (see fit.ts)
 * so the viewer's document is created at its final width: resizing a cross-origin frame after it
 * has loaded is asynchronous and could race the replay message.
 */
import { fitScale, requiredWidth, type FitNode } from './fit';

type Msg = Record<string, unknown>;

export interface FlowHandle {
  live(title: string, subtitle: string, nodes: unknown[]): void;
  replay(title: string, subtitle: string, replay: { duration: number; compression: number; realDurationS: number; nodes: unknown[] } | null, terminal: { status: 'ok' | 'failed'; summary: string } | null): void;
  /** A run watched live has finished: final snapshot plus flow:terminal (no replay). */
  finish(title: string, subtitle: string, nodes: unknown[], terminal: { status: 'ok' | 'failed'; summary: string }): void;
  destroy(): void;
}

export function mountFlow(iframe: HTMLIFrameElement, viewerUrl: string, note: (s: string) => void): FlowHandle {
  const origin = new URL(viewerUrl).origin;
  let loaded = false;
  let ready = false;
  let initDone = false;
  let pending: Msg[] = [];
  let lastInit = '';
  let terminalSent = false;
  let replayed = false;
  let fixedWidth = 0;

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
    const wrap = iframe.parentElement;
    if (!fixedWidth || !wrap) return 1;
    const s = Math.min(1, fitScale(fixedWidth, wrap.clientWidth));
    iframe.style.width = `${fixedWidth}px`;
    iframe.style.height = `${wrap.clientHeight / s}px`;
    iframe.style.transform = s < 1 ? `scale(${s})` : '';
    return s;
  };
  /** Size the frame for this replay before the viewer loads; returns the scale applied. */
  const fit = (nodes: FitNode[]): number => {
    const wrap = iframe.parentElement;
    if (loaded || !wrap) return 1;
    const required = requiredWidth(nodes);
    if (required <= wrap.clientWidth) return 1;
    fixedWidth = required;
    return rescale();
  };
  window.addEventListener('message', onMessage);
  window.addEventListener('resize', rescale);
  const init = (title: string, subtitle: string) => {
    const key = `${title}|${subtitle}`;
    if (initDone && key === lastInit) return;
    initDone = true;
    lastInit = key;
    post({ type: 'flow:init', title, subtitle });
  };
  return {
    live(title, subtitle, nodes) {
      init(title, subtitle);
      post({ type: 'flow:sync', nodes });
      note('Live: the graph mirrors the run’s events as they happen.');
    },
    replay(title, subtitle, replay, terminal) {
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
    },
  };
}
