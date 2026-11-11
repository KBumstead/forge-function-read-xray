import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Button,
  ButtonGroup,
  HelperMessage,
  Label,
  Lozenge,
  RequiredAsterisk,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Text,
  Textfield,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const SOURCE_LABELS = {
  settings: { text: 'Using credentials saved on this page', appearance: 'success' },
  variables: { text: 'Using Forge variables', appearance: 'inprogress' },
  none: { text: 'Not configured', appearance: 'removed' },
};

const App = () => {
  const [settings, setSettings] = useState(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);

  const apply = (s) => {
    setSettings(s);
    setClientId(s.clientId);
    setBaseUrl(s.baseUrl);
    setClientSecret('');
  };

  useEffect(() => {
    invoke('getSettings').then((res) => {
      if (res.ok) apply(res.settings);
      else setMessage({ appearance: 'error', title: 'Could not load settings', text: res.error });
      if (!res.ok) setSettings({ denied: true });
    });
  }, []);

  const run = async (action, fn, payload) => {
    setBusy(action);
    setMessage(null);
    try {
      const res = await invoke(fn, payload);
      if (!res.ok) {
        setMessage({ appearance: 'error', title: 'Something went wrong', text: res.error });
      } else {
        if (res.settings) apply(res.settings);
        const done = {
          save: 'Settings saved. The Rovo tool and web trigger use them right away.',
          clear: 'Saved settings removed. The app falls back to Forge variables.',
          test: res.message,
        };
        setMessage({ appearance: 'success', title: 'Done', text: done[action] });
      }
    } catch (err) {
      setMessage({ appearance: 'error', title: 'Something went wrong', text: String(err) });
    } finally {
      setBusy(null);
    }
  };

  if (!settings) return <Spinner label="Loading settings" />;

  if (settings.denied) {
    return (
      <SectionMessage appearance="error" title={message ? message.title : 'Not allowed'}>
        <Text>{message ? message.text : 'Only Jira administrators can manage these settings.'}</Text>
      </SectionMessage>
    );
  }

  const source = SOURCE_LABELS[settings.source] || SOURCE_LABELS.none;
  const regionOptions = settings.regions;
  const selectedRegion = regionOptions.find((r) => r.value === baseUrl) || regionOptions[0];

  return (
    <Stack space="space.200">
      <Text>
        Enter the Xray API key created on this Jira site (Apps → Xray → Settings → API Keys). The
        Rovo tool and the web trigger use it to read Xray data.
      </Text>
      <Lozenge appearance={source.appearance}>{source.text}</Lozenge>

      {message && (
        <SectionMessage appearance={message.appearance} title={message.title}>
          <Text>{message.text}</Text>
        </SectionMessage>
      )}

      <Stack space="space.050">
        <Label labelFor="clientId">
          Client ID
          <RequiredAsterisk />
        </Label>
        <Textfield
          id="clientId"
          name="clientId"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
      </Stack>

      <Stack space="space.050">
        <Label labelFor="clientSecret">
          Client Secret
          <RequiredAsterisk />
        </Label>
        <Textfield
          id="clientSecret"
          name="clientSecret"
          type="password"
          value={clientSecret}
          placeholder={settings.hasSecret ? '•••••••• (saved, leave blank to keep)' : ''}
          onChange={(e) => setClientSecret(e.target.value)}
        />
        <HelperMessage>
          Stored encrypted. It is never shown again after saving.
        </HelperMessage>
      </Stack>

      <Stack space="space.050">
        <Label labelFor="region">Xray region</Label>
        <Select
          inputId="region"
          options={regionOptions}
          value={selectedRegion}
          onChange={(option) => setBaseUrl(option.value)}
        />
        <HelperMessage>Use Global unless your Xray data is in a regional data center.</HelperMessage>
      </Stack>

      <ButtonGroup>
        <Button
          appearance="primary"
          isDisabled={Boolean(busy)}
          onClick={() => run('save', 'saveSettings', { clientId, clientSecret, baseUrl })}
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </Button>
        <Button
          isDisabled={Boolean(busy)}
          onClick={() => run('test', 'testConnection', { clientId, clientSecret, baseUrl })}
        >
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </Button>
        {settings.source === 'settings' && (
          <Button
            appearance="subtle"
            isDisabled={Boolean(busy)}
            onClick={() => run('clear', 'clearSettings')}
          >
            {busy === 'clear' ? 'Removing…' : 'Remove saved settings'}
          </Button>
        )}
      </ButtonGroup>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
