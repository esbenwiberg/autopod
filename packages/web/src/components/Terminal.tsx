import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type React from 'react';
import { useEffect, useRef } from 'react';

interface TerminalProps {
  wsUrl: string;
}

export function Terminal({ wsUrl }: TerminalProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      theme: {
        background: '#0f172a',
        foreground: '#f1f5f9',
        cursor: '#6366f1',
        selectionBackground: '#6366f133',
        black: '#1e293b',
        brightBlack: '#475569',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      allowTransparency: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fitAddon.fit();

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      // Send initial size
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data) as { type: string; code?: number; message?: string };
          if (msg.type === 'ready') {
            term.writeln('\x1b[90m--- Terminal ready ---\x1b[0m');
          } else if (msg.type === 'exit') {
            term.writeln(`\r\n\x1b[90m--- Session exited (code ${msg.code ?? 0}) ---\x1b[0m`);
          } else if (msg.type === 'error') {
            term.writeln(`\r\n\x1b[31m--- Error: ${msg.message} ---\x1b[0m`);
          }
        } catch {
          term.write(ev.data);
        }
      } else {
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      }
    };

    ws.onclose = () => {
      term.writeln('\r\n\x1b[90m--- Connection closed ---\x1b[0m');
    };

    // Forward keystrokes to container stdin
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      ws.close(1000, 'unmount');
      term.dispose();
    };
  }, [wsUrl]);

  return (
    <div
      ref={containerRef}
      className="xterm-container"
      style={{ height: '100%', width: '100%', padding: 4 }}
    />
  );
}
