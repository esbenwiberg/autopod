/** Environment for daemon-owned HTTPS Git effects. Never pass the daemon's account environment. */
export function authenticatedGitEnvironment(
  remote: string,
  authorization: string,
): NodeJS.ProcessEnv {
  const url = new URL(remote);
  if (url.protocol !== 'https:' || url.username || url.password || /[\r\n]/.test(authorization))
    throw new Error('Authenticated Git requires a credential-free HTTPS remote');
  const settings = [
    ['credential.helper', ''],
    ['core.askPass', ''],
    ['core.hooksPath', '/dev/null'],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
    ['http.followRedirects', 'false'],
    [`http.${url.origin}/.extraheader`, `Authorization: ${authorization}`],
  ];
  return {
    PATH: `/usr/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ''}`,
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/true',
    SSH_ASKPASS: '/usr/bin/true',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_COUNT: String(settings.length),
    ...Object.fromEntries(
      settings.flatMap(([key, value], i) => [
        [`GIT_CONFIG_KEY_${i}`, key],
        [`GIT_CONFIG_VALUE_${i}`, value],
      ]),
    ),
  };
}
