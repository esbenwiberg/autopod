import { describe, expect, it } from 'vitest';
import { HAPROXY_LISTEN_PORT, HAPROXY_LOG_PORT, generateHaproxyConfig } from './haproxy-config.js';

describe('generateHaproxyConfig', () => {
  it('emits an -m str ACL for exact hosts', () => {
    const cfg = generateHaproxyConfig({ allowedHosts: ['api.anthropic.com'] });
    expect(cfg).toContain('acl allowed_sni var(sess.sni) -m str api.anthropic.com');
  });

  it('emits an -m end ACL for wildcard hosts, stripping only the leading *', () => {
    const cfg = generateHaproxyConfig({ allowedHosts: ['*.blob.core.windows.net'] });
    expect(cfg).toContain('acl allowed_sni var(sess.sni) -m end .blob.core.windows.net');
    expect(cfg).not.toContain('*.blob.core.windows.net');
  });

  it('produces the same output for the same input (deterministic)', () => {
    const input = {
      allowedHosts: ['api.anthropic.com', 'pypi.org', '*.blob.core.windows.net'],
    };
    expect(generateHaproxyConfig(input)).toBe(generateHaproxyConfig(input));
  });

  it('sorts hosts so reordering the input does not change the output', () => {
    const a = generateHaproxyConfig({
      allowedHosts: ['pypi.org', 'api.anthropic.com', '*.blob.core.windows.net'],
    });
    const b = generateHaproxyConfig({
      allowedHosts: ['*.blob.core.windows.net', 'api.anthropic.com', 'pypi.org'],
    });
    expect(a).toBe(b);
  });

  it('orders exact ACLs before wildcard ACLs', () => {
    const cfg = generateHaproxyConfig({
      allowedHosts: ['*.foo.com', 'bar.com'],
    });
    const exactIdx = cfg.indexOf('-m str bar.com');
    const wildcardIdx = cfg.indexOf('-m end .foo.com');
    expect(exactIdx).toBeGreaterThan(-1);
    expect(wildcardIdx).toBeGreaterThan(-1);
    expect(exactIdx).toBeLessThan(wildcardIdx);
  });

  it('captures SNI into a session variable before any ACL reference', () => {
    const cfg = generateHaproxyConfig({ allowedHosts: ['api.anthropic.com'] });
    const setVarIdx = cfg.indexOf('set-var(sess.sni) req.ssl_sni,lower');
    const aclIdx = cfg.indexOf('acl allowed_sni');
    expect(setVarIdx).toBeGreaterThan(-1);
    expect(aclIdx).toBeGreaterThan(setVarIdx);
  });

  it('rejects sessions without a TLS ClientHello (req.ssl_hello_type 1)', () => {
    const cfg = generateHaproxyConfig({ allowedHosts: [] });
    expect(cfg).toContain('tcp-request content reject if !{ req.ssl_hello_type 1 }');
  });

  it('guards against do-resolve returning 0.0.0.0', () => {
    const cfg = generateHaproxyConfig({ allowedHosts: ['api.anthropic.com'] });
    expect(cfg).toContain('tcp-request content reject if { var(sess.dst_ip) -m ip 0.0.0.0 }');
  });

  it('logs sni / src / action in a parseable format', () => {
    const cfg = generateHaproxyConfig({ allowedHosts: ['api.anthropic.com'] });
    expect(cfg).toContain('log-format "sni=%[var(sess.sni)] src=%ci action=%[var(sess.action)]"');
  });

  it('binds the frontend to loopback only', () => {
    const cfg = generateHaproxyConfig({ allowedHosts: [] });
    expect(cfg).toContain(`bind 127.0.0.1:${HAPROXY_LISTEN_PORT}`);
  });

  it('points the log destination at the loopback syslog port', () => {
    const cfg = generateHaproxyConfig({ allowedHosts: [] });
    expect(cfg).toContain(`log 127.0.0.1:${HAPROXY_LOG_PORT} local0`);
  });

  it('drops privileges to the haproxy user so the uid-owner firewall rule matches', () => {
    const cfg = generateHaproxyConfig({ allowedHosts: ['api.anthropic.com'] });
    expect(cfg).toContain('user haproxy');
    expect(cfg).toContain('group haproxy');
  });

  it('produces a config even with an empty allowlist (rejects everything)', () => {
    const cfg = generateHaproxyConfig({ allowedHosts: [] });
    expect(cfg).toContain('frontend tls-in');
    expect(cfg).toContain('backend tls-passthrough');
    expect(cfg).not.toContain('acl allowed_sni');
  });
});
