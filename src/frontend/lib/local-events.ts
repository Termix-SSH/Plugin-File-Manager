// One socket to this plugin's /local-events route on the embedded backend. It
// carries transfer progress and external editor saves. It opens when the first
// listener subscribes and closes with the last one.

import { fileManagerApp } from "../api/client";

export interface LocalEvent {
  type: string;
  [key: string]: unknown;
}

type Listener = (event: LocalEvent) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let opening = false;

async function open(): Promise<void> {
  if (socket || opening) return;
  opening = true;
  try {
    const target = await fileManagerApp().wsUrl("/local-events", {
      origin: "local",
    });
    if (!target || listeners.size === 0) return;
    const next = new WebSocket(target.url, target.protocols);
    socket = next;
    next.onmessage = (message) => {
      let event: LocalEvent;
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      for (const listener of [...listeners]) listener(event);
    };
    next.onclose = () => {
      if (socket === next) socket = null;
      // Reconnect while somebody is still listening.
      if (listeners.size > 0) setTimeout(() => void open(), 1000);
    };
  } finally {
    opening = false;
  }
}

export function subscribeLocalEvents(listener: Listener): () => void {
  listeners.add(listener);
  void open();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && socket) {
      const current = socket;
      socket = null;
      current.close();
    }
  };
}
