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
  | { step: 'enter_ac'; profile: Profile; task: string; criteria: string[] }
  | { step: 'creating'; profile: Profile; task: string; criteria: string[] }
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
          setWizardState({ step: 'enter_ac', profile: wizardState.profile, task, criteria: [] });
        }}
        onCancel={onCancel}
      />
    );
  }

  if (wizardState.step === 'enter_ac') {
    const { profile, task, criteria } = wizardState;
    return (
      <AcInput
        criteria={criteria}
        onAdd={(criterion) =>
          setWizardState({ step: 'enter_ac', profile, task, criteria: [...criteria, criterion] })
        }
        onDone={(finalCriteria) => {
          setWizardState({ step: 'creating', profile, task, criteria: finalCriteria });
          void client
            .createSession({
              profileName: profile.name,
              task,
              ...(finalCriteria.length > 0 ? { acceptanceCriteria: finalCriteria } : {}),
            })
            .then(
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
    const { profile, task, criteria } = wizardState;
    return (
      <WizardMessage
        color="cyan"
        title="Creating session..."
        lines={[
          `Profile: ${profile.name}`,
          `Task: ${task}`,
          ...(criteria.length > 0 ? [`AC: ${criteria.length} criteria`] : []),
        ]}
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

function AcInput({
  criteria,
  onAdd,
  onDone,
  onCancel,
}: {
  criteria: string[];
  onAdd: (criterion: string) => void;
  onDone: (criteria: string[]) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        onDone(criteria);
      } else {
        onAdd(trimmed);
        setValue('');
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input) setValue((prev) => prev + input);
  });

  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text bold color="yellow">
        Acceptance Criteria (optional)
      </Text>
      {criteria.map((c, i) => (
        <Text key={i} color="green">
          {'  ✓ '}
          {c}
        </Text>
      ))}
      <Box>
        <Text color="green">&gt; </Text>
        <Text>{value}</Text>
        <Text color="gray">_</Text>
      </Box>
      <Text dimColor>Enter to add criterion · empty Enter to finish · Esc to cancel</Text>
    </Box>
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
