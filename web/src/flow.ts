/**
 * Agentflow embed (viewer contract v1.1.0). Messages are accepted only from the viewer's origin,
 * and nothing is sent before flow:ready (anything sent earlier would be lost).
 */
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
  let ready = false;
  let initDone = false;
  let pending: Msg[] = [];
  let lastInit = '';
  let terminalSent = false;
  let replayed = false;
  iframe.src = viewerUrl;
  const post = (m: Msg) => {
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
  window.addEventListener('message', onMessage);
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
      init(title, subtitle);
      if (replay && !replayed) {
        replayed = true;
        post({ type: 'flow:replay', duration: replay.duration, nodes: replay.nodes });
        note(
          replay.compression > 1
            ? `Replay compressed ×${replay.compression} (real duration ${replay.realDurationS} s), built from recorded event timestamps.`
            : `Replay at real speed (${replay.realDurationS} s), built from recorded event timestamps.`,
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
    },
  };
}
