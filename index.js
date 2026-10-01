import { registerRootComponent } from 'expo';
import React from 'react';
import { View, Text } from 'react-native';

// best-effort, non-blocking breadcrumb; must never throw and must never be awaited
try {
  fetch('https://juxddhghhkvtmxcwvlpa.supabase.co/rest/v1/app_diagnostics', {
    method: 'POST',
    headers: { apikey: 'sb_publishable_NCqAhtw2065wPcBNOTqcBg_v1nKdufW', Authorization: 'Bearer sb_publishable_NCqAhtw2065wPcBNOTqcBg_v1nKdufW', 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify([{ message: '[probe23] js-entry', stack: 'probe', app_version: '1.0.0', build_number: '23', ts: new Date().toISOString() }]),
  });
} catch (e) {}

function App() {
  return React.createElement(View, { style: { flex: 1, alignItems: 'center', justifyContent: 'center' } },
    React.createElement(Text, null, 'BOOT OK'));
}
registerRootComponent(App);
