import { useSyncExternalStore } from "react";
import { eventBus } from "../lib/eventBus";

export function useConnectionStatus() {
  return useSyncExternalStore(
    eventBus.onConnection,
    () => eventBus.connected
  );
}
