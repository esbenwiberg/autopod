import { useInput } from 'ink';

/**
 * Keyboard shortcut dispatcher using Ink's useInput.
 * Disabled when overlays are active.
 *
 * Key mapping:
 *   Arrow up / k  = up
 *   Arrow down / j = down
 *   t = tell, d = diff, a = approve, r = reject
 *   o = open, l = logs, x = kill, v = validate, q = quit
 */
export function useKeyboard(handlers: Record<string, () => void>, enabled: boolean): void {
  useInput(
    (input, key) => {
      if (!enabled) return;

      if (key.upArrow || input === 'k') {
        handlers.up?.();
      } else if (key.downArrow || input === 'j') {
        handlers.down?.();
      } else if (key.return) {
        handlers.enter?.();
      } else if (key.escape) {
        handlers.escape?.();
      } else {
        const handler = handlers[input];
        if (handler) handler();
      }
    },
    { isActive: enabled },
  );
}
