import type { Profile, StackTemplate } from '@autopod/shared';

export interface DockerfileOptions {
  profile: Profile;
  gitCredentials: 'pat' | 'ssh' | 'none';
}

const BASE_IMAGE_MAP: Record<StackTemplate, string> = {
  node22: 'autopod-node22:latest',
  'node22-pw': 'autopod-node22-pw:latest',
  dotnet9: 'autopod-dotnet9:latest',
  dotnet10: 'autopod-dotnet10:latest',
  python312: 'autopod-python312:latest',
  custom: 'autopod-node22:latest',
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

  // Install agent CLIs so they're ready at container start (zero cold-start)
  lines.push(
    '',
    '# Install agent CLIs into the image',
    'RUN npm install -g @anthropic-ai/claude-code @openai/codex @github/copilot 2>/dev/null || true',
  );

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
  const cmd = profile.buildCommand;
  const isDotnet = profile.template === 'dotnet9' || profile.template === 'dotnet10';

  if (isDotnet) {
    // Mixed dotnet+npm: run both restores if the build command also invokes npm/pnpm/yarn
    if (cmd.includes('pnpm')) {
      return 'dotnet restore && corepack enable pnpm && pnpm install --frozen-lockfile';
    }
    if (cmd.includes('yarn')) {
      return 'dotnet restore && corepack enable yarn && yarn install --frozen-lockfile';
    }
    if (cmd.includes('npm')) {
      return 'dotnet restore && npm ci';
    }
    return 'dotnet restore';
  }
  if (cmd.includes('pnpm')) {
    return 'corepack enable pnpm && pnpm install --frozen-lockfile';
  }
  if (cmd.includes('yarn')) {
    return 'corepack enable yarn && yarn install --frozen-lockfile';
  }
  if (cmd.includes('pip')) {
    return 'pip install -r requirements.txt';
  }
  return 'npm ci';
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '');
}
