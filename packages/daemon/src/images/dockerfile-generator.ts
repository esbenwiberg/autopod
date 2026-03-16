import type { Profile, StackTemplate } from '@autopod/shared';

export interface DockerfileOptions {
  profile: Profile;
  gitCredentials: 'pat' | 'ssh' | 'none';
}

const BASE_IMAGE_MAP: Record<StackTemplate, string> = {
  'node22': 'autopod-node22:latest',
  'node22-pw': 'autopod-node22-pw:latest',
  'dotnet9': 'autopod-dotnet9:latest',
  'python312': 'autopod-python312:latest',
  'custom': 'autopod-node22:latest',
};

export function generateDockerfile(options: DockerfileOptions): string {
  const { profile } = options;
  const baseImage = getBaseImage(profile.template);
  const installCommand = getInstallCommand(profile);

  const lines: string[] = [
    `FROM ${baseImage}`,
    '',
    '# Clone repo and install dependencies',
    'WORKDIR /workspace',
  ];

  // Git credentials for private repos
  if (options.gitCredentials === 'pat') {
    lines.push(
      'ARG GIT_PAT',
      `RUN git clone --depth 1 https://x-access-token:\${GIT_PAT}@${stripProtocol(profile.repoUrl)} .`,
    );
  } else {
    lines.push(`RUN git clone --depth 1 ${profile.repoUrl} .`);
  }

  // Install dependencies
  lines.push('', '# Install dependencies', `RUN ${installCommand}`);

  // Pre-warm build caches
  lines.push(
    '',
    '# Pre-warm: run build to populate caches',
    '# || true because build may fail without code changes — we just want cached deps',
    `RUN ${profile.buildCommand} || true`,
  );

  // Clean up git credentials
  if (options.gitCredentials === 'pat') {
    lines.push(
      '',
      '# Remove git credentials from image',
      'RUN git remote set-url origin https://github.com/placeholder/repo.git',
    );
  }

  // Set non-root user
  lines.push('', 'USER autopod');

  return lines.join('\n');
}

export function getBaseImage(template: StackTemplate): string {
  return BASE_IMAGE_MAP[template];
}

export function getInstallCommand(profile: Profile): string {
  if (profile.buildCommand.includes('pnpm')) {
    return 'corepack enable pnpm && pnpm install --frozen-lockfile';
  }
  if (profile.buildCommand.includes('yarn')) {
    return 'corepack enable yarn && yarn install --frozen-lockfile';
  }
  if (profile.buildCommand.includes('dotnet')) {
    return 'dotnet restore';
  }
  if (profile.buildCommand.includes('pip')) {
    return 'pip install -r requirements.txt';
  }
  return 'npm ci';
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '');
}
