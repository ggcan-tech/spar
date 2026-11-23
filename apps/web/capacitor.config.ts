import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Local development identity; choose an owned identifier before device distribution.
  appId: 'com.spar.local',
  appName: 'SPAR',
  webDir: 'dist',
  backgroundColor: '#0e0f13',
  ios: {
    contentInset: 'never',
    preferredContentMode: 'mobile',
  },
};

export default config;
