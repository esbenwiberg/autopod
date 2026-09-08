import { describe, expect, it } from 'vitest';
import { type SessionBridgeDependencies, createSessionBridge } from '../pods/pod-bridge-impl.js';

describe('browser validation consumer of the shared address classifier', () => {
  // This pure gate must not read pod state or perform any infrastructure I/O.
  // Missing ports make any accidental new dependency fail visibly.
  const bridge = createSessionBridge({} as SessionBridgeDependencies);

  it.each(['http://localhost:3000/', 'http://127.0.0.1:3000/', 'http://127.2.3.4/'])(
    'preserves the existing loopback allowlist: %s',
    (url) => expect(() => bridge.validateBrowserUrl('fixture', url)).not.toThrow(),
  );

  it.each([
    'https://public.example/',
    'http://169.254.169.254/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[::1]/',
    'file:///tmp/fixture',
  ])('retains the existing deny boundary: %s', (url) => {
    expect(() => bridge.validateBrowserUrl('fixture', url)).toThrow();
  });
});
