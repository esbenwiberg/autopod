import type { Profile, Session } from '@autopod/shared';
import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import type { AutopodClient } from '../../api/client.js';
import { InlineInput } from './InlineInput.js';
import { ListPicker } from './ListPicker.js';

type WizardStep =
  | { step: 'loading_profiles' }
  | { step: 'pick_profile'; profiles: Profile[] }
  | { step: 'enter_task'; profile: Profile }
  | { step: 'creating'; profile: Profile; task: string }
  | { step: 'error'; message: string };

interface CreateSessionWizardProps {
  client: AutopodClient;
  onComplete: (session: Session) => void;
  onCancel: () => void;
}

export function CreateSessionWizard({
  client,
  onComplete,
  onCancel,
}: CreateSessionWizardProps): React.ReactElement {
  const [wizardState, setWizardState] = useState<WizardStep>({ step: 'loading_profiles' });

  useEffect(() => {
    if (wizardState.step !== 'loading_profiles') return;
    let cancelled = false;
    void client.listProfiles().then(
      (profiles) => {
        if (cancelled) return;
        if (profiles.length === 0) {
          setWizardState({
            step: 'error',
            message: 'No profiles configured. Use `ap profile create` first.',
          });
        } else {
          setWizardState({ step: 'pick_profile', profiles });
        }
      },
      (err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load profiles';
        setWizardState({ step: 'error', message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, wizardState.step]);

  if (wizardState.step === 'loading_profiles') {
    return (
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold color="cyan">
          New Session
        </Text>
        <Text dimColor>Loading profiles...</Text>
      </Box>
    );
  }

  if (wizardState.step === 'pick_profile') {
    return (
      <ListPicker<Profile>
        title="New Session — Select Profile"
        items={wizardState.profiles}
        renderItem={(profile, selected) => (
          <Text color={selected ? 'cyan' : undefined}>
            {profile.name} — {profile.template} — {profile.defaultModel}
          </Text>
        )}
        onSelect={(profile) => setWizardState({ step: 'enter_task', profile })}
        onCancel={onCancel}
      />
    );
  }

  if (wizardState.step === 'enter_task') {
    return (
      <InlineInput
        prompt={`Task for "${wizardState.profile.name}":`}
        onSubmit={(task) => {
          const { profile } = wizardState;
          setWizardState({ step: 'creating', profile, task });
          void client.createSession({ profileName: profile.name, task }).then(
            (session) => onComplete(session),
            (err: unknown) => {
              const message = err instanceof Error ? err.message : 'Failed to create session';
              setWizardState({ step: 'error', message });
            },
          );
        }}
        onCancel={onCancel}
      />
    );
  }

  if (wizardState.step === 'creating') {
    return (
      <WizardMessage
        color="cyan"
        title="Creating session..."
        lines={[`Profile: ${wizardState.profile.name}`, `Task: ${wizardState.task}`]}
      />
    );
  }

  // Error state
  return (
    <WizardMessage
      color="red"
      title="Error"
      lines={[wizardState.message, 'Esc to dismiss']}
      onEsc={onCancel}
    />
  );
}

function WizardMessage({
  color,
  title,
  lines,
  onEsc,
}: {
  color: string;
  title: string;
  lines: string[];
  onEsc?: () => void;
}): React.ReactElement {
  useInput(
    (_input, key) => {
      if (key.escape && onEsc) onEsc();
    },
    { isActive: !!onEsc },
  );

  return (
    <Box borderStyle="round" borderColor={color} paddingX={1} flexDirection="column">
      <Text bold color={color}>
        {title}
      </Text>
      {lines.map((line, i) => (
        <Text key={i} dimColor>
          {line}
        </Text>
      ))}
    </Box>
  );
}
